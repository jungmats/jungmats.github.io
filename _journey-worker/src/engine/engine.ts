/**
 * The journey state machine. Pure: every function takes the current state
 * and returns a new one or a rejection. Persistence, identity verification
 * and user binding happen outside, in the Worker.
 *
 * A step is two calls, prepareStep() then applyStep(), so that a side effect
 * with a cost (consuming a single-use verification code) only happens after
 * every free check has passed. Otherwise an out-of-order call would burn the
 * user's code.
 *
 * Rejected calls never change the journey. Only accepted calls, cancels and
 * expiry do. See AGENT-JOURNEY-PROTOCOL.md §4.4.
 */
import {
  CANCEL_REASONS,
  type Caller,
  type EndRule,
  type FieldSchema,
  type JourneyDefinition,
  type JourneyState,
  type NextStep,
  type Rejection,
  type RejectionReason,
} from "./types.ts";
import { isPlainObject, publicSchema, validate } from "./validate.ts";
import { completeness, envelopeSchemaFor, PROTOCOL_REQUIRED } from "./envelope.ts";
import { topoOrder } from "./definitions.ts";

export function reject(
  status: number,
  reason: RejectionReason,
  title: string,
  detail: string,
  extra: Partial<Rejection> = {},
): Rejection {
  return { ok: false, status, reason, title, detail, ...extra };
}

const iso = (d: Date) => d.toISOString();
const plus = (d: Date, seconds: number) => new Date(d.getTime() + seconds * 1000);

/* ------------------------------------------------------------------ start */

export type StartResult = { ok: true; state: JourneyState } | Rejection;

export function start(
  def: JourneyDefinition,
  body: unknown,
  caller: Caller,
  id: string,
  now: Date,
): StartResult {
  if (def.identity === "required" && !caller.keyid) {
    return reject(401, "identity-required", "Verified agent identity required",
      `Journey "${def.id}" only accepts agents that sign their requests with Web Bot Auth.`);
  }

  const intent = isPlainObject(body) ? body.intent : undefined;
  const required = [...PROTOCOL_REQUIRED, ...(def.intent.required ?? [])];
  if (!isPlainObject(intent)) {
    return reject(422, "intent-missing", "Intent declaration missing",
      `Start a journey with a JSON body {"definition": "${def.id}", "intent": {...}}. Required intent fields: ${required.join(", ")}. No declared intent, no journey.`,
      { problems: required.map((f) => ({ field: `intent.${f}`, problem: "missing" as const })) });
  }

  const schema = envelopeSchemaFor(def.intent.allowed, def.intent.required);
  const problems = validate(intent, schema, "intent");
  if (problems.length) {
    const missing = problems.some((p) => p.problem === "missing");
    return reject(422, missing ? "intent-missing" : "intent-invalid",
      missing ? "Intent declaration incomplete" : "Intent declaration invalid",
      "Fix the listed intent fields and start again. Nothing was created.",
      { problems });
  }

  return {
    ok: true,
    state: {
      id,
      definitionId: def.id,
      definitionVersion: def.version,
      status: "active",
      endReason: null,
      endDetail: null,
      alternativeChosen: null,
      keyid: caller.keyid,
      agentName: caller.agentName,
      trustTier: caller.trustTier,
      intent,
      completeness: completeness(intent, required),
      completedSteps: [],
      stepData: {},
      revision: 0,
      createdAt: iso(now),
      updatedAt: iso(now),
      expiresAt: iso(plus(now, def.ttl_seconds)),
      endedAt: null,
    },
  };
}

/* ----------------------------------------------------------------- expiry */

export function isExpired(state: JourneyState, now: Date): boolean {
  return state.status === "active" && now.getTime() > Date.parse(state.expiresAt);
}

/** The state as it should be read now: an idle active journey is abandoned.
 * Lazy on purpose, so no cron job is needed. */
export function expire(state: JourneyState, now: Date): JourneyState {
  if (!isExpired(state, now)) return state;
  return {
    ...state,
    status: "abandoned",
    endReason: "idle-timeout",
    endedAt: state.expiresAt,
    updatedAt: iso(now),
    revision: state.revision + 1,
  };
}

/* -------------------------------------------------------- shared guards */

export function guardAccess(state: JourneyState, caller: Caller, now: Date): Rejection | null {
  if (state.keyid && caller.keyid !== state.keyid) {
    return reject(403, "wrong-agent", "This journey belongs to another agent",
      "The journey was started by a signed agent, and every later call must be signed with that same key.");
  }
  if (isExpired(state, now) || state.status === "abandoned") {
    return reject(410, "journey-expired", "Journey expired",
      `The journey was idle past ${state.expiresAt}. Start a new one.`);
  }
  if (state.status !== "active") {
    return reject(409, "journey-closed", "Journey already ended",
      `This journey ended with status "${state.status}"${state.endReason ? ` (${state.endReason})` : ""}. Start a new one.`);
  }
  return null;
}

/* ------------------------------------------------------------------- steps */

export interface StepPlan {
  ok: true;
  step: string;
  fields: Record<string, unknown>;
  /** The step was already completed; return its result without changing anything. */
  repeated: boolean;
  /** Run the user-binding adapter before applyStep(). */
  needsUserBinding: boolean;
}

export function prepareStep(
  def: JourneyDefinition,
  state: JourneyState,
  stepName: string,
  body: unknown,
  caller: Caller,
  now: Date,
): StepPlan | Rejection {
  const step = def.steps[stepName];
  if (!step) {
    return reject(404, "step-unknown", "No such step",
      `Journey "${def.id}" has no step "${stepName}". Steps: ${Object.keys(def.steps).join(", ")}.`);
  }

  const denied = guardAccess(state, caller, now);
  if (denied) return denied;

  if (state.completedSteps.includes(stepName) && !step.repeatable) {
    return { ok: true, step: stepName, fields: {}, repeated: true, needsUserBinding: false };
  }

  const missingSteps = step.requires.filter((r) => !state.completedSteps.includes(r));
  if (missingSteps.length) {
    return reject(409, "step-out-of-order", `Step "${stepName}" requires steps that are not completed yet`,
      `Complete ${missingSteps.map((s) => `"${s}"`).join(" and ")} first.`, { missingSteps });
  }

  const b = isPlainObject(body) ? body : {};
  if (step.require_human_present) {
    const present = typeof b.human_present === "boolean" ? b.human_present : state.intent.human_present;
    if (present !== true) {
      return reject(403, "human-presence-required", "A human must be present for this step",
        `Step "${stepName}" is only accepted while the user is present. Send "human_present": true with this call once they are.`);
    }
  }

  const fields = isPlainObject(b.fields) ? b.fields : {};
  const problems = validate(fields, step.fields, "fields");
  if (problems.length) {
    const missing = problems.some((p) => p.problem === "missing");
    return reject(422, missing ? "fields-missing" : "fields-invalid",
      missing ? `Step "${stepName}" needs more information` : `Step "${stepName}" has invalid fields`,
      "Fix the listed fields and send this step again. The journey is unchanged.", { problems });
  }

  return { ok: true, step: stepName, fields, repeated: false, needsUserBinding: !!step.user_binding };
}

export interface StepOutcome {
  state: JourneyState;
  repeated: boolean;
  result: unknown;
  /** Set when this step ended the journey. */
  ended: { status: "achieved" | "not_achieved"; reason: string | null; message: string | null } | null;
}

/** What a Worker-side step handler computed: the result for the agent, and
 * extra values to log beside the step's `log: true` fields. */
export interface Computed {
  result: unknown;
  log?: Record<string, unknown>;
}

export function applyStep(def: JourneyDefinition, state: JourneyState, plan: StepPlan, now: Date, computed?: Computed): StepOutcome {
  const step = def.steps[plan.step];
  if (plan.repeated) return { state, repeated: true, result: step.result ?? null, ended: null };

  const logged: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(step.fields.properties)) {
    if (schema.log && !schema.sensitive && name in plan.fields) logged[name] = plan.fields[name];
  }
  Object.assign(logged, computed?.log ?? {});

  const completedSteps = state.completedSteps.includes(plan.step)
    ? state.completedSteps
    : [...state.completedSteps, plan.step];

  let next: JourneyState = {
    ...state,
    completedSteps,
    // A repeat updates what the step logged before: fields it sends again
    // replace the earlier values, fields it leaves out keep them.
    stepData: { ...state.stepData, [plan.step]: { ...(state.stepData[plan.step] ?? {}), ...logged } },
    updatedAt: iso(now),
    expiresAt: iso(plus(now, def.ttl_seconds)),
    revision: state.revision + 1,
  };

  let ended: StepOutcome["ended"] = null;
  const rule = (step.end_if ?? []).find((r) => matches(r, plan.fields[r.field]));
  if (rule) {
    next = { ...next, status: "not_achieved", endReason: rule.reason, endedAt: iso(now) };
    ended = { status: "not_achieved", reason: rule.reason, message: rule.message ?? null };
  } else if (step.terminal) {
    next = { ...next, status: "achieved", endReason: null, endedAt: iso(now) };
    ended = { status: "achieved", reason: null, message: null };
  }

  const result = computed ? computed.result : (step.result ?? null);
  return { state: next, repeated: false, result: rule ? null : result, ended };
}

function matches(rule: EndRule, v: unknown): boolean {
  if (v === undefined) return false;
  const x = rule.value as never;
  switch (rule.op) {
    case "lt": return (v as number) < x;
    case "lte": return (v as number) <= x;
    case "gt": return (v as number) > x;
    case "gte": return (v as number) >= x;
    case "eq": return v === x;
    case "neq": return v !== x;
    case "in": return Array.isArray(x) && (x as unknown[]).includes(v);
    case "not_in": return Array.isArray(x) && !(x as unknown[]).includes(v);
  }
}

/* ------------------------------------------------------------------ cancel */

export type CancelResult = { ok: true; state: JourneyState } | Rejection;

export function cancel(state: JourneyState, body: unknown, caller: Caller, now: Date, def?: JourneyDefinition): CancelResult {
  const denied = guardAccess(state, caller, now);
  if (denied) return denied;

  const b = isPlainObject(body) ? body : {};
  const extra = def?.cancel?.fields.properties ?? {};
  const problems = validate(b, cancelSchema(def));
  if (problems.length) {
    const optional = ["detail", "alternative_chosen", ...Object.keys(extra)].map((f) => `"${f}"`).join(", ");
    return reject(422, "cancel-reason-invalid", "Cancel needs a reason",
      `Send {"reason": one of ${CANCEL_REASONS.join(", ")}}, optionally with ${optional}.`,
      { problems });
  }

  const logged: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(extra)) {
    if (schema.log && name in b) logged[name] = b[name];
  }

  return {
    ok: true,
    state: {
      ...state,
      ...(Object.keys(logged).length ? { stepData: { ...state.stepData, cancel: logged } } : {}),
      status: "cancelled",
      endReason: b.reason as string,
      endDetail: (b.detail as string | undefined) ?? null,
      alternativeChosen: (b.alternative_chosen as string | undefined) ?? null,
      endedAt: iso(now),
      updatedAt: iso(now),
      revision: state.revision + 1,
    },
  };
}

/** The cancel body: the built-in fields plus the definition's `cancel.fields`. */
export function cancelSchema(def?: JourneyDefinition): FieldSchema {
  return {
    type: "object",
    required: ["reason"],
    properties: {
      reason: { type: "string", enum: [...CANCEL_REASONS] },
      detail: { type: "string", maxLength: 500 },
      alternative_chosen: { type: "string", maxLength: 200 },
      ...(def?.cancel?.fields.properties ?? {}),
    },
  };
}

/* --------------------------------------------------------------- next steps */

export function nextSteps(def: JourneyDefinition, state: JourneyState): NextStep[] {
  if (state.status !== "active") return [];
  return topoOrder(def)
    .filter((n) => !state.completedSteps.includes(n) || def.steps[n].repeatable)
    .filter((n) => def.steps[n].requires.every((r) => state.completedSteps.includes(r)))
    .map((n) => {
      const s = def.steps[n];
      return {
        step: n,
        title: s.title,
        description: s.description,
        fields: publicSchema(s.fields),
        require_human_present: !!s.require_human_present,
        user_binding: s.user_binding ?? null,
      };
    });
}
