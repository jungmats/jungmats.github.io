/**
 * The intent envelope — the handshake every journey starts with.
 *
 * Three fields are required by the protocol itself; a definition can require
 * more (JourneyDefinition.intent.required). Everything else is optional and
 * counts towards the journey's completeness score, which the dashboard shows
 * per journey and per agent.
 *
 * Constraints and decision criteria are separate on purpose:
 *   constraints        hard filters — an option violating one is out
 *   decision_criteria  soft, ranked — choose between options that all pass
 * See AGENT-JOURNEY-PROTOCOL.md §5.1.
 */
import { INTENT_KINDS, type FieldSchema, type ObjectSchema } from "./types.ts";
import { isAbsent } from "./validate.ts";

export const PROTOCOL_REQUIRED = ["intent", "goal", "human_present"] as const;

export const ENVELOPE_SCHEMA: ObjectSchema = {
  type: "object",
  properties: {
    intent: {
      type: "string",
      enum: [...INTENT_KINDS],
      description: "Coarse category of what the agent is trying to do.",
    },
    goal: {
      type: "string",
      minLength: 10,
      maxLength: 500,
      description: "The job to be done, in the agent's words.",
    },
    human_present: {
      type: "boolean",
      description: "Whether a person is waiting on this task right now (AP2 vocabulary).",
    },
    request_summary: {
      type: "string",
      maxLength: 1000,
      description:
        "A paraphrase of what the user asked for. Never verbatim, never personal data such as names, emails or phone numbers.",
    },
    agent_session: {
      type: "string",
      maxLength: 128,
      description: "The agent's own task or session id, to correlate several journeys from one task.",
    },
    principal: {
      type: "object",
      description: "Who the agent acts for. Coarse on purpose: no names, no contact data.",
      properties: {
        type: { type: "string", enum: ["consumer", "business", "employee", "public-sector", "other"] },
        role: { type: "string", maxLength: 100 },
        industry: { type: "string", maxLength: 100 },
        organization_size: { type: "string", enum: ["1", "2-9", "10-49", "50-249", "250-999", "1000+"] },
        locale: { type: "string", maxLength: 20, description: "BCP 47 language tag, e.g. de-CH." },
        region: { type: "string", maxLength: 50, description: "Country or region code, e.g. CH." },
      },
    },
    journey_stage: {
      type: "string",
      enum: ["researching", "shortlisting", "deciding", "buying", "post-purchase"],
    },
    constraints: {
      type: "array",
      maxItems: 20,
      description: "Hard filters. An option that violates one is out.",
      items: {
        type: "object",
        properties: {
          field: { type: "string", maxLength: 60 },
          op: { type: "string", enum: ["lt", "lte", "gt", "gte", "eq", "neq", "in", "not_in", "contains"] },
          value: {},
          unit: { type: "string", maxLength: 20 },
          note: { type: "string", maxLength: 300, description: "Free text for a constraint that does not fit the structure." },
        },
      },
    },
    decision_criteria: {
      type: "array",
      maxItems: 20,
      description: "Soft, ranked criteria for choosing between options that pass every constraint.",
      items: {
        type: "object",
        required: ["criterion"],
        properties: {
          criterion: { type: "string", maxLength: 100 },
          direction: { type: "string", enum: ["minimize", "maximize", "prefer", "avoid"] },
          weight: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
    alternatives_considered: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 200 },
      description: "Other providers or options in the comparison set.",
    },
    authority: {
      type: "object",
      description: "What the agent may do on its own.",
      properties: {
        can_commit: { type: "boolean" },
        spend_limit: { type: "number", minimum: 0 },
        currency: { type: "string", maxLength: 3 },
        needs_approval_from: { type: "string", enum: ["user", "manager", "procurement", "none"] },
      },
    },
    expected_deliverable: {
      type: "string",
      maxLength: 200,
      description: "What the agent will hand back to its user, e.g. a shortlist or a booking.",
    },
    discovery_source: {
      type: "string",
      enum: ["web-search", "model-knowledge", "link", "marketplace", "direct", "other"],
      description: "How the agent found this site.",
    },
    agent_claim: {
      type: "object",
      description: "Self-reported agent product. Compared on the dashboard with the verified identity.",
      properties: {
        product: { type: "string", maxLength: 100 },
        platform: { type: "string", maxLength: 100 },
      },
    },
    parent_journey: {
      type: "string",
      maxLength: 200,
      description: "A journey on another site this one continues (cross-site journeys, not yet supported).",
    },
  },
};

/** The envelope schema a given journey asks for: protocol-required fields
 * plus the definition's own, and only that journey's allowed intent kinds. */
export function envelopeSchemaFor(allowed: readonly string[], extraRequired: string[] = []): ObjectSchema {
  const intentField: FieldSchema = { ...ENVELOPE_SCHEMA.properties.intent, enum: [...allowed] };
  return {
    ...ENVELOPE_SCHEMA,
    properties: { ...ENVELOPE_SCHEMA.properties, intent: intentField },
    required: [...new Set([...PROTOCOL_REQUIRED, ...extraRequired])],
  };
}

/** Share of optional envelope fields actually supplied, 0..1. */
export function completeness(envelope: Record<string, unknown>, required: string[]): number {
  const optional = Object.keys(ENVELOPE_SCHEMA.properties).filter(
    (k) => !required.includes(k) && k !== "parent_journey",
  );
  if (optional.length === 0) return 1;
  const supplied = optional.filter((k) => {
    const v = envelope[k];
    if (isAbsent(v)) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
  });
  return Math.round((supplied.length / optional.length) * 100) / 100;
}
