/**
 * Engine tests — run with `npm run test:journey` (Node 24 runs TypeScript
 * directly, no build step or test framework).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { applyStep, cancel, expire, nextSteps, prepareStep, start } from "../src/engine/engine.ts";
import { lintDefinition, DefinitionError, topoOrder } from "../src/engine/definitions.ts";
import { validate } from "../src/engine/validate.ts";
import type { Caller, JourneyDefinition, JourneyState, Rejection } from "../src/engine/types.ts";

const load = (name: string): JourneyDefinition =>
  lintDefinition(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));

const LEAD = load("lead-qualification");
const EXPIRING = load("demo-expiring");

const T0 = new Date("2026-09-29T10:00:00Z");
const later = (s: number) => new Date(T0.getTime() + s * 1000);

const AGENT_A: Caller = { keyid: "key-a", agentName: "Agent A", trustTier: "own" };
const AGENT_B: Caller = { keyid: "key-b", agentName: "Agent B", trustTier: "own" };
const UNSIGNED: Caller = { keyid: null, agentName: null, trustTier: null };

const INTENT = {
  intent: "qualify",
  goal: "Find a consultant for agent readiness",
  human_present: true,
  request_summary: "Find someone to make our shop usable by AI agents",
  journey_stage: "shortlisting",
};

const QUALIFY_OK = {
  customer_type: "b2b-shop",
  problem: "Our product catalogue is invisible to AI shopping agents.",
  budget_eur: 5000,
  deadline: "2026-11-30",
};

function started(caller = AGENT_A, def = LEAD): JourneyState {
  const r = start(def, { intent: INTENT }, caller, "jrn_test", T0);
  assert.equal(r.ok, true);
  return (r as { state: JourneyState }).state;
}

function step(def: JourneyDefinition, state: JourneyState, name: string, fields: object = {}, caller = AGENT_A, now = later(1)) {
  const plan = prepareStep(def, state, name, { fields }, caller, now);
  if (!plan.ok) return { rejection: plan as Rejection, state };
  return { rejection: null, ...applyStep(def, state, plan, now) };
}

const rejected = (x: { rejection: Rejection | null }) => {
  assert.ok(x.rejection, "expected a rejection");
  return x.rejection!;
};

/* ------------------------------------------------------------- definitions */

test("both shipped definitions lint cleanly", () => {
  assert.equal(LEAD.id, "lead-qualification");
  assert.deepEqual(topoOrder(LEAD), ["discover", "qualify", "verify", "transact"]);
});

test("linter rejects cycles, unknown requires, and missing terminals", () => {
  const bad = structuredClone(LEAD);
  bad.steps.discover.requires = ["transact"];
  assert.throws(() => lintDefinition(bad), /cycle/);

  const unknown = structuredClone(LEAD);
  unknown.steps.qualify.requires = ["nope"];
  assert.throws(() => lintDefinition(unknown), /unknown step "nope"/);

  const noTerminal = structuredClone(LEAD);
  delete noTerminal.steps.transact.terminal;
  assert.throws(() => lintDefinition(noTerminal), DefinitionError);
});

/* -------------------------------------------------------------------- start */

test("start: missing intent is refused with intent-missing", () => {
  const r = start(LEAD, {}, AGENT_A, "jrn_x", T0) as Rejection;
  assert.equal(r.reason, "intent-missing");
  assert.equal(r.status, 422);
});

test("start: incomplete intent lists every missing field", () => {
  const r = start(LEAD, { intent: { intent: "qualify" } }, AGENT_A, "jrn_x", T0) as Rejection;
  assert.equal(r.reason, "intent-missing");
  assert.deepEqual(r.problems!.map((p) => p.field).sort(), ["intent.goal", "intent.human_present"]);
});

test("start: an intent kind the journey does not allow is invalid", () => {
  const r = start(LEAD, { intent: { ...INTENT, intent: "support" } }, AGENT_A, "jrn_x", T0) as Rejection;
  assert.equal(r.reason, "intent-invalid");
});

test("start: identity-required journeys refuse unsigned agents", () => {
  const strict = { ...LEAD, identity: "required" as const };
  const r = start(strict, { intent: INTENT }, UNSIGNED, "jrn_x", T0) as Rejection;
  assert.equal(r.reason, "identity-required");
  assert.equal(r.status, 401);
});

test("start: completeness counts supplied optional envelope fields", () => {
  const s = started();
  assert.ok(s.completeness > 0 && s.completeness < 1);
  const bare = start(LEAD, { intent: { intent: "qualify", goal: "Find a consultant please", human_present: false } }, AGENT_A, "j", T0);
  assert.equal((bare as { state: JourneyState }).state.completeness, 0);
});

/* -------------------------------------------------------------------- steps */

test("happy path reaches achieved", () => {
  let s = started();
  assert.deepEqual(nextSteps(LEAD, s).map((n) => n.step), ["discover"]);

  let r = step(LEAD, s, "discover");
  assert.equal(r.rejection, null);
  s = r.state;

  r = step(LEAD, s, "qualify", QUALIFY_OK);
  s = r.state;
  assert.deepEqual(s.stepData.qualify, QUALIFY_OK);

  const plan = prepareStep(LEAD, s, "verify", { fields: { acting_for: "jane@example.com", code: "123456" } }, AGENT_A, later(2));
  assert.equal(plan.ok, true);
  assert.equal((plan as { needsUserBinding: boolean }).needsUserBinding, true);
  s = applyStep(LEAD, s, plan as never, later(2)).state;
  assert.deepEqual(s.stepData.verify, {}, "sensitive fields are never stored");

  const t = step(LEAD, s, "transact", { requested_action: "book-call" });
  assert.equal(t.ended!.status, "achieved");
  assert.equal(t.state.status, "achieved");
  assert.deepEqual(nextSteps(LEAD, t.state), []);
});

test("skipping a step is refused with step-out-of-order naming the missing step", () => {
  const s = step(LEAD, started(), "discover").state;
  const r = rejected(step(LEAD, s, "verify", { acting_for: "a@b.co", code: "123456" }));
  assert.equal(r.reason, "step-out-of-order");
  assert.equal(r.status, 409);
  assert.deepEqual(r.missingSteps, ["qualify"]);
});

test("missing and invalid fields are reported, and the journey is unchanged", () => {
  const s = step(LEAD, started(), "discover").state;
  const missing = rejected(step(LEAD, s, "qualify", { customer_type: "b2b-shop" }));
  assert.equal(missing.reason, "fields-missing");
  assert.deepEqual(missing.problems!.map((p) => p.field).sort(), ["fields.budget_eur", "fields.deadline", "fields.problem"]);

  const invalid = rejected(step(LEAD, s, "qualify", { ...QUALIFY_OK, deadline: "next week" }));
  assert.equal(invalid.reason, "fields-invalid");

  const unknown = rejected(step(LEAD, s, "qualify", { ...QUALIFY_OK, budget: 5000 }));
  assert.equal(unknown.problems![0].problem, "unknown-field");
});

test("an end_if rule ends the journey as not_achieved, and later steps are refused", () => {
  let s = step(LEAD, started(), "discover").state;
  const r = step(LEAD, s, "qualify", { ...QUALIFY_OK, budget_eur: 800 });
  assert.equal(r.ended!.status, "not_achieved");
  assert.equal(r.ended!.reason, "below-minimum-budget");
  s = r.state;
  const after = rejected(step(LEAD, s, "verify", { acting_for: "a@b.co", code: "123456" }));
  assert.equal(after.reason, "journey-closed");
});

test("repeating a completed step is idempotent", () => {
  const s = step(LEAD, started(), "discover").state;
  const again = step(LEAD, s, "discover");
  assert.equal(again.repeated, true);
  assert.equal(again.state.revision, s.revision, "a repeat changes nothing");
});

test("a journey started by one key refuses calls signed by another", () => {
  const r = rejected(step(LEAD, started(AGENT_A), "discover", {}, AGENT_B));
  assert.equal(r.reason, "wrong-agent");
  assert.equal(r.status, 403);
  const unsigned = rejected(step(LEAD, started(AGENT_A), "discover", {}, UNSIGNED));
  assert.equal(unsigned.reason, "wrong-agent");
});

test("an unsigned journey accepts any caller (bearer journey id)", () => {
  const r = step(LEAD, started(UNSIGNED), "discover", {}, AGENT_B);
  assert.equal(r.rejection, null);
});

test("human presence is required for verify, and can be asserted per call", () => {
  const absent = started();
  absent.intent = { ...absent.intent, human_present: false };
  let s = step(LEAD, absent, "discover").state;
  s = step(LEAD, s, "qualify", QUALIFY_OK).state;
  const body = { fields: { acting_for: "a@b.co", code: "123456" } };
  const r = prepareStep(LEAD, s, "verify", body, AGENT_A, later(2)) as Rejection;
  assert.equal(r.reason, "human-presence-required");
  const ok = prepareStep(LEAD, s, "verify", { ...body, human_present: true }, AGENT_A, later(2));
  assert.equal(ok.ok, true);
});

test("unknown steps are refused", () => {
  const r = rejected(step(LEAD, started(), "pay"));
  assert.equal(r.reason, "step-unknown");
});

/* ------------------------------------------------------------------- expiry */

test("an idle journey expires to abandoned, and calls are refused with 410", () => {
  const s = started(AGENT_A, EXPIRING);
  const r = rejected(step(EXPIRING, s, "discover", {}, AGENT_A, later(6)));
  assert.equal(r.reason, "journey-expired");
  assert.equal(r.status, 410);
  const e = expire(s, later(6));
  assert.equal(e.status, "abandoned");
  assert.equal(e.endReason, "idle-timeout");
});

test("each accepted step pushes the idle timeout out again", () => {
  const s = step(EXPIRING, started(AGENT_A, EXPIRING), "discover", {}, AGENT_A, later(4)).state;
  const r = step(EXPIRING, s, "finish", {}, AGENT_A, later(8));
  assert.equal(r.rejection, null);
  assert.equal(r.state.status, "achieved");
});

/* ------------------------------------------------------------------- cancel */

test("cancel records the reason and closes the journey", () => {
  const r = cancel(started(), { reason: "found-alternative", alternative_chosen: "competitor.example" }, AGENT_A, later(1));
  assert.equal(r.ok, true);
  const s = (r as { state: JourneyState }).state;
  assert.equal(s.status, "cancelled");
  assert.equal(s.endReason, "found-alternative");
  assert.equal(s.alternativeChosen, "competitor.example");
  assert.equal((cancel(s, { reason: "other" }, AGENT_A, later(2)) as Rejection).reason, "journey-closed");
});

test("cancel without a valid reason is refused", () => {
  assert.equal((cancel(started(), {}, AGENT_A, later(1)) as Rejection).reason, "cancel-reason-invalid");
  assert.equal((cancel(started(), { reason: "bored" }, AGENT_A, later(1)) as Rejection).reason, "cancel-reason-invalid");
  assert.equal((cancel(started(), { reason: "other" }, AGENT_B, later(1)) as Rejection).reason, "wrong-agent");
});

/* ---------------------------------------------------------------- validator */

test("validator checks nested envelope structures", () => {
  const problems = validate(
    { decision_criteria: [{ criterion: "price", weight: 2 }], principal: { organization_size: "huge" } },
    { type: "object", properties: {
      decision_criteria: { type: "array", items: { type: "object", required: ["criterion"], properties: { criterion: { type: "string" }, weight: { type: "number", maximum: 1 } } } },
      principal: { type: "object", properties: { organization_size: { type: "string", enum: ["1", "2-9"] } } },
    } },
  );
  assert.deepEqual(problems.map((p) => [p.field, p.problem]), [
    ["decision_criteria[0].weight", "too-large"],
    ["principal.organization_size", "not-allowed"],
  ]);
});
