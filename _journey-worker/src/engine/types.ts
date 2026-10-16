/**
 * Agent Journey Protocol — core types.
 *
 * Everything in src/engine/ is pure: no I/O, no Worker APIs, no imports from
 * outside this folder. That is what lets it run under `node --test` and move
 * unchanged into the customer module. Imports use explicit `.ts` extensions
 * because Node's built-in type stripping requires them.
 */

/** The JSON Schema subset the validator understands. `log` and `sensitive`
 * are journey-specific extensions, stripped before any schema is published. */
export interface FieldSchema {
  type?: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  enum?: Array<string | number | boolean>;
  format?: "email" | "date" | "uri";
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: string[];
  examples?: unknown[];
  /** Store this field's value in the journey record (and show it on the dashboard). */
  log?: boolean;
  /** Never echo, store or log this value, not even its shape. */
  sensitive?: boolean;
}

export interface ObjectSchema extends FieldSchema {
  type: "object";
  properties: Record<string, FieldSchema>;
  required?: string[];
}

export type EndOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq" | "in" | "not_in";

/** A business rule that ends the journey when a step's field matches. */
export interface EndRule {
  field: string;
  op: EndOp;
  value: unknown;
  status: "not_achieved";
  reason: string;
  /** Shown to the agent, so it can tell its user why. */
  message?: string;
}

export interface StepDefinition {
  title: string;
  description: string;
  requires: string[];
  fields: ObjectSchema;
  /** The step is only accepted while a human is present. */
  require_human_present?: boolean;
  /** The step additionally proves the agent acts for a specific person. */
  user_binding?: "verification-code";
  end_if?: EndRule[];
  /** Reaching this step ends the journey with this status. */
  terminal?: "achieved";
  /** Static result returned on success, when no `handler` computes one. */
  result?: unknown;
  /** Name of a Worker-side handler (src/handlers.ts) that computes the result
   * or performs the step's side effect. Runs after every engine check has
   * passed; if it fails, the step is refused and the journey is unchanged. */
  handler?: string;
  /** The step may be sent again after it was completed, e.g. to re-estimate
   * with other options. Each accepted repeat updates the step's logged data. */
  repeatable?: boolean;
}

export interface JourneyDefinition {
  id: string;
  version: number;
  title: string;
  description: string;
  identity: "required" | "optional";
  /** Idle timeout: each accepted call pushes the expiry this far out again. */
  ttl_seconds: number;
  intent: {
    /** Which envelope `intent` values this journey accepts. */
    allowed: IntentKind[];
    /** Envelope fields required on top of the protocol's own required ones. */
    required?: string[];
  };
  steps: Record<string, StepDefinition>;
  /** Returned with the start response: what the agent gets for starting. */
  welcome?: unknown;
  /** Extra optional fields the protocol's cancel accepts for this journey,
   * beside reason, detail and alternative_chosen. `log: true` fields are kept
   * in the journey record under "cancel"; none may be required or sensitive. */
  cancel?: { fields: ObjectSchema };
}

export const INTENT_KINDS = ["discover", "compare", "qualify", "verify", "transact", "support"] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export type JourneyStatus = "active" | "achieved" | "not_achieved" | "cancelled" | "abandoned";

export interface Caller {
  /** Web Bot Auth key thumbprint, or null for an unsigned agent. */
  keyid: string | null;
  agentName: string | null;
  trustTier: string | null;
}

export interface JourneyState {
  id: string;
  definitionId: string;
  definitionVersion: number;
  status: JourneyStatus;
  endReason: string | null;
  endDetail: string | null;
  alternativeChosen: string | null;
  keyid: string | null;
  agentName: string | null;
  trustTier: string | null;
  intent: Record<string, unknown>;
  completeness: number;
  completedSteps: string[];
  /** Per step: only the fields marked `log: true`. */
  stepData: Record<string, Record<string, unknown>>;
  /** Optimistic-concurrency counter; the store refuses a stale write. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  endedAt: string | null;
}

export type RejectionReason =
  | "definition-unknown"
  | "identity-required"
  | "identity-invalid"
  | "concurrent-update"
  | "bad-request"
  | "wrong-agent"
  | "human-presence-required"
  | "user-binding-failed"
  | "journey-unknown"
  | "step-unknown"
  | "step-out-of-order"
  | "journey-closed"
  | "journey-expired"
  | "intent-missing"
  | "intent-invalid"
  | "fields-missing"
  | "fields-invalid"
  | "cancel-reason-invalid"
  | "upstream-failed";

export interface FieldProblem {
  field: string;
  problem: "missing" | "wrong-type" | "not-allowed" | "bad-format" | "too-small" | "too-large" | "too-short" | "too-long" | "no-match" | "unknown-field";
  expected?: string;
}

export interface Rejection {
  ok: false;
  status: number;
  reason: RejectionReason;
  title: string;
  detail: string;
  problems?: FieldProblem[];
  missingSteps?: string[];
}

export interface NextStep {
  step: string;
  title: string;
  description: string;
  fields: FieldSchema;
  require_human_present: boolean;
  user_binding: string | null;
}

export const CANCEL_REASONS = [
  "user-declined",
  "constraint-unmet",
  "price-too-high",
  "found-alternative",
  "missing-information",
  "user-unavailable",
  "not-now",
  "got-what-needed",
  "continued-elsewhere",
  "consent-withheld",
  "agent-error",
  "other",
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** The fields every cancel accepts; a definition's `cancel.fields` adds to them. */
export const CANCEL_BUILTIN_FIELDS: readonly string[] = ["reason", "detail", "alternative_chosen"];
