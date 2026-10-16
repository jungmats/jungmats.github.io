import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DefinitionError, lintDefinition } from "../src/engine/definitions.ts";
import { toolsFor } from "../src/mcp/tools.ts";
import { storesContact } from "../src/rules.ts";
import type { JourneyDefinition } from "../src/engine/types.ts";

const load = (path: string): JourneyDefinition =>
  lintDefinition(JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")));

const SITE = load("../definitions/site-visit.json");
const PRICE = load("../definitions/price-estimate.json");
const LEAD = load("./fixtures/lead-qualification.json");

test("each journey gets a start tool, one tool per step, a cancel tool; plus get_journey", () => {
  const { tools } = toolsFor([SITE, PRICE]);
  assert.deepEqual(tools.map((t) => t.name), [
    "get_journey",
    "start_site_visit", "site_visit_report", "cancel_site_visit",
    "start_price_estimate", "price_estimate_estimate", "price_estimate_close", "cancel_price_estimate",
  ]);
});

test("a new definition brings its tools, steps in dependency order", () => {
  const lead = { ...LEAD, identity: "optional" as const };
  const { tools, routes } = toolsFor([lead]);
  assert.deepEqual(tools.map((t) => t.name), [
    "get_journey", "start_lead_qualification",
    "lead_qualification_discover", "lead_qualification_qualify", "lead_qualification_verify", "lead_qualification_transact",
    "cancel_lead_qualification",
  ]);
  assert.deepEqual(routes.get("lead_qualification_verify"), { op: "step", definition: "lead-qualification", step: "verify" });
});

test("definitions that require signed identity get no tools", () => {
  const { tools } = toolsFor([{ ...LEAD, identity: "required" }]);
  assert.deepEqual(tools.map((t) => t.name), ["get_journey"]);
});

test("start tool takes the intent envelope; step tools take journey_id plus the step's fields", () => {
  const { tools } = toolsFor([PRICE]);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const start = byName.get("start_price_estimate")!;
  assert.deepEqual(start.inputSchema.required, ["intent", "goal", "human_present"]);
  assert.deepEqual(start.inputSchema.properties!.intent.enum, PRICE.intent.allowed);
  assert.ok(!("request_summary" in start.inputSchema.properties!), "fields agents aren't asked for stay out");
  assert.ok(!("parent_journey" in start.inputSchema.properties!));

  const close = byName.get("price_estimate_close")!;
  assert.deepEqual(close.inputSchema.required, ["journey_id", "email"]);
  assert.ok(close.description.includes("price_estimate_estimate"), "says which tool must come first");

  const cancel = byName.get("cancel_price_estimate")!;
  assert.deepEqual(cancel.inputSchema.required, ["journey_id", "reason"]);
  assert.ok("preferred_option" in cancel.inputSchema.properties!, "journey's own cancel fields");

  const text = JSON.stringify(tools);
  assert.ok(!text.includes('"sensitive"') && !text.includes('"log"'), "journey-only schema flags must not leak");
});

test("only steps with sensitive fields get the strict rate limit", () => {
  assert.equal(storesContact(PRICE, "close"), true);
  assert.equal(storesContact(PRICE, "estimate"), false);
  assert.equal(storesContact(SITE, "report"), false);
});

test("tool name rules fail at load: journey_id field, duplicate names, invalid names", () => {
  const bad = structuredClone(SITE);
  bad.steps.report.fields.properties.journey_id = { type: "string" };
  assert.throws(() => toolsFor([bad]), DefinitionError);

  // "a-b" step "c" and "a" step "b-c" would both be a_b_c.
  const one = { ...structuredClone(SITE), id: "a-b", steps: { c: SITE.steps.report } };
  const two = { ...structuredClone(SITE), id: "a", steps: { "b-c": SITE.steps.report } };
  assert.throws(() => toolsFor([one, two]), /used twice/);

  const long = { ...structuredClone(SITE), id: "x".repeat(70) };
  assert.throws(() => toolsFor([long]), /invalid/);
});
