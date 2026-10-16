/**
 * How an agent finds journeys, and the descriptions derived from them:
 *
 *   GET /.well-known/agent-journeys          ElevIQ convention: every journey, with links
 *   GET /.well-known/api-catalog             RFC 9727 linkset pointing at the OpenAPI docs
 *   GET /journeys/{id}                       the definition, public view
 *   GET /journeys/{id}/openapi.json          derived OpenAPI 3.1
 *   GET /journeys/{id}/arazzo.json           derived Arazzo 1.0.1 workflow
 */
import { DEFINITIONS } from "../journeys";
import { json, problem } from "../http";
import { config } from "../config";
import { envelopeSchemaFor } from "../engine/envelope";
import { publicSchema } from "../engine/validate";
import { topoOrder } from "../engine/definitions";
import { arazzoFor, openApiFor } from "../engine/export";
import type { JourneyDefinition } from "../engine/types";

export const PROTOCOL = "agent-journey/0.1";

const startExample = (def: JourneyDefinition) => ({
  definition: def.id,
  intent: {
    intent: def.intent.allowed[0],
    goal: "What the user is trying to achieve, in a sentence",
    human_present: true,
    request_summary: "A paraphrase of what the user asked for, without personal data",
  },
});

export function handleWellKnown(origin: string): Response {
  return json({
    protocol: PROTOCOL,
    note: "Agent Journey Protocol: an ElevIQ convention, not a ratified standard.",
    docs: config.site,
    how_it_works:
      "POST to a journey's start link with an intent declaration. You get a journey_id and the next steps. Each step is a POST that must follow the steps it requires and carry the fields it asks for. Every refusal says what to do next.",
    journeys: [...DEFINITIONS.values()].map((def) => ({
      id: def.id,
      version: def.version,
      title: def.title,
      description: def.description,
      identity: def.identity,
      intent_kinds: def.intent.allowed,
      steps: topoOrder(def),
      definition: `${origin}/journeys/${def.id}`,
      openapi: `${origin}/journeys/${def.id}/openapi.json`,
      arazzo: `${origin}/journeys/${def.id}/arazzo.json`,
      start: { method: "POST", href: `${origin}/api/journey/start`, body_example: startExample(def) },
    })),
  });
}

export function handleApiCatalog(origin: string): Response {
  const body = {
    linkset: [
      {
        anchor: `${origin}/api/journey`,
        "service-desc": [...DEFINITIONS.keys()].map((id) => ({
          href: `${origin}/journeys/${id}/openapi.json`,
          type: "application/openapi+json",
        })),
        "service-doc": [{ href: config.site, type: "text/html" }],
        describedby: [{ href: `${origin}/.well-known/agent-journeys`, type: "application/json" }],
      },
    ],
  };
  return json(body, 200, {
    "content-type": 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  });
}

export function handleDefinition(id: string, origin: string, variant: "definition" | "openapi" | "arazzo"): Response {
  const def = DEFINITIONS.get(id);
  if (!def) {
    return problem({ status: 404, reason: "definition-unknown", title: "No such journey", detail: `Known journeys: ${[...DEFINITIONS.keys()].join(", ")}.` });
  }
  if (variant === "openapi") return json(openApiFor(def, origin));
  if (variant === "arazzo") return json(arazzoFor(def, `${origin}/journeys/${def.id}/openapi.json`));

  return json({
    protocol: PROTOCOL,
    id: def.id,
    version: def.version,
    title: def.title,
    description: def.description,
    identity: def.identity,
    idle_timeout_seconds: def.ttl_seconds,
    intent: publicSchema(envelopeSchemaFor(def.intent.allowed, def.intent.required)),
    steps: Object.fromEntries(
      topoOrder(def).map((name) => {
        const s = def.steps[name];
        return [name, {
          title: s.title,
          description: s.description,
          requires: s.requires,
          fields: publicSchema(s.fields),
          require_human_present: !!s.require_human_present,
          user_binding: s.user_binding ?? null,
          terminal: s.terminal ?? null,
          ends_journey_if: (s.end_if ?? []).map(({ field, op, value, reason }) => ({ field, op, value, reason })),
        }];
      }),
    ),
    start: { method: "POST", href: `${origin}/api/journey/start`, body_example: startExample(def) },
    links: {
      openapi: `${origin}/journeys/${def.id}/openapi.json`,
      arazzo: `${origin}/journeys/${def.id}/arazzo.json`,
    },
  });
}
