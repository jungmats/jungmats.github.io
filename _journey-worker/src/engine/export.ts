/**
 * Published descriptions derived from a journey definition — never
 * hand-written, so what is described and what is enforced cannot drift.
 *
 *   openApiFor()  OpenAPI 3.1: one operation per step, with that step's own
 *                 request schema, so tooling sees real per-step contracts.
 *   arazzoFor()   Arazzo 1.0.1 workflow over that OpenAPI document: the
 *                 steps in dependency order, success criteria, and an early
 *                 end when a business rule closes the journey.
 *
 * Arazzo describes a workflow; it cannot express the intent handshake as a
 * requirement or the server-side enforcement. Those live in the definition
 * and the engine. See AGENT-JOURNEY-PROTOCOL.md §3.
 */
import type { JourneyDefinition } from "./types.ts";
import { CANCEL_REASONS } from "./types.ts";
import { envelopeSchemaFor } from "./envelope.ts";
import { topoOrder } from "./definitions.ts";
import { publicSchema } from "./validate.ts";

const PROBLEM = { $ref: "#/components/schemas/Problem" };
const JOURNEY = { $ref: "#/components/schemas/Journey" };

const problemResponse = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: PROBLEM } },
});

export function openApiFor(def: JourneyDefinition, origin: string) {
  const journeyIdParam = {
    name: "journey_id",
    in: "path",
    required: true,
    schema: { type: "string", pattern: "^jrn_[a-z2-7]{26}$" },
  };
  const hasBinding = Object.values(def.steps).some((s) => s.user_binding);

  const paths: Record<string, unknown> = {
    "/api/journey/start": {
      post: {
        operationId: "startJourney",
        tags: ["journey"],
        summary: `Start "${def.title}" with an intent declaration`,
        description: "Opens a journey. Returns a journey_id that every later call must carry, and the steps available next.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["definition", "intent"],
                properties: {
                  definition: { type: "string", const: def.id },
                  intent: publicSchema(envelopeSchemaFor(def.intent.allowed, def.intent.required)),
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Journey started", content: { "application/json": { schema: JOURNEY } } },
          "401": problemResponse("Identity required"),
          "422": problemResponse("Intent missing or invalid"),
        },
      },
    },
    "/api/journey/{journey_id}": {
      get: {
        operationId: "getJourney",
        tags: ["journey"],
        summary: "Read a journey's current state",
        description: "Completed steps, next steps, status and expiry.",
        parameters: [journeyIdParam],
        responses: { "200": { description: "Current state", content: { "application/json": { schema: JOURNEY } } } },
      },
    },
    "/api/journey/{journey_id}/cancel": {
      post: {
        operationId: "cancelJourney",
        tags: ["journey"],
        summary: "End the journey with a reason",
        description: "Agents may just leave; an explicit cancel records why the journey ended.",
        parameters: [journeyIdParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["reason"],
                properties: {
                  reason: { type: "string", enum: [...CANCEL_REASONS] },
                  detail: { type: "string", maxLength: 500 },
                  alternative_chosen: { type: "string", maxLength: 200 },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Journey cancelled", content: { "application/json": { schema: JOURNEY } } },
          "409": problemResponse("Journey already ended"),
        },
      },
    },
  };

  if (hasBinding) {
    paths["/api/journey/{journey_id}/verification-code"] = {
      post: {
        operationId: "requestVerificationCode",
        tags: ["journey"],
        description: "The code proves the agent acts for the person behind that email.",
        summary: "Request a one-time code for the email the agent acts for",
        parameters: [journeyIdParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["acting_for"], properties: { acting_for: { type: "string", format: "email" } } },
            },
          },
        },
        responses: { "200": { description: "Code issued" } },
      },
    };
  }

  for (const name of topoOrder(def)) {
    const s = def.steps[name];
    paths[`/api/journey/{journey_id}/steps/${name}`] = {
      post: {
        operationId: `step_${name}`,
        tags: ["steps"],
        summary: s.title,
        description: [
          s.description,
          s.requires.length ? `Requires: ${s.requires.join(", ")}.` : "",
          s.require_human_present ? "Only accepted while a human is present." : "",
          s.terminal ? `Ends the journey as ${s.terminal}.` : "",
        ].filter(Boolean).join(" "),
        parameters: [journeyIdParam],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  fields: publicSchema(s.fields),
                  human_present: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Step accepted", content: { "application/json": { schema: JOURNEY } } },
          "403": problemResponse("Wrong agent, human presence or user binding"),
          "409": problemResponse("Step out of order, or journey closed"),
          "410": problemResponse("Journey expired"),
          "422": problemResponse("Fields missing or invalid"),
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: `${def.title} (Agent Journey)`,
      version: String(def.version),
      contact: { name: "ElevIQ", url: "https://eleviq.solutions" },
      description: `${def.description}\n\nGenerated from journey definition "${def.id}". Discovery: ${origin}/.well-known/agent-journeys`,
    },
    servers: [{ url: origin }],
    tags: [
      { name: "journey", description: "Start, read and cancel a journey" },
      { name: "steps", description: "The journey's steps, one operation each" },
    ],
    paths,
    components: {
      schemas: {
        Journey: {
          type: "object",
          properties: {
            journey_id: { type: "string" },
            definition: { type: "string" },
            status: { type: "string", enum: ["active", "achieved", "not_achieved", "cancelled", "abandoned"] },
            completed_steps: { type: "array", items: { type: "string" } },
            next_steps: { type: "array", items: { type: "object" } },
            expires_at: { type: "string", format: "date-time" },
            result: {},
          },
        },
        Problem: {
          type: "object",
          properties: {
            type: { type: "string" },
            title: { type: "string" },
            status: { type: "integer" },
            detail: { type: "string" },
            reason: { type: "string" },
            problems: { type: "array", items: { type: "object" } },
            next_steps: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  };
}

export function arazzoFor(def: JourneyDefinition, openApiUrl: string) {
  const order = topoOrder(def);
  const inputProps: Record<string, unknown> = {
    intent: publicSchema(envelopeSchemaFor(def.intent.allowed, def.intent.required)),
  };
  const inputRequired = ["intent"];
  for (const name of order) {
    inputProps[name] = publicSchema(def.steps[name].fields);
    if ((def.steps[name].fields.required ?? []).length) inputRequired.push(name);
  }

  const journeyId = { name: "journey_id", in: "path", value: "$steps.start.outputs.journeyId" };
  const steps: Array<Record<string, unknown>> = [
    {
      stepId: "start",
      description: "Declare intent and open the journey.",
      operationId: "startJourney",
      requestBody: {
        contentType: "application/json",
        payload: { definition: def.id, intent: "$inputs.intent" },
      },
      successCriteria: [{ condition: "$statusCode == 201" }],
      outputs: { journeyId: "$response.body#/journey_id" },
    },
  ];

  for (const name of order) {
    const s = def.steps[name];
    if (s.user_binding === "verification-code") {
      steps.push({
        stepId: `${name}_request_code`,
        description:
          "Request a one-time code for the user's email. The code reaches the user, not the agent: the user has to give it to the agent.",
        operationId: "requestVerificationCode",
        parameters: [journeyId],
        requestBody: {
          contentType: "application/json",
          payload: { acting_for: `$inputs.${name}.acting_for` },
        },
        successCriteria: [{ condition: "$statusCode == 200" }],
      });
    }
    const step: Record<string, unknown> = {
      stepId: name,
      description: s.description,
      operationId: `step_${name}`,
      parameters: [journeyId],
      requestBody: { contentType: "application/json", payload: { fields: `$inputs.${name}` } },
      successCriteria: [{ condition: "$statusCode == 200" }],
      outputs: { status: "$response.body#/status" },
    };
    if (s.end_if?.length) {
      step.onSuccess = [
        {
          name: "journey-ended-early",
          type: "end",
          criteria: [{ context: "$response.body", condition: "$[?@.status == 'not_achieved']", type: "jsonpath" }],
        },
      ];
    }
    steps.push(step);
  }

  const terminal = order.find((n) => def.steps[n].terminal) ?? order[order.length - 1];
  return {
    arazzo: "1.0.1",
    info: {
      title: def.title,
      summary: "Agent Journey workflow, generated from the journey definition.",
      version: String(def.version),
      description:
        "Generated from an Agent Journey definition. The server enforces step order, required fields and the intent declaration; this document describes the same journey for Arazzo-aware tooling.",
    },
    sourceDescriptions: [{ name: "journeyApi", url: openApiUrl, type: "openapi" }],
    workflows: [
      {
        workflowId: def.id,
        summary: def.title,
        description: def.description,
        inputs: { type: "object", required: inputRequired, properties: inputProps },
        steps,
        outputs: {
          journeyId: "$steps.start.outputs.journeyId",
          status: `$steps.${terminal}.outputs.status`,
        },
      },
    ],
  };
}
