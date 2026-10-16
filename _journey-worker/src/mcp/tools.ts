/**
 * MCP tools, derived from the journey definitions at load time, never
 * hand-written: a new definition brings its tools with it.
 *
 *   start_<journey>     the intent envelope's fields, as arguments
 *   <journey>_<step>    journey_id + that step's fields
 *   cancel_<journey>    journey_id + reason, detail, alternative_chosen + the journey's cancel fields
 *   get_journey         journey_id
 *
 * Hyphens in ids become underscores. Definitions with identity "required" get
 * no tools: MCP clients do not sign their calls. Pure: no Worker APIs.
 */
import type { FieldSchema, JourneyDefinition } from "../engine/types.ts";
import { DefinitionError, topoOrder } from "../engine/definitions.ts";
import { cancelSchema } from "../engine/engine.ts";
import { envelopeSchemaFor, NOT_ASKED } from "../engine/envelope.ts";
import { publicSchema } from "../engine/validate.ts";

export type ToolRoute =
  | { op: "start"; definition: string }
  | { op: "step"; definition: string; step: string }
  | { op: "cancel"; definition: string }
  | { op: "get" };

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: FieldSchema;
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export interface ToolSet {
  tools: Tool[];
  routes: Map<string, ToolRoute>;
}

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

const slug = (id: string) => id.replace(/-/g, "_");
export const startTool = (definition: string) => `start_${slug(definition)}`;
export const stepTool = (definition: string, step: string) => `${slug(definition)}_${slug(step)}`;
export const cancelTool = (definition: string) => `cancel_${slug(definition)}`;
export const GET_TOOL = "get_journey";

const JOURNEY_ID: FieldSchema = {
  type: "string",
  pattern: "^jrn_[a-z2-7]{26}$",
  description: "The journey_id returned by the start tool.",
};

const HUMAN_PRESENT: FieldSchema = {
  type: "boolean",
  description: "True if your user is present right now. This step is only accepted while they are.",
};

function hints(title: string, readOnly: boolean, idempotent: boolean) {
  return { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false };
}

/** journey_id first, then the given object's properties. */
function withJourneyId(schema: FieldSchema, extra: Record<string, FieldSchema> = {}): FieldSchema {
  const pub = publicSchema(schema);
  return {
    type: "object",
    required: ["journey_id", ...(pub.required ?? [])],
    properties: { journey_id: JOURNEY_ID, ...(pub.properties ?? {}), ...extra },
  };
}

function toolsOf(def: JourneyDefinition): Array<[Tool, ToolRoute]> {
  const out: Array<[Tool, ToolRoute]> = [];
  const envelope = publicSchema(envelopeSchemaFor(def.intent.allowed, def.intent.required));
  // A tool's schema is a request for every field in it, so the fields agents aren't asked for stay out.
  const intent = { ...envelope, properties: Object.fromEntries(Object.entries(envelope.properties ?? {}).filter(([k]) => !NOT_ASKED.includes(k))) };
  out.push([{
    name: startTool(def.id),
    title: `Start: ${def.title}`,
    description: `${def.description}\n\nStarts the journey: declare why you came and what your user wants. Returns a journey_id for the journey's other tools, and which tool to call next.`,
    inputSchema: intent,
    annotations: hints(`Start: ${def.title}`, false, false),
  }, { op: "start", definition: def.id }]);

  for (const name of topoOrder(def)) {
    const s = def.steps[name];
    if ("journey_id" in s.fields.properties) {
      throw new DefinitionError(`journey "${def.id}" step "${name}": a field may not be named "journey_id" (MCP tools use it)`);
    }
    const needs = s.requires.length ? ` Needs ${s.requires.map((r) => `"${r}"`).join(" and ")} first (${s.requires.map((r) => stepTool(def.id, r)).join(", ")}).` : "";
    const again = s.repeatable ? " Can be called again." : "";
    out.push([{
      name: stepTool(def.id, name),
      title: s.title,
      description: `Step "${name}" of "${def.title}": ${s.description}${needs}${again}`,
      inputSchema: withJourneyId(s.fields, s.require_human_present ? { human_present: HUMAN_PRESENT } : {}),
      annotations: hints(s.title, false, false),
    }, { op: "step", definition: def.id, step: name }]);
  }

  out.push([{
    name: cancelTool(def.id),
    title: `Cancel: ${def.title}`,
    description: `Ends a "${def.title}" journey before its last step, with the reason why. Knowing why helps the site most.`,
    inputSchema: withJourneyId(cancelSchema(def)),
    annotations: hints(`Cancel: ${def.title}`, false, false),
  }, { op: "cancel", definition: def.id }]);
  return out;
}

export function toolsFor(definitions: Iterable<JourneyDefinition>): ToolSet {
  const pairs: Array<[Tool, ToolRoute]> = [[{
    name: GET_TOOL,
    title: "Read a journey",
    description: "A journey's current state: status, completed steps and the tools to call next.",
    inputSchema: { type: "object", required: ["journey_id"], properties: { journey_id: JOURNEY_ID } },
    annotations: hints("Read a journey", true, true),
  }, { op: "get" }]];
  for (const def of definitions) {
    if (def.identity === "required") continue;
    pairs.push(...toolsOf(def));
  }

  const routes = new Map<string, ToolRoute>();
  for (const [tool, route] of pairs) {
    if (!TOOL_NAME.test(tool.name)) throw new DefinitionError(`MCP tool name "${tool.name}" is invalid: letters, digits, _ and -, at most 64`);
    if (routes.has(tool.name)) throw new DefinitionError(`MCP tool name "${tool.name}" is used twice`);
    routes.set(tool.name, route);
  }
  return { tools: pairs.map(([t]) => t), routes };
}
