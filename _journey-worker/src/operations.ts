/**
 * The protocol's operations, independent of the transport: start, get, step
 * and cancel. HTTP (src/routes/protocol.ts) and MCP (src/mcp/) parse their
 * own requests, call these, and render the result their own way.
 *
 * Each operation: rate-limit, load and lazily expire the journey, check the
 * caller, ask the pure engine, persist, emit one event, return. A refusal on
 * an existing journey carries the journey, so the transport can show the
 * next steps and the agent can recover on its own.
 */
import { DEFINITIONS } from "./journeys";
import { emit } from "./sinks";
import { getJourney, insertJourney, newJourneyId, updateJourney } from "./store";
import { HANDLERS } from "./handlers";
import { storesContact } from "./rules";
import { applyStep, cancel, expire, isExpired, prepareStep, start, type Computed } from "./engine/engine";
import { isPlainObject } from "./engine/validate";
import type { Identified } from "./adapters/identity";
import type { Caller, JourneyDefinition, JourneyState, Rejection } from "./engine/types";
import type { Env } from "./env";

export type Transport = "http" | "mcp";

export interface OpContext {
  env: Env;
  ctx: ExecutionContext;
  origin: string;
  now: Date;
  transport: Transport;
  /** The rate-limit key. */
  ip: string;
  /** Who is calling, as the transport's identity adapter saw it. */
  identified: Identified;
  /** W3C trace context of the start call, if any. */
  traceparent?: string | null;
  /** Logged with the start event: which client software called, e.g. the MCP clientInfo. */
  client?: Record<string, unknown> | null;
}

export type Problem = Pick<Rejection, "status" | "reason" | "title" | "detail">;

export type JourneyRef = { def: JourneyDefinition; state: JourneyState };

export type OpResult =
  | { ok: true; status: number; def: JourneyDefinition; state: JourneyState; extra: Record<string, unknown> }
  | {
      ok: false;
      problem: Problem;
      /** Extra members of the problem, e.g. the field problems. */
      extra: Record<string, unknown>;
      /** The journey the refusal is about, when the caller may see it. */
      journey: JourneyRef | null;
    };

const A2A_STATE = {
  active: "working",
  achieved: "completed",
  not_achieved: "failed",
  cancelled: "canceled",
  abandoned: "failed",
} as const;

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

/** The journey as every transport shows it; the transport adds how to go on. */
export function journeyView(s: JourneyState) {
  return {
    journey_id: s.id,
    definition: s.definitionId,
    status: s.status,
    a2a_state: A2A_STATE[s.status],
    ...(s.endReason ? { end_reason: s.endReason } : {}),
    completed_steps: s.completedSteps,
  };
}

/** The part of the view that follows the transport's next steps. */
export function journeyViewTail(s: JourneyState) {
  return {
    ...(s.status === "active" ? { expires_at: s.expiresAt } : { ended_at: s.endedAt }),
    verified_agent: s.keyid ? { name: s.agentName, trust_tier: s.trustTier } : null,
  };
}

const TOO_MANY: Problem = { status: 429, reason: "bad-request", title: "Too many requests", detail: "Slow down and retry in a minute." };

async function limited(c: OpContext, strict: boolean): Promise<boolean> {
  const limiter = strict ? c.env.CONTACT_LIMITER : c.env.WRITE_LIMITER;
  return !!limiter && !(await limiter.limit({ key: c.ip })).success;
}

const fail = (problem: Problem, extra: Record<string, unknown> = {}, journey: JourneyRef | null = null): OpResult =>
  ({ ok: false, problem, extra, journey });

function detailsOf(r: Rejection): Record<string, unknown> | null {
  const d: Record<string, unknown> = {};
  if (r.problems) d.fields = r.problems.map((p) => `${p.field}:${p.problem}`);
  if (r.missingSteps) d.missing_steps = r.missingSteps;
  return Object.keys(d).length ? d : null;
}

/** A refusal on an existing journey: logged, and carrying the journey if the caller owns it. */
function refuse(c: OpContext, r: Rejection, def: JourneyDefinition, s: JourneyState, caller: Caller, step: string, more: Record<string, unknown> = {}): OpResult {
  emit(c.env, c.ctx, {
    journeyId: s.id, definitionId: def.id, step, outcome: "rejected", reason: r.reason, status: r.status,
    details: detailsOf(r), keyid: caller.keyid, transport: c.transport,
  });
  const ownerOk = !(s.keyid && caller.keyid !== s.keyid);
  return fail(r, {
    ...(r.problems ? { problems: r.problems } : {}),
    ...(r.missingSteps ? { missing_steps: r.missingSteps } : {}),
    ...more,
  }, ownerOk ? { def, state: s } : null);
}

function identityRefusal(c: OpContext, idn: Extract<Identified, { ok: false }>, journeyId: string | null, definitionId: string | null, step: string): OpResult {
  emit(c.env, c.ctx, {
    journeyId, definitionId, step, outcome: "rejected", reason: "identity-invalid", status: 401,
    details: { verifier: idn.reason }, keyid: idn.keyid, transport: c.transport,
  });
  return fail(
    { status: 401, reason: "identity-invalid", title: "Signature did not verify", detail: `${idn.detail} Send the request unsigned instead, or fix the signature.` },
    { verifier_reason: idn.reason },
  );
}

/** Loads a journey and persists lazy expiry, so the stored status is honest. */
async function load(c: OpContext, id: string): Promise<JourneyRef | null> {
  let state = await getJourney(c.env, id);
  if (!state) return null;
  const def = DEFINITIONS.get(state.definitionId);
  if (!def) return null;
  if (isExpired(state, c.now)) {
    const expired = expire(state, c.now);
    if (await updateJourney(c.env, expired, state.revision)) state = expired;
  }
  return { def, state };
}

/** A transport that names the definition (MCP tools do) gets a refusal for another journey's id. */
function wrongDefinition(c: OpContext, expected: string | undefined, def: JourneyDefinition, s: JourneyState, caller: Caller, step: string): OpResult | null {
  if (!expected || expected === def.id) return null;
  return refuse(c, {
    ok: false, status: 409, reason: "bad-request", title: "This journey is another kind of journey",
    detail: `Journey ${s.id} is a "${def.id}" journey, not "${expected}". To ${step === "cancel" ? "cancel" : "use"} a "${expected}" journey, start one first: it runs alongside this one, which stays open and still needs its own ending.`,
  }, def, s, caller, step, { start_definition: expected });
}

const UNKNOWN_JOURNEY: Problem = { status: 404, reason: "journey-unknown", title: "No such journey", detail: "Check the journey_id, or start a new journey." };
const CONCURRENT: Rejection = { ok: false, status: 409, reason: "concurrent-update", title: "Another call changed this journey first", detail: "Read the journey and retry." };

/* ------------------------------------------------------------------- start */

/** `body` is `{definition, intent}`. */
export async function startJourney(c: OpContext, body: unknown): Promise<OpResult> {
  if (await limited(c, false)) return fail(TOO_MANY);

  const defId = isPlainObject(body) && typeof body.definition === "string" ? body.definition : null;
  const def = defId ? DEFINITIONS.get(defId) : undefined;
  if (!def) {
    emit(c.env, c.ctx, { journeyId: null, definitionId: defId, step: "start", outcome: "rejected", reason: "definition-unknown", status: 404, details: null, keyid: null, transport: c.transport });
    return fail(
      { status: 404, reason: "definition-unknown", title: "Unknown journey definition", detail: `Send "definition" as one of: ${[...DEFINITIONS.keys()].join(", ")}.` },
      { discovery: `${c.origin}/.well-known/agent-journeys` },
    );
  }

  const idn = c.identified;
  if (!idn.ok) return identityRefusal(c, idn, null, def.id, "start");

  const r = start(def, body, idn.caller, newJourneyId(), c.now);
  if (!r.ok) {
    emit(c.env, c.ctx, { journeyId: null, definitionId: def.id, step: "start", outcome: "rejected", reason: r.reason, status: r.status, details: detailsOf(r), keyid: idn.caller.keyid, transport: c.transport });
    return fail(r, { ...(r.problems ? { problems: r.problems } : {}), definition: `${c.origin}/journeys/${def.id}` });
  }

  const tp = c.traceparent;
  await insertJourney(c.env, r.state, { transport: c.transport, traceparent: tp && TRACEPARENT.test(tp) ? tp : null });
  emit(c.env, c.ctx, { journeyId: r.state.id, definitionId: def.id, step: "start", outcome: "accepted", reason: null, status: 201, details: c.client ?? null, keyid: idn.caller.keyid, transport: c.transport });

  return {
    ok: true, status: 201, def, state: r.state,
    extra: {
      intent_completeness: r.state.completeness,
      ...(def.welcome ? { welcome: def.welcome } : {}),
      note: r.state.keyid
        ? "This journey is bound to your signing key: every later call must be signed with it."
        : "Unsigned journey: the journey_id alone identifies it, so keep it private.",
    },
  };
}

/* --------------------------------------------------------------------- get */

export async function readJourney(c: OpContext, id: string): Promise<OpResult> {
  const loaded = await load(c, id);
  if (!loaded) return fail(UNKNOWN_JOURNEY);
  const idn = c.identified;
  if (!idn.ok) return identityRefusal(c, idn, id, loaded.def.id, "read");
  if (loaded.state.keyid && idn.caller.keyid !== loaded.state.keyid) {
    return fail({ status: 403, reason: "wrong-agent", title: "This journey belongs to another agent", detail: "Sign with the key that started the journey." });
  }
  return { ok: true, status: 200, def: loaded.def, state: loaded.state, extra: {} };
}

/* -------------------------------------------------------------------- step */

/** `body` is `{fields}`. `definitionId`, if given, must be the journey's. */
export async function runStep(c: OpContext, id: string, stepName: string, body: unknown, definitionId?: string): Promise<OpResult> {
  if (await limited(c, false)) return fail(TOO_MANY);

  const loaded = await load(c, id);
  if (!loaded) return fail(UNKNOWN_JOURNEY);
  const { def, state } = loaded;

  const idn = c.identified;
  if (!idn.ok) return identityRefusal(c, idn, id, def.id, stepName);
  const caller = idn.caller;
  const wrong = wrongDefinition(c, definitionId, def, state, caller, stepName);
  if (wrong) return wrong;

  if (storesContact(def, stepName) && (await limited(c, true))) return fail(TOO_MANY);

  const plan = prepareStep(def, state, stepName, body, caller, c.now);
  if (!plan.ok) return refuse(c, plan, def, state, caller, stepName);

  let computed: Computed | undefined;
  const handlerName = def.steps[stepName].handler;
  if (handlerName && !plan.repeated) {
    const out = await HANDLERS[handlerName]({ env: c.env, state, fields: plan.fields, now: c.now });
    if (!out.ok) {
      return refuse(c, { ok: false, status: out.status, reason: "upstream-failed", title: out.title, detail: out.detail }, def, state, caller, stepName);
    }
    computed = out.computed;
  }

  const outcome = applyStep(def, state, plan, c.now, computed);
  if (!outcome.repeated && !(await updateJourney(c.env, outcome.state, state.revision))) {
    return refuse(c, CONCURRENT, def, state, caller, stepName);
  }

  emit(c.env, c.ctx, {
    journeyId: state.id, definitionId: def.id, step: stepName, outcome: "accepted", reason: outcome.ended?.reason ?? null,
    status: 200, details: outcome.repeated ? { repeated: true } : outcome.ended ? { ended: outcome.ended.status } : null,
    keyid: caller.keyid, transport: c.transport,
  });

  return {
    ok: true, status: 200, def, state: outcome.state,
    extra: {
      step: stepName,
      ...(outcome.repeated ? { repeated: true, note: "This step was already completed; nothing changed." } : {}),
      result: outcome.result,
      ...(outcome.ended?.message ? { message: outcome.ended.message } : {}),
    },
  };
}

/* ------------------------------------------------------------------ cancel */

/** `body` is `{reason, detail?, alternative_chosen?, ...cancel fields}`. `definitionId`, if given, must be the journey's. */
export async function cancelJourney(c: OpContext, id: string, body: unknown, definitionId?: string): Promise<OpResult> {
  if (await limited(c, false)) return fail(TOO_MANY);

  const loaded = await load(c, id);
  if (!loaded) return fail(UNKNOWN_JOURNEY);
  const { def, state } = loaded;

  const idn = c.identified;
  if (!idn.ok) return identityRefusal(c, idn, id, def.id, "cancel");
  const wrong = wrongDefinition(c, definitionId, def, state, idn.caller, "cancel");
  if (wrong) return wrong;

  const r = cancel(state, body, idn.caller, c.now, def);
  if (!r.ok) return refuse(c, r, def, state, idn.caller, "cancel");
  if (!(await updateJourney(c.env, r.state, state.revision))) return refuse(c, CONCURRENT, def, state, idn.caller, "cancel");
  emit(c.env, c.ctx, { journeyId: state.id, definitionId: def.id, step: "cancel", outcome: "accepted", reason: r.state.endReason, status: 200, details: null, keyid: idn.caller.keyid, transport: c.transport });
  return { ok: true, status: 200, def, state: r.state, extra: { note: "Thanks: knowing why a journey ended is the most useful signal a site gets." } };
}
