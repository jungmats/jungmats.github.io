/**
 * A deliberately small JSON Schema subset validator. Returns every problem it
 * finds rather than stopping at the first, because a refusal that lists all
 * missing fields at once saves the agent a round trip per field.
 *
 * Unknown fields are reported, not silently dropped: an agent sending
 * `budget` where `budget_eur` is expected should hear about it.
 */
import type { FieldProblem, FieldSchema } from "./types.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validate(value: unknown, schema: FieldSchema, path = ""): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const at = path || "(root)";

  if (schema.type && !matchesType(value, schema.type)) {
    problems.push({ field: at, problem: "wrong-type", expected: schema.type });
    return problems;
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    problems.push({ field: at, problem: "not-allowed", expected: `one of ${schema.enum.join(", ")}` });
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
      problems.push({ field: at, problem: "too-short", expected: `at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push({ field: at, problem: "too-long", expected: `at most ${schema.maxLength} characters` });
    }
    if (schema.format === "email" && !EMAIL.test(value)) {
      problems.push({ field: at, problem: "bad-format", expected: "an email address" });
    }
    if (schema.format === "date" && !(DATE.test(value) && !Number.isNaN(Date.parse(value)))) {
      problems.push({ field: at, problem: "bad-format", expected: "a date, YYYY-MM-DD" });
    }
    if (schema.format === "uri" && !isUri(value)) {
      problems.push({ field: at, problem: "bad-format", expected: "an absolute URI" });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      problems.push({ field: at, problem: "no-match", expected: `matching ${schema.pattern}` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push({ field: at, problem: "too-small", expected: `at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push({ field: at, problem: "too-large", expected: `at most ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push({ field: at, problem: "too-short", expected: `at least ${schema.minItems} items` });
    }
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      problems.push({ field: at, problem: "not-allowed", expected: "no duplicate items" });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push({ field: at, problem: "too-long", expected: `at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      value.forEach((item, i) => problems.push(...validate(item, schema.items!, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (isAbsent(obj[name])) {
        problems.push({ field: join(path, name), problem: "missing", expected: describe(schema.properties[name]) });
      }
    }
    for (const [name, v] of Object.entries(obj)) {
      const sub = schema.properties[name];
      if (!sub) {
        problems.push({ field: join(path, name), problem: "unknown-field" });
        continue;
      }
      if (isAbsent(v)) continue;
      problems.push(...validate(v, sub, join(path, name)));
    }
  }

  return problems;
}

export function isAbsent(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function matchesType(v: unknown, type: NonNullable<FieldSchema["type"]>): boolean {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return isPlainObject(v);
  }
}

function isUri(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

function join(path: string, name: string): string {
  return path ? `${path}.${name}` : name;
}

/** A short human-readable hint for a missing field. */
export function describe(schema: FieldSchema | undefined): string | undefined {
  if (!schema) return undefined;
  if (schema.enum) return `one of ${schema.enum.join(", ")}`;
  if (schema.format === "date") return "a date, YYYY-MM-DD";
  if (schema.format === "email") return "an email address";
  return schema.description ?? schema.type;
}

/** Strips the journey-specific extensions so a schema can be published as
 * plain JSON Schema (in a definition, OpenAPI, Arazzo or MCP tool). */
export function publicSchema(schema: FieldSchema): FieldSchema {
  const { log: _log, sensitive: _sensitive, properties, items, ...rest } = schema;
  const out: FieldSchema = { ...rest };
  if (properties) {
    out.properties = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, publicSchema(v)]));
  }
  if (items) out.items = publicSchema(items);
  return out;
}
