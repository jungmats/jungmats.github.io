/**
 * Tests for this deployment's own journeys and the price estimation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyStep, nextSteps, prepareStep, start, type StepPlan } from "../src/engine/engine.ts";
import { lintDefinition } from "../src/engine/definitions.ts";
import type { Caller, JourneyDefinition, JourneyState, Rejection } from "../src/engine/types.ts";
import { budgetOf, buildEstimate, checkBudget } from "../src/pricing.ts";
import { config } from "../src/config.ts";

const load = (name: string): JourneyDefinition =>
  lintDefinition(JSON.parse(readFileSync(new URL(`../definitions/${name}.json`, import.meta.url), "utf8")));

const SITE_VISIT = load("site-visit");
const PRICING = load("price-estimate");
const T0 = new Date("2026-10-15T10:00:00Z");
const UNSIGNED: Caller = { keyid: null, agentName: null, trustTier: null };
const INTENT = { intent: "qualify", goal: "Find out what an agent-readiness audit costs", human_present: true };

function started(def: JourneyDefinition, intent: Record<string, unknown> = INTENT): JourneyState {
  const r = start(def, { intent }, UNSIGNED, "jrn_test", T0);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { state: JourneyState }).state;
}

/* ------------------------------------------------------------- definitions */

test("options in the definition match the configured prices", () => {
  const enumIds = PRICING.steps.estimate.fields.properties.options.items!.enum!.map(String).sort();
  assert.deepEqual(enumIds, Object.keys(config.pricing.options).sort());
});

test("site-visit: start, then report ends the journey achieved", () => {
  const s = started(SITE_VISIT);
  assert.deepEqual(nextSteps(SITE_VISIT, s).map((n) => n.step), ["report"]);
  const plan = prepareStep(SITE_VISIT, s, "report", { fields: { verdict: "possible-fit", pages_read: ["/", "/services/ai-agent-readiness.html"] } }, UNSIGNED, T0);
  assert.equal(plan.ok, true);
  const out = applyStep(SITE_VISIT, s, plan as StepPlan, T0);
  assert.equal(out.state.status, "achieved");
  assert.equal(out.state.stepData.report.verdict, "possible-fit");
});

test("site-visit: an empty report is accepted", () => {
  const plan = prepareStep(SITE_VISIT, started(SITE_VISIT), "report", {}, UNSIGNED, T0);
  assert.equal(plan.ok, true);
});

/* ------------------------------------------------------- repeatable estimate */

test("estimate needs at least one option, without duplicates", () => {
  const s = started(PRICING);
  for (const options of [[], ["agent-readiness-audit", "agent-readiness-audit"]]) {
    const r = prepareStep(PRICING, s, "estimate", { fields: { options } }, UNSIGNED, T0) as Rejection;
    assert.equal(r.ok, false);
    assert.equal(r.reason, "fields-invalid");
  }
});

test("estimate can be repeated, updates its data, and stays offered next to finish and follow_up", () => {
  let s = started(PRICING);
  const send = (options: string[], extra: object = {}) => {
    const plan = prepareStep(PRICING, s, "estimate", { fields: { options, ...extra } }, UNSIGNED, T0);
    assert.equal(plan.ok, true);
    assert.equal((plan as StepPlan).repeated, false);
    s = applyStep(PRICING, s, plan as StepPlan, T0, { result: {}, log: { total: 1 } }).state;
  };
  send(["agent-readiness-audit"], { website_url: "https://example.com" });
  send(["customer-journey-analysis", "agentic-monetization-diagnostic"]);
  assert.deepEqual(s.completedSteps, ["estimate"]);
  assert.deepEqual(s.stepData.estimate.options, ["customer-journey-analysis", "agentic-monetization-diagnostic"]);
  assert.equal(s.stepData.estimate.website_url, "https://example.com", "fields left out of a repeat are kept");
  assert.equal(s.stepData.estimate.total, 1, "handler log values are stored beside logged fields");
  assert.deepEqual(nextSteps(PRICING, s).map((n) => n.step), ["estimate", "finish", "follow_up"]);
});

function estimated(): JourneyState {
  const s = started(PRICING);
  const est = prepareStep(PRICING, s, "estimate", { fields: { options: ["agent-readiness-audit"] } }, UNSIGNED, T0);
  return applyStep(PRICING, s, est as StepPlan, T0, { result: {} }).state;
}

test("follow-up and finish both need an estimate first", () => {
  const s = started(PRICING);
  for (const step of ["follow_up", "finish"]) {
    const r = prepareStep(PRICING, s, step, { fields: { email: "a@b.co" } }, UNSIGNED, T0) as Rejection;
    assert.equal(r.reason, "step-out-of-order");
  }
});

test("follow-up needs an email, ends the journey, and never stores email, name or message", () => {
  const s = estimated();
  const missing = prepareStep(PRICING, s, "follow_up", { fields: { name: "Ada" } }, UNSIGNED, T0) as Rejection;
  assert.equal(missing.reason, "fields-missing");

  const plan = prepareStep(PRICING, s, "follow_up", { fields: { email: "ada@example.com", name: "Ada", company: "Example AG", message: "Call me" } }, UNSIGNED, T0);
  assert.equal(plan.ok, true);
  const out = applyStep(PRICING, s, plan as StepPlan, T0, { result: {}, log: { email_domain: "example.com" } });
  assert.equal(out.state.status, "achieved");
  assert.deepEqual(out.state.stepData["follow_up"], { company: "Example AG", email_domain: "example.com" });
});

test("finish ends the journey without contact details, all fields optional", () => {
  const s = estimated();
  const empty = prepareStep(PRICING, s, "finish", {}, UNSIGNED, T0);
  assert.equal(empty.ok, true);
  const plan = prepareStep(PRICING, s, "finish", { fields: { preferred_option: "agent-readiness-audit", decision: "still-comparing" } }, UNSIGNED, T0);
  const out = applyStep(PRICING, s, plan as StepPlan, T0);
  assert.equal(out.state.status, "achieved");
  assert.equal(out.state.stepData.finish.decision, "still-comparing");
  const leak = prepareStep(PRICING, s, "finish", { fields: { email: "a@b.co" } }, UNSIGNED, T0) as Rejection;
  assert.equal(leak.reason, "fields-invalid", "finish does not accept contact details");
});

/* ------------------------------------------------------------------- price */

test("estimate sums option prices, dated and valid 30 days", () => {
  const q = buildEstimate(["agent-readiness-audit", "agentic-monetization-diagnostic"], T0);
  assert.equal(q.total, 500 + 1900);
  assert.equal(q.currency, "EUR");
  assert.equal(q.prices_as_of, "2026-10-15");
  assert.equal(q.valid_until, "2026-11-14");
  assert.equal(q.indicative, true);
});

test("budget is read from a price ceiling constraint in EUR only", () => {
  assert.deepEqual(budgetOf({ constraints: [{ field: "price", op: "lte", value: 2000, unit: "EUR" }] }), { value: 2000, strict: false });
  assert.deepEqual(budgetOf({ constraints: [{ field: "budget", op: "lt", value: 900 }] }), { value: 900, strict: true });
  assert.equal(budgetOf({ constraints: [{ field: "price", op: "lte", value: 2000, unit: "USD" }] }), null);
  assert.equal(budgetOf({ constraints: [{ field: "deadline", op: "lte", value: "2026-11-30" }] }), null);
  assert.equal(budgetOf({}), null);
});

test("budget check says whether the estimate fits and which options would", () => {
  const q = buildEstimate(["customer-journey-analysis"], T0);
  const tight = checkBudget(q, { constraints: [{ field: "price", op: "lte", value: 1000, unit: "EUR" }] });
  assert.equal(tight.stated, true);
  assert.equal(tight.stated && tight.fits, false);
  assert.deepEqual(tight.stated && tight.options_within_budget, ["agent-readiness-audit"]);

  const exact = checkBudget(q, { constraints: [{ field: "price", op: "lte", value: 1500 }] });
  assert.equal(exact.stated && exact.fits, true);
  const strict = checkBudget(q, { constraints: [{ field: "price", op: "lt", value: 1500 }] });
  assert.equal(strict.stated && strict.fits, false);

  assert.equal(checkBudget(q, {}).stated, false);
});
