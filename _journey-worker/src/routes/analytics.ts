/**
 * The dashboard's data:
 *
 *   GET /api/analytics/summary?definition=&days=     funnel, drop-off, intents, competitors, agents
 *   GET /api/analytics/journeys?definition=&status=  recent journeys
 *   GET /api/analytics/journeys/{ref}                one journey: envelope, fields, timeline, lead
 *   GET /api/analytics/leads?days=                   emails left with step close
 *
 * Journeys are addressed by `ref` (a one-way hash), never by journey id: in
 * `identity: optional` mode the id is the only thing binding a journey, so
 * publishing it would let anyone hijack it. Behind Cloudflare Access, checked
 * in src/access.ts.
 *
 * Evidence (agent-analytics requirements JRN-3–JRN-9): every journey is
 * classified with the shared deriveVisitor (src/journey-evidence.ts).
 * `min=all|attested|verified` and `kinds=` apply to every card; ElevIQ's own
 * test journeys (internal = 1) are left out unless SHOW_INTERNAL="true".
 */
import { config } from "../config.ts";
import { DEFINITIONS } from "../journeys.ts";
import { json, problem } from "../http.ts";
import { topoOrder } from "../engine/definitions.ts";
import type { FieldSchema, JourneyDefinition } from "../engine/types.ts";
import type { Env } from "../env.ts";
import { LEGENDS } from "../shared/index.ts";
import {
  addToAgent,
  claimVsConfirmed,
  classifier,
  EVIDENCE_COLUMNS,
  evidenceOf,
  levelKey,
  parseFilters,
  passes,
  type AgentAgg,
  type EvidenceRow,
  type Filters,
} from "../journey-evidence.ts";

interface JRow extends EvidenceRow {
  id?: string;
  ref: string;
  status: string;
  end_reason: string | null;
  end_detail: string | null;
  alternative_chosen: string | null;
  keyid: string | null;
  agent_name: string | null;
  trust_tier: string | null;
  intent: string;
  intent_kind: string;
  human_present: number;
  completeness: number;
  completed_steps: string;
  step_data: string;
  reconstructed_prompt: string | null;
  transport: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  ended_at: string | null;
}

type Counts = Record<string, number>;
const bump = (c: Counts, k: unknown, n = 1) => {
  if (k === undefined || k === null || k === "") return;
  const key = String(k);
  c[key] = (c[key] ?? 0) + n;
};
const sorted = (c: Counts) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Status as it is now: an idle active journey reads as abandoned even
 * before anyone touches it again. */
function effectiveStatus(r: Pick<JRow, "status" | "expires_at">, now: number): string {
  return r.status === "active" && Date.parse(r.expires_at) < now ? "abandoned" : r.status;
}

function pickDefinition(url: URL): JourneyDefinition | Response {
  const id = url.searchParams.get("definition") ?? "site-visit";
  const def = DEFINITIONS.get(id);
  if (!def) return problem({ status: 404, reason: "definition-unknown", title: "No such journey", detail: `Known: ${[...DEFINITIONS.keys()].join(", ")}` });
  return def;
}

function since(url: URL): string {
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** 1-2-5 buckets that cover the data: 0–1k, 1k–2k, 2k–5k, … */
function bucketLabel(v: number): string {
  if (v <= 0) return "0";
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const steps = [1, 2, 5, 10];
  const lowerStep = [...steps].reverse().find((s) => s * mag <= v) ?? 1;
  const lower = lowerStep * mag;
  const upper = steps[steps.indexOf(lowerStep) + 1] * mag;
  const fmt = (n: number) => (n >= 1000 ? `${n / 1000}k` : String(n));
  return `${fmt(lower)}–${fmt(upper)}`;
}
const bucketOrder = (label: string) => {
  const m = /^([\d.]+)(k?)/.exec(label);
  return m ? Number(m[1]) * (m[2] ? 1000 : 1) : 0;
};

/** Evidence filters and the internal-journey rule for one request. */
function evidenceScope(env: Env, url: URL): { f: Filters; showInternal: boolean; internalSql: string } | Response {
  const parsed = parseFilters(url.searchParams);
  if (!parsed.ok) return problem({ status: 400, reason: "bad-request", title: "Invalid filter", detail: parsed.error });
  const showInternal = env.SHOW_INTERNAL === "true";
  return { f: parsed.filters, showInternal, internalSql: showInternal ? "" : " AND internal = 0" };
}

export async function handleSummary(env: Env, url: URL): Promise<Response> {
  const def = pickDefinition(url);
  if (def instanceof Response) return def;
  const scope = evidenceScope(env, url);
  if (scope instanceof Response) return scope;
  const { f, showInternal, internalSql } = scope;
  const classify = classifier();
  const from = since(url);
  const now = Date.now();
  const order = topoOrder(def);

  const [rowsRes, rejRes, clientRes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, ref, status, end_reason, alternative_chosen, keyid, agent_name, trust_tier, intent, intent_kind,
              human_present, completeness, completed_steps, step_data, transport, created_at, expires_at, ${EVIDENCE_COLUMNS}
       FROM journeys WHERE definition_id = ? AND created_at >= ?${internalSql} ORDER BY created_at DESC LIMIT ?`,
    ).bind(def.id, from, config.analytics.maxJourneys).all<JRow>(),
    // Rejections take the evidence of their journey; a refused start has none (JRN-4).
    env.DB.prepare(
      `SELECT e.step, e.reason, j.ref AS jref, j.intent, ${EVIDENCE_COLUMNS.split(", ").map((c) => `j.${c}`).join(", ")}, COUNT(*) AS n
       FROM journey_events e LEFT JOIN journeys j ON j.id = e.journey_id
       WHERE e.definition_id = ? AND e.ts >= ? AND e.outcome = 'rejected'${showInternal ? "" : " AND COALESCE(j.internal, 0) = 0"}
       GROUP BY e.step, e.reason, j.ref ORDER BY n DESC`,
    ).bind(def.id, from).all<EvidenceRow & { step: string; reason: string; jref: string | null; n: number }>(),
    // MCP client of journeys started before mcp_client was stored on the journey (src/mcp/server.ts).
    env.DB.prepare(
      `SELECT journey_id, json_extract(details, '$.mcp_client') AS client FROM journey_events
       WHERE definition_id = ? AND ts >= ? AND transport = 'mcp' AND step = 'start' AND outcome = 'accepted'`,
    ).bind(def.id, from).all<{ journey_id: string; client: string | null }>(),
  ]);
  const legacyClient = new Map((clientRes.results ?? []).map((r) => [r.journey_id, r.client]));
  const rows = (rowsRes.results ?? []).filter((r) => passes(classify(r), f));

  const byStatus: Counts = {};
  const endReasons: Record<string, Counts> = { not_achieved: {}, cancelled: {} };
  const stuckAt: Record<string, Counts> = {};
  const reached: Counts = {};
  const daily: Record<string, Counts> = {};
  const intentKinds: Counts = {}, stages: Counts = {}, principalTypes: Counts = {}, orgSizes: Counts = {},
    regions: Counts = {}, discovery: Counts = {}, constraintFields: Counts = {}, criteria: Counts = {},
    considered: Counts = {}, chosen: Counts = {}, transports: Counts = {}, mcpClients: Counts = {};
  const evidence: Counts = { verified: 0, attested: 0, declared: 0, none: 0 };
  const agentAgg = new Map<string, AgentAgg>();
  const claims = new Map<string, { declared: string; confirmed: string | null; level: string | null; contradicted: boolean; n: number }>();
  const fieldStats: Record<string, Record<string, Counts>> = {};
  const texts: Array<{ ref: string; created_at: string; step: string; field: string; text: string }> = [];
  let humanPresent = 0, completenessSum = 0;

  const loggedFields: Array<[string, string, FieldSchema]> = [];
  const fieldSets: Array<[string, Record<string, FieldSchema>]> = order.map((s) => [s, def.steps[s].fields.properties]);
  if (def.cancel) fieldSets.push(["cancel", def.cancel.fields.properties]);
  for (const [step, props] of fieldSets) {
    for (const [name, schema] of Object.entries(props)) {
      if (schema.log && !schema.sensitive) loggedFields.push([step, name, schema]);
    }
  }

  for (const r of rows) {
    const status = effectiveStatus(r, now);
    const done: string[] = JSON.parse(r.completed_steps);
    const intent = JSON.parse(r.intent) as Record<string, unknown>;
    const data = JSON.parse(r.step_data) as Record<string, Record<string, unknown>>;

    bump(byStatus, status);
    bump((daily[r.created_at.slice(0, 10)] ??= {}), status);
    for (const s of done) bump(reached, s);
    if (status === "not_achieved" || status === "cancelled") bump(endReasons[status], r.end_reason ?? "unknown");

    if (status !== "achieved") {
      // The step this journey was waiting on when it stopped (or is waiting on now).
      const waiting = order.find((s) => !done.includes(s)) ?? "(none)";
      const last = done[done.length - 1];
      const where = status === "not_achieved" && last ? last : waiting;
      bump((stuckAt[where] ??= {}), status === "cancelled" || status === "not_achieved" ? `${status}: ${r.end_reason}` : status);
    }

    const c = classify(r);
    evidence[levelKey(c)]++;
    addToAgent(agentAgg, c, r.completeness);
    const cv = claimVsConfirmed(r, c);
    if (cv) {
      const key = JSON.stringify([cv.declared, cv.confirmed, cv.contradicted]);
      const e = claims.get(key) ?? { ...cv, n: 0 };
      e.n++;
      claims.set(key, e);
    }
    if (r.human_present) humanPresent++;
    completenessSum += r.completeness;
    bump(transports, r.transport);
    if (r.transport === "mcp") bump(mcpClients, r.mcp_client ?? legacyClient.get(r.id ?? "") ?? "(not reported)");

    bump(intentKinds, r.intent_kind);
    bump(stages, intent.journey_stage);
    const p = obj(intent.principal);
    bump(principalTypes, p.type);
    bump(orgSizes, p.organization_size);
    bump(regions, p.region);
    bump(discovery, intent.discovery_source);
    for (const c of arr(intent.constraints)) {
      const o = obj(c);
      bump(constraintFields, o.field ? String(o.field).toLowerCase() : "(free text)");
    }
    for (const c of arr(intent.decision_criteria)) bump(criteria, String(obj(c).criterion ?? "").toLowerCase());
    for (const a of arr(intent.alternatives_considered)) bump(considered, String(a).toLowerCase());
    if (r.alternative_chosen) bump(chosen, r.alternative_chosen.toLowerCase());

    for (const [step, name, schema] of loggedFields) {
      const v = data[step]?.[name];
      if (v === undefined || v === null) continue;
      const stat = ((fieldStats[step] ??= {})[name] ??= {});
      if (schema.type === "number" || schema.type === "integer") bump(stat, bucketLabel(Number(v)));
      else if (Array.isArray(v)) v.forEach((x) => bump(stat, x));
      else if (schema.enum || schema.format === "date") bump(stat, schema.format === "date" ? String(v).slice(0, 7) : v);
      else {
        bump(stat, "(free text)");
        // Rows come newest first, so this keeps the latest answers.
        if (texts.length < MAX_TEXTS) texts.push({ ref: r.ref, created_at: r.created_at, step, field: name, text: String(v) });
      }
    }
  }

  const fields = loggedFields.map(([step, name, schema]) => {
    const counts = fieldStats[step]?.[name] ?? {};
    let values = sorted(counts);
    if (schema.type === "number" || schema.type === "integer") values = values.sort((a, b) => bucketOrder(a.key) - bucketOrder(b.key));
    if (schema.format === "date") values = values.sort((a, b) => a.key.localeCompare(b.key));
    return { step, field: name, kind: schema.type === "number" ? "buckets" : schema.format === "date" ? "months" : "counts", values };
  }).filter((f) => f.values.length && !(f.values.length === 1 && f.values[0].key === "(free text)"));

  const rejections: Counts = {};
  const rejectionStep: Record<string, { step: string; reason: string }> = {};
  for (const e of rejRes.results ?? []) {
    if (!passes(e.jref ? classify(e) : null, f)) continue;
    const k = `${e.step}\u0000${e.reason}`;
    rejections[k] = (rejections[k] ?? 0) + e.n;
    rejectionStep[k] = { step: e.step, reason: e.reason };
  }

  return json({
    definition: { id: def.id, title: def.title, steps: order },
    filters: { min: f.min, kinds: f.kinds, lang: f.lang },
    show_internal: showInternal,
    legend: LEGENDS[f.lang],
    window_from: from,
    journeys_counted: rows.length,
    capped: rows.length >= config.analytics.maxJourneys,
    totals: {
      started: rows.length,
      by_status: byStatus,
      evidence, // JRN-5: journeys per level
      human_present: humanPresent,
      avg_completeness: rows.length ? Math.round((completenessSum / rows.length) * 100) / 100 : null,
    },
    funnel: [{ step: "start", n: rows.length }, ...order.map((s) => ({ step: s, n: reached[s] ?? 0 }))],
    dropoff: order.map((s) => ({ step: s, outcomes: sorted(stuckAt[s] ?? {}) })).filter((d) => d.outcomes.length),
    rejections: sorted(rejections).map(({ key, n }) => ({ ...rejectionStep[key], n })),
    end_reasons: { not_achieved: sorted(endReasons.not_achieved), cancelled: sorted(endReasons.cancelled) },
    daily: Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c })),
    intent: {
      kinds: sorted(intentKinds),
      stages: sorted(stages),
      principal_types: sorted(principalTypes),
      organization_sizes: sorted(orgSizes),
      regions: sorted(regions),
      discovery_sources: sorted(discovery),
      constraint_fields: sorted(constraintFields),
      decision_criteria: sorted(criteria),
    },
    fields,
    texts,
    competition: { considered: sorted(considered), chosen_instead: sorted(chosen) },
    agents: {
      // JRN-6: name (null = unnamed, grouped per kind), kind(s), journeys per level, method(s), flags.
      by_agent: [...agentAgg.values()]
        .sort((a, b) => b.journeys - a.journeys || String(a.name).localeCompare(String(b.name)))
        .map(({ completenessSum: sum, ...a }) => ({ ...a, avg_completeness: Math.round((sum / a.journeys) * 100) / 100 })),
      // JRN-7: declared product vs. the identity a stronger signal confirmed.
      claims_vs_confirmed: [...claims.values()].sort((a, b) => b.n - a.n),
      transports: sorted(transports),
      mcp_clients: sorted(mcpClients),
    },
  });
}

export async function handleList(env: Env, url: URL): Promise<Response> {
  const def = pickDefinition(url);
  if (def instanceof Response) return def;
  const scope = evidenceScope(env, url);
  if (scope instanceof Response) return scope;
  const classify = classifier();
  const status = url.searchParams.get("status");
  const res = await env.DB.prepare(
    `SELECT ref, status, end_reason, keyid, agent_name, intent, intent_kind, completeness, completed_steps,
            transport, created_at, expires_at, ended_at, ${EVIDENCE_COLUMNS}
     FROM journeys WHERE definition_id = ? AND created_at >= ?${scope.internalSql} ORDER BY created_at DESC LIMIT ?`,
  ).bind(def.id, since(url), config.analytics.listLimit).all<JRow>();
  const now = Date.now();

  const journeys = (res.results ?? [])
    .filter((r) => passes(classify(r), scope.f))
    .map((r) => {
      const intent = JSON.parse(r.intent) as Record<string, unknown>;
      return {
        evidence: evidenceOf(classify(r)), // JRN-8
        ref: r.ref,
        created_at: r.created_at,
        status: effectiveStatus(r, now),
        end_reason: r.end_reason ?? (effectiveStatus(r, now) === "abandoned" ? "idle-timeout" : null),
        intent: r.intent_kind,
        goal: typeof intent.goal === "string" ? intent.goal.slice(0, 140) : null,
        completeness: r.completeness,
        completed_steps: JSON.parse(r.completed_steps),
        transport: r.transport,
      };
    })
    .filter((j) => !status || j.status === status);

  return json({ definition: def.id, steps: topoOrder(def), limit: config.analytics.listLimit, journeys });
}

export async function handleDetail(env: Env, ref: string): Promise<Response> {
  if (!/^[0-9a-f]{16}$/.test(ref)) return problem({ status: 404, reason: "journey-unknown", title: "No such journey", detail: "Unknown reference." });
  const row = await env.DB.prepare(`SELECT id, definition_id, * FROM journeys WHERE ref = ?`).bind(ref).first<JRow & { id: string; definition_id: string }>();
  if (!row) return problem({ status: 404, reason: "journey-unknown", title: "No such journey", detail: "Unknown reference." });

  const events = await env.DB.prepare(
    `SELECT ts, step, outcome, reason, status, details, transport FROM journey_events WHERE journey_id = ? ORDER BY ts ASC, id ASC`,
  ).bind(row.id).all<{ ts: string; step: string; outcome: string; reason: string | null; status: number; details: string | null; transport: string }>();

  const def = DEFINITIONS.get(row.definition_id);
  const status = effectiveStatus(row, Date.now());
  return json({
    ref: row.ref,
    definition: row.definition_id,
    steps: def ? topoOrder(def) : [],
    status,
    end_reason: row.end_reason ?? (status === "abandoned" ? "idle-timeout" : null),
    end_detail: row.end_detail,
    alternative_chosen: row.alternative_chosen,
    agent: row.keyid ? { name: row.agent_name, trust_tier: row.trust_tier, keyid: `${row.keyid.slice(0, 12)}…` } : null,
    evidence: evidenceOf(classifier()(row)), // JRN-8
    internal: !!row.internal,
    human_present: !!row.human_present,
    completeness: row.completeness,
    created_at: row.created_at,
    ended_at: row.ended_at ?? (status === "abandoned" ? row.expires_at : null),
    completed_steps: JSON.parse(row.completed_steps),
    intent: JSON.parse(row.intent),
    step_data: JSON.parse(row.step_data),
    reconstructed_prompt: row.reconstructed_prompt,
    reconstructed_prompt_note: "Reconstructed from the declared intent and logged fields with a fixed template. Not the user's words.",
    events: (events.results ?? []).map((e) => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    lead: await env.DB.prepare(`SELECT ${LEAD_COLUMNS} FROM leads WHERE journey_ref = ?`).bind(row.ref).first(),
  });
}

/** Free-text answers listed in the summary, newest first. */
const MAX_TEXTS = 50;

const LEAD_COLUMNS = "journey_ref, created_at, purge_after, purged_at, email, name, company, message, options, total, currency";

export async function handleLeads(env: Env, url: URL): Promise<Response> {
  const scope = evidenceScope(env, url);
  if (scope instanceof Response) return scope;
  const classify = classifier();
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  // Leads take the evidence of their journey (JRN-4); internal journeys' leads are left out (JRN-9).
  const cols = LEAD_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ");
  const rows = await env.DB.prepare(
    `SELECT ${cols}, j.intent, ${EVIDENCE_COLUMNS.split(", ").map((c) => `j.${c}`).join(", ")}
     FROM leads l LEFT JOIN journeys j ON j.ref = l.journey_ref
     WHERE l.created_at >= ?${scope.showInternal ? "" : " AND COALESCE(j.internal, 0) = 0"} ORDER BY l.created_at DESC LIMIT ?`,
  ).bind(from, config.analytics.listLimit).all<Record<string, unknown> & EvidenceRow>();
  return json({
    retention_days: config.leads.retentionDays,
    leads: (rows.results ?? [])
      .filter((r) => passes(classify(r), scope.f))
      .map((r) => {
        const c = classify(r);
        const out: Record<string, unknown> = {};
        for (const k of LEAD_COLUMNS.split(", ")) out[k] = r[k];
        return { ...out, options: JSON.parse(String(r.options)), evidence: evidenceOf(c) };
      }),
  });
}
