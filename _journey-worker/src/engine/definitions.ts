/**
 * Journey definition linter. A broken definition must fail loudly at load
 * time, never halfway through a real agent's journey.
 */
import { CANCEL_BUILTIN_FIELDS, INTENT_KINDS, type JourneyDefinition } from "./types.ts";
import { ENVELOPE_SCHEMA } from "./envelope.ts";

const ID = /^[a-z][a-z0-9-]{1,62}$/;
const STEP_ID = /^[a-z][a-z0-9_]{0,40}$/;

export class DefinitionError extends Error {}

export function lintDefinition(def: JourneyDefinition): JourneyDefinition {
  const errs: string[] = [];
  const where = `journey "${def?.id ?? "?"}"`;

  if (!ID.test(def.id ?? "")) errs.push(`id must match ${ID}`);
  if (!Number.isInteger(def.version) || def.version < 1) errs.push("version must be a positive integer");
  if (!def.title) errs.push("title is required");
  if (def.identity !== "required" && def.identity !== "optional") errs.push('identity must be "required" or "optional"');
  if (!(def.ttl_seconds >= 1)) errs.push("ttl_seconds must be at least 1");

  for (const kind of def.intent?.allowed ?? []) {
    if (!(INTENT_KINDS as readonly string[]).includes(kind)) errs.push(`intent.allowed has unknown kind "${kind}"`);
  }
  if (!def.intent?.allowed?.length) errs.push("intent.allowed must list at least one intent kind");
  for (const f of def.intent?.required ?? []) {
    if (!(f in ENVELOPE_SCHEMA.properties)) errs.push(`intent.required names unknown envelope field "${f}"`);
  }

  const steps = def.steps ?? {};
  const names = Object.keys(steps);
  if (names.length === 0) errs.push("at least one step is required");

  let terminals = 0;
  for (const [name, step] of Object.entries(steps)) {
    if (!STEP_ID.test(name)) errs.push(`step "${name}": name must match ${STEP_ID}`);
    if (!step.title) errs.push(`step "${name}": title is required`);
    if (step.fields?.type !== "object" || typeof step.fields.properties !== "object") {
      errs.push(`step "${name}": fields must be an object schema with properties`);
    }
    for (const req of step.requires ?? []) {
      if (!(req in steps)) errs.push(`step "${name}" requires unknown step "${req}"`);
    }
    for (const f of step.fields?.required ?? []) {
      if (!(f in (step.fields?.properties ?? {}))) errs.push(`step "${name}": required field "${f}" is not defined`);
    }
    for (const rule of step.end_if ?? []) {
      if (!(rule.field in (step.fields?.properties ?? {}))) {
        errs.push(`step "${name}": end_if refers to unknown field "${rule.field}"`);
      }
      if (rule.status !== "not_achieved") errs.push(`step "${name}": end_if status must be "not_achieved"`);
      if (!rule.reason) errs.push(`step "${name}": end_if needs a reason code`);
    }
    for (const [fname, f] of Object.entries(step.fields?.properties ?? {})) {
      if (f.log && f.sensitive) errs.push(`step "${name}": field "${fname}" cannot be both log and sensitive`);
    }
    if (step.terminal && step.repeatable) errs.push(`step "${name}": a terminal step cannot be repeatable`);
    if (step.handler !== undefined && (typeof step.handler !== "string" || !step.handler)) errs.push(`step "${name}": handler must be a name`);
    if (step.terminal) terminals++;
  }
  if (names.length && terminals === 0) errs.push("at least one step must be terminal");

  if (def.cancel !== undefined) {
    const props = def.cancel?.fields?.properties;
    if (def.cancel?.fields?.type !== "object" || typeof props !== "object") {
      errs.push("cancel.fields must be an object schema with properties");
    } else {
      if (def.cancel.fields.required?.length) errs.push("cancel.fields cannot have required fields");
      for (const [fname, f] of Object.entries(props)) {
        if (CANCEL_BUILTIN_FIELDS.includes(fname)) errs.push(`cancel field "${fname}" is built in`);
        if (f.sensitive) errs.push(`cancel field "${fname}" cannot be sensitive`);
      }
    }
  }

  const cycle = findCycle(def);
  if (cycle) errs.push(`requires has a cycle: ${cycle.join(" -> ")}`);

  if (errs.length) throw new DefinitionError(`${where} is invalid:\n  - ${errs.join("\n  - ")}`);
  return def;
}

function findCycle(def: JourneyDefinition): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === "done") return null;
    if (state.get(n) === "visiting") return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, "visiting");
    stack.push(n);
    for (const r of def.steps[n]?.requires ?? []) {
      if (!(r in def.steps)) continue;
      const c = visit(r);
      if (c) return c;
    }
    stack.pop();
    state.set(n, "done");
    return null;
  };
  for (const n of Object.keys(def.steps ?? {})) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

/** Steps in dependency order (every step after the steps it requires),
 * stable with respect to the order they are written in the definition. */
export function topoOrder(def: JourneyDefinition): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const r of def.steps[n].requires) visit(r);
    out.push(n);
  };
  for (const n of Object.keys(def.steps)) visit(n);
  return out;
}
