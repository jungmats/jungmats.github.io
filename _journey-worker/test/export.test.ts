import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

import { lintDefinition } from "../src/engine/definitions.ts";
import { arazzoFor, openApiFor } from "../src/engine/export.ts";
import { reconstructPrompt } from "../src/engine/prompt.ts";
import type { JourneyDefinition } from "../src/engine/types.ts";

const LEAD: JourneyDefinition = lintDefinition(
  JSON.parse(readFileSync(new URL("./fixtures/lead-qualification.json", import.meta.url), "utf8")),
);

test("OpenAPI has one operation per step, and no journey-only schema extensions", () => {
  const doc = openApiFor(LEAD, "https://journey.example");
  const ops = Object.values(doc.paths).flatMap((p) => Object.values(p as object).map((o) => (o as { operationId: string }).operationId));
  assert.deepEqual(ops.sort(), [
    "cancelJourney", "getJourney", "requestVerificationCode", "startJourney",
    "step_discover", "step_qualify", "step_transact", "step_verify",
  ]);
  const text = JSON.stringify(doc);
  assert.ok(!text.includes('"log"'), "log flag must not leak");
  assert.ok(!text.includes('"sensitive"'), "sensitive flag must not leak");
});

test("Arazzo steps follow dependency order and reference real operations", () => {
  const openapi = openApiFor(LEAD, "https://journey.example");
  const ops = new Set(Object.values(openapi.paths).flatMap((p) => Object.values(p as object).map((o) => (o as { operationId: string }).operationId)));
  const doc = arazzoFor(LEAD, "https://journey.example/journeys/lead-qualification/openapi.json");
  const steps = doc.workflows[0].steps;
  assert.deepEqual(steps.map((s) => s.stepId), ["start", "discover", "qualify", "verify_request_code", "verify", "transact"]);
  for (const s of steps) assert.ok(ops.has(s.operationId as string), `unknown operation ${s.operationId}`);

  // Written out for an external linter (Spectral's arazzo ruleset), see README.
  const dir = new URL("../.out/", import.meta.url);
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("arazzo.json", dir), JSON.stringify(doc, null, 2));
  writeFileSync(new URL("openapi.json", dir), JSON.stringify(openapi, null, 2));
});

test("prompt reconstruction uses only declared information", () => {
  const prompt = reconstructPrompt(
    {
      intent: "qualify",
      goal: "Find a consultant for agent readiness",
      human_present: true,
      request_summary: "find someone in Switzerland who can make our shop work with ChatGPT agents",
      principal: { type: "business", role: "head of e-commerce", organization_size: "50-249", industry: "industrial supplies", region: "CH" },
      constraints: [{ field: "price", op: "lte", value: 5000, unit: "EUR" }, { note: "no platform migration" }],
      decision_criteria: [{ criterion: "price", direction: "minimize" }, { criterion: "local presence" }],
      alternatives_considered: ["competitor-a.example"],
      authority: { can_commit: false },
    },
    { qualify: { customer_type: "b2b-shop", budget_eur: 5000 } },
  );
  assert.equal(
    prompt,
    "I'm a head of e-commerce at a 50-249-person industrial supplies company in CH. " +
      "Find someone in Switzerland who can make our shop work with ChatGPT agents. " +
      "It must be: price at most 5,000 EUR; no platform migration. " +
      "What matters most, in order: minimize price, local presence. " +
      "I'm also looking at competitor-a.example. " +
      "Details: customer type: b2b-shop; budget eur: 5,000. " +
      "Don't commit to anything without asking me.",
  );
  assert.equal(reconstructPrompt({ goal: "Compare heat pumps", principal: { region: "CH" } }, {}),
    "I'm based in CH. Compare heat pumps.");
});
