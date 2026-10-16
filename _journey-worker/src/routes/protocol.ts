/**
 * The protocol over HTTP:
 *
 *   POST /api/journey/start
 *   GET  /api/journey/{id}
 *   POST /api/journey/{id}/steps/{step}
 *   POST /api/journey/{id}/cancel
 *
 * Each handler: identify the caller, load and lazily expire the journey, ask
 * the pure engine, persist, emit one event, respond. Every refusal carries
 * the next steps and the cancel link, so an agent can recover on its own.
 */
import { DEFINITIONS } from "../journeys";
import { json, problem, readJson } from "../http";
import { emit } from "../sinks";
import { getJourney, insertJourney, newJourneyId, updateJourney } from "../store";
import { identify } from "../adapters/identity";
import { HANDLERS } from "../handlers";
import { applyStep, cancel, expire, isExpired, nextSteps, prepareStep, start, type Computed } from "../engine/engine";
import { isPlainObject } from "../engine/validate";
import type { Caller, JourneyDefinition, JourneyState, Rejection } from "../engine/types";
import type { Env } from "../env";

const A2A_STATE = {
  active: "working",
  achieved: "completed",
  not_achieved: "failed",
  cancelled: "canceled",
  abandoned: "failed",
} as const;

const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

type Ctx = { env: Env; ctx: ExecutionContext; origin: string; now: Date };

/* ------------------------------------------------------------ view builders */

function links(def: JourneyDefinition, s: JourneyState, origin: string) {
  const base = `${origin}/api/journey/${s.id}`;
  const out: Record<string, string> = { self: base, definition: `${origin}/journeys/${def.id}` };
  if (s.status === "active") out.cancel = `${base}/cancel`;
  return out;
}

function next(def: JourneyDefinition, s: JourneyState, origin: string) {
  return nextSteps(def, s).map((n) => ({
    ...n,
    method: "POST",
    href: `${origin}/api/journey/${s.id}/steps/${n.step}`,
  }));
}

function view(def: JourneyDefinition, s: JourneyState, origin: string, extra: Record<string, unknown> = {}) {
  return {
    journey_id: s.id,
    definition: def.id,
    status: s.status,
    a2a_state: A2A_STATE[s.status],
    ...(s.endReason ? { end_reason: s.endReason } : {}),
    completed_steps: s.completedSteps,
    next_steps: next(def, s, origin),
    ...(s.status === "active" ? { expires_at: s.expiresAt } : { ended_at: s.endedAt }),
    verified_agent: s.keyid ? { name: s.agentName, trust_tier: s.trustTier } : null,
    links: links(def, s, origin),
    ...extra,
  };
}

/** A refusal on an existing journey: problem+json plus where to go next. */
function refuse(c: Ctx, r: Rejection, def: JourneyDefinition, s: JourneyState, caller: Caller, step: string): Response {
  emit(c.env, c.ctx, {
    journeyId: s.id, definitionId: def.id, step, outcome: "rejected", reason: r.reason, status: r.status,
    details: detailsOf(r), keyid: caller.keyid, transport: "http",
  });
  const ownerOk = !(s.keyid && caller.keyid !== s.keyid);
  return problem(r, {
    ...(r.problems ? { problems: r.problems } : {}),
    ...(r.missingSteps ? { missing_steps: r.missingSteps } : {}),
    ...(ownerOk
      ? { journey_status: s.status, completed_steps: s.completedSteps, next_steps: next(def, s, c.origin), links: links(def, s, c.origin) }
      : {}),
  });
}

function detailsOf(r: Rejection): Record<string, unknown> | null {
  const d: Record<string, unknown> = {};
  if (r.problems) d.fields = r.problems.map((p) => `${p.field}:${p.problem}`);
  if (r.missingSteps) d.missing_steps = r.missingSteps;
  return Object.keys(d).length ? d : null;
}

function identityRefusal(c: Ctx, idn: { reason: string; detail: string; keyid: string | null }, journeyId: string | null, definitionId: string | null, step: string): Response {
  emit(c.env, c.ctx, {
    journeyId, definitionId, step, outcome: "rejected", reason: "identity-invalid", status: 401,
    details: { verifier: idn.reason }, keyid: idn.keyid, transport: "http",
  });
  return problem(
    { status: 401, reason: "identity-invalid", title: "Signature did not verify", detail: `${idn.detail} Send the request unsigned instead, or fix the signature.` },
    { verifier_reason: idn.reason },
  );
}

/** Loads a journey and persists lazy expiry, so the stored status is honest. */
async function load(c: Ctx, id: string): Promise<{ def: JourneyDefinition; state: JourneyState } | null> {
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

const unknownJourney = () =>
  problem({ status: 404, reason: "journey-unknown", title: "No such journey", detail: "Check the journey_id, or start a new journey." });

/* ------------------------------------------------------------------- start */

export async function handleStart(request: Request, c: Ctx): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const defId = isPlainObject(body) && typeof body.definition === "string" ? body.definition : null;
  const def = defId ? DEFINITIONS.get(defId) : undefined;
  if (!def) {
    emit(c.env, c.ctx, { journeyId: null, definitionId: defId, step: "start", outcome: "rejected", reason: "definition-unknown", status: 404, details: null, keyid: null, transport: "http" });
    return problem(
      { status: 404, reason: "definition-unknown", title: "Unknown journey definition", detail: `Send "definition" as one of: ${[...DEFINITIONS.keys()].join(", ")}.` },
      { discovery: `${c.origin}/.well-known/agent-journeys` },
    );
  }

  const idn = await identify(request);
  if (!idn.ok) return identityRefusal(c, idn, null, def.id, "start");

  const r = start(def, body, idn.caller, newJourneyId(), c.now);
  if (!r.ok) {
    emit(c.env, c.ctx, { journeyId: null, definitionId: def.id, step: "start", outcome: "rejected", reason: r.reason, status: r.status, details: detailsOf(r), keyid: idn.caller.keyid, transport: "http" });
    return problem(r, { ...(r.problems ? { problems: r.problems } : {}), definition: `${c.origin}/journeys/${def.id}` });
  }

  const tp = request.headers.get("traceparent");
  await insertJourney(c.env, r.state, { transport: "http", traceparent: tp && TRACEPARENT.test(tp) ? tp : null });
  emit(c.env, c.ctx, { journeyId: r.state.id, definitionId: def.id, step: "start", outcome: "accepted", reason: null, status: 201, details: null, keyid: idn.caller.keyid, transport: "http" });

  return json(
    view(def, r.state, c.origin, {
      intent_completeness: r.state.completeness,
      ...(def.welcome ? { welcome: def.welcome } : {}),
      note: r.state.keyid
        ? "This journey is bound to your signing key: every later call must be signed with it."
        : "Unsigned journey: the journey_id alone identifies it, so keep it private.",
    }),
    201,
  );
}

/* --------------------------------------------------------------------- get */

export async function handleGet(request: Request, c: Ctx, id: string): Promise<Response> {
  const loaded = await load(c, id);
  if (!loaded) return unknownJourney();
  const idn = await identify(request);
  if (!idn.ok) return identityRefusal(c, idn, id, loaded.def.id, "read");
  if (loaded.state.keyid && idn.caller.keyid !== loaded.state.keyid) {
    return problem({ status: 403, reason: "wrong-agent", title: "This journey belongs to another agent", detail: "Sign with the key that started the journey." });
  }
  return json(view(loaded.def, loaded.state, c.origin));
}

/* -------------------------------------------------------------------- step */

export async function handleStep(request: Request, c: Ctx, id: string, stepName: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  const loaded = await load(c, id);
  if (!loaded) return unknownJourney();
  const { def, state } = loaded;

  const idn = await identify(request);
  if (!idn.ok) return identityRefusal(c, idn, id, def.id, stepName);
  const caller = idn.caller;

  const plan = prepareStep(def, state, stepName, parsed.body, caller, c.now);
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
    return refuse(c, { ok: false, status: 409, reason: "concurrent-update", title: "Another call changed this journey first", detail: "Read the journey and retry." }, def, state, caller, stepName);
  }

  emit(c.env, c.ctx, {
    journeyId: state.id, definitionId: def.id, step: stepName, outcome: "accepted", reason: outcome.ended?.reason ?? null,
    status: 200, details: outcome.repeated ? { repeated: true } : outcome.ended ? { ended: outcome.ended.status } : null,
    keyid: caller.keyid, transport: "http",
  });

  return json(view(def, outcome.state, c.origin, {
    step: stepName,
    ...(outcome.repeated ? { repeated: true, note: "This step was already completed; nothing changed." } : {}),
    result: outcome.result,
    ...(outcome.ended?.message ? { message: outcome.ended.message } : {}),
  }));
}

/* ------------------------------------------------------------------ cancel */

export async function handleCancel(request: Request, c: Ctx, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const loaded = await load(c, id);
  if (!loaded) return unknownJourney();
  const { def, state } = loaded;

  const idn = await identify(request);
  if (!idn.ok) return identityRefusal(c, idn, id, def.id, "cancel");

  const r = cancel(state, parsed.body, idn.caller, c.now);
  if (!r.ok) return refuse(c, r, def, state, idn.caller, "cancel");
  if (!(await updateJourney(c.env, r.state, state.revision))) {
    return refuse(c, { ok: false, status: 409, reason: "concurrent-update", title: "Another call changed this journey first", detail: "Read the journey and retry." }, def, state, idn.caller, "cancel");
  }
  emit(c.env, c.ctx, { journeyId: state.id, definitionId: def.id, step: "cancel", outcome: "accepted", reason: r.state.endReason, status: 200, details: null, keyid: idn.caller.keyid, transport: "http" });
  return json(view(def, r.state, c.origin, { note: "Thanks: knowing why a journey ended is the most useful signal a site gets." }));
}
