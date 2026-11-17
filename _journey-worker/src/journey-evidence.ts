/**
 * Evidence for journeys — pure, no D1 (requirements JRN-3–JRN-9).
 *
 * A journey row's stored start signals (identity.ts) plus its declared
 * `intent.agent_claim.product` and MCP client go through the shared
 * `deriveVisitor`, the same rules the visitor dashboard uses. Journeys
 * started before the signals existed (sig_status null) take the legacy path:
 * a claim gives Declared (journey-declared), an MCP client gives mcp-client.
 */
import { deriveVisitor, signalKey, type Kind, type Level, type VisitorClass, type VisitorSignals } from "./shared/index.ts";

export const KINDS: readonly Kind[] = ["people", "ai-assistant", "search", "ai-training", "other-bot", "unknown"];
export const LEVELS = ["verified", "attested", "declared", "none"] as const;
export const MIN_LEVELS = ["all", "attested", "verified"] as const;
export type MinLevel = (typeof MIN_LEVELS)[number];

/** Columns to SELECT for classification. */
export const EVIDENCE_COLUMNS = "sig_status, sig_agent, cf_bot_category, ua_match, ua_raw, mcp_client, internal";

export interface EvidenceRow {
  sig_status?: string | null;
  sig_agent?: string | null;
  cf_bot_category?: string | null;
  ua_match?: string | null;
  ua_raw?: string | null;
  mcp_client?: string | null;
  internal?: number | null;
  /** The intent envelope, JSON. */
  intent?: string | null;
}

export interface Filters {
  min: MinLevel;
  kinds: Kind[];
  lang: "en" | "fr";
}

export type ParseResult = { ok: true; filters: Filters } | { ok: false; error: string };

export function parseFilters(params: URLSearchParams): ParseResult {
  const min = (params.get("min") ?? "all") as MinLevel;
  if (!MIN_LEVELS.includes(min)) return { ok: false, error: `min must be one of ${MIN_LEVELS.join(", ")}` };
  let kinds = [...KINDS];
  const k = params.get("kinds");
  if (k) {
    const asked = k.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = asked.filter((x) => !KINDS.includes(x as Kind));
    if (bad.length) return { ok: false, error: `unknown kind(s) ${bad.join(", ")}; allowed: ${KINDS.join(", ")}` };
    kinds = KINDS.filter((x) => asked.includes(x));
  }
  const lang = params.get("lang") ?? "en";
  if (lang !== "en" && lang !== "fr") return { ok: false, error: "lang must be en or fr" };
  return { ok: true, filters: { min, kinds, lang } };
}

function claimOf(intentJson: string | null | undefined): string | null {
  if (!intentJson) return null;
  try {
    const claim = (JSON.parse(intentJson) as { agent_claim?: { product?: unknown } }).agent_claim;
    return typeof claim?.product === "string" && claim.product.trim() ? claim.product.trim().slice(0, 100) : null;
  } catch {
    return null;
  }
}

export function toSignals(r: EvidenceRow): VisitorSignals {
  return {
    sig_status: (r.sig_status ?? null) as VisitorSignals["sig_status"],
    sig_agent: r.sig_agent ?? null,
    cf_bot_category: r.cf_bot_category ?? null,
    ua_match: r.ua_match ?? null,
    ua_raw: r.ua_raw ?? null,
    internal: r.internal ?? 0,
    agent_claim: claimOf(r.intent),
    mcp_client: r.mcp_client ?? null,
  };
}

/** Memoised classification: one deriveVisitor call per distinct signal set. */
export function classifier() {
  const cache = new Map<string, VisitorClass>();
  return (r: EvidenceRow): VisitorClass => {
    const s = toSignals(r);
    const key = signalKey(s);
    let c = cache.get(key);
    if (!c) {
      c = deriveVisitor(s);
      cache.set(key, c);
    }
    return c;
  };
}

/** JRN-4: minimum evidence (DSH-2) and kinds (DSH-9). `null` = no journey (a refused start): no evidence. */
export function passes(c: VisitorClass | null, f: Filters): boolean {
  if (!c) return f.min === "all" && f.kinds.length === KINDS.length;
  if (!f.kinds.includes(c.kind)) return false;
  if (f.min === "verified") return c.level === "verified";
  if (f.min === "attested") return c.level === "verified" || c.level === "attested";
  return true;
}

export const levelKey = (c: VisitorClass): Level | "none" => c.level ?? "none";

/** The evidence fields a dashboard row carries (JRN-8). */
export function evidenceOf(c: VisitorClass) {
  return { kind: c.kind, level: c.level, method: c.method, name: c.name, flags: c.flags, notes: c.notes };
}

export interface AgentAgg {
  name: string | null;
  kinds: Kind[];
  journeys: number;
  levels: Record<Level | "none", number>;
  methods: string[];
  flags: { contradicted: number; "signature-invalid": number };
  completenessSum: number;
}

/** JRN-6: one row per agent name; journeys without a name are grouped per kind (name null). */
export function agentKey(c: VisitorClass): string {
  return c.name ? `n:${c.name}` : `k:${c.kind}`;
}

export function addToAgent(m: Map<string, AgentAgg>, c: VisitorClass, completeness: number) {
  const key = agentKey(c);
  const a = m.get(key) ?? {
    name: c.name,
    kinds: [],
    journeys: 0,
    levels: { verified: 0, attested: 0, declared: 0, none: 0 },
    methods: [],
    flags: { contradicted: 0, "signature-invalid": 0 },
    completenessSum: 0,
  };
  a.journeys++;
  a.completenessSum += completeness;
  a.levels[levelKey(c)]++;
  if (!a.kinds.includes(c.kind)) a.kinds.push(c.kind);
  if (c.method && !a.methods.includes(c.method)) a.methods.push(c.method);
  for (const f of c.flags) if (f === "contradicted" || f === "signature-invalid") a.flags[f]++;
  m.set(key, a);
}

/** JRN-7: what the agent declared vs. the identity a stronger signal confirmed. */
export function claimVsConfirmed(r: EvidenceRow, c: VisitorClass) {
  const declared = claimOf(r.intent);
  if (!declared) return null;
  const confirmed = c.level === "verified" || c.level === "attested" ? c.name : null;
  return { declared, confirmed, level: c.level === "verified" || c.level === "attested" ? c.level : null, contradicted: c.flags.includes("contradicted") };
}
