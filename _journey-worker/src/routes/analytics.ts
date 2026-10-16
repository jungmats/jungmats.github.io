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
 */
import { config } from "../config";
import { DEFINITIONS } from "../journeys";
import { json, problem } from "../http";
import { topoOrder } from "../engine/definitions";
import type { FieldSchema, JourneyDefinition } from "../engine/types";
import type { Env } from "../env";

interface JRow {
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

export async function handleSummary(env: Env, url: URL): Promise<Response> {
  const def = pickDefinition(url);
  if (def instanceof Response) return def;
  const from = since(url);
  const now = Date.now();
  const order = topoOrder(def);

  const [rowsRes, rejRes] = await Promise.all([
    env.DB.prepare(
      `SELECT ref, status, end_reason, alternative_chosen, keyid, agent_name, trust_tier, intent, intent_kind,
              human_present, completeness, completed_steps, step_data, transport, created_at, expires_at
       FROM journeys WHERE definition_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(def.id, from, config.analytics.maxJourneys).all<JRow>(),
    env.DB.prepare(
      `SELECT step, reason, COUNT(*) AS n FROM journey_events
       WHERE definition_id = ? AND ts >= ? AND outcome = 'rejected'
       GROUP BY step, reason ORDER BY n DESC`,
    ).bind(def.id, from).all<{ step: string; reason: string; n: number }>(),
  ]);
  const rows = rowsRes.results ?? [];

  const byStatus: Counts = {};
  const endReasons: Record<string, Counts> = { not_achieved: {}, cancelled: {} };
  const stuckAt: Record<string, Counts> = {};
  const reached: Counts = {};
  const daily: Record<string, Counts> = {};
  const intentKinds: Counts = {}, stages: Counts = {}, principalTypes: Counts = {}, orgSizes: Counts = {},
    regions: Counts = {}, discovery: Counts = {}, constraintFields: Counts = {}, criteria: Counts = {},
    considered: Counts = {}, chosen: Counts = {}, agents: Counts = {}, claims: Counts = {}, transports: Counts = {};
  const fieldStats: Record<string, Record<string, Counts>> = {};
  const texts: Array<{ ref: string; created_at: string; step: string; field: string; text: string }> = [];
  let verified = 0, humanPresent = 0, completenessSum = 0;
  const completenessByAgent: Record<string, { sum: number; n: number }> = {};

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

    const agent = r.keyid ? r.agent_name ?? "verified (unnamed)" : "unverified";
    if (r.keyid) verified++;
    bump(agents, agent);
    const cba = (completenessByAgent[agent] ??= { sum: 0, n: 0 });
    cba.sum += r.completeness;
    cba.n++;
    if (r.human_present) humanPresent++;
    completenessSum += r.completeness;
    bump(transports, r.transport);

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
    const claim = obj(intent.agent_claim);
    if (claim.product) bump(claims, `${claim.product} → ${agent}`);

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

  return json({
    definition: { id: def.id, title: def.title, steps: order },
    window_from: from,
    journeys_counted: rows.length,
    capped: rows.length >= config.analytics.maxJourneys,
    totals: {
      started: rows.length,
      by_status: byStatus,
      verified,
      unverified: rows.length - verified,
      human_present: humanPresent,
      avg_completeness: rows.length ? Math.round((completenessSum / rows.length) * 100) / 100 : null,
    },
    funnel: [{ step: "start", n: rows.length }, ...order.map((s) => ({ step: s, n: reached[s] ?? 0 }))],
    dropoff: order.map((s) => ({ step: s, outcomes: sorted(stuckAt[s] ?? {}) })).filter((d) => d.outcomes.length),
    rejections: rejRes.results ?? [],
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
      by_agent: sorted(agents).map((a) => ({ ...a, avg_completeness: Math.round((completenessByAgent[a.key].sum / completenessByAgent[a.key].n) * 100) / 100 })),
      claims_vs_verified: sorted(claims),
      transports: sorted(transports),
    },
  });
}

export async function handleList(env: Env, url: URL): Promise<Response> {
  const def = pickDefinition(url);
  if (def instanceof Response) return def;
  const status = url.searchParams.get("status");
  const res = await env.DB.prepare(
    `SELECT ref, status, end_reason, keyid, agent_name, intent, intent_kind, completeness, completed_steps,
            transport, created_at, expires_at, ended_at
     FROM journeys WHERE definition_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(def.id, since(url), config.analytics.listLimit).all<JRow>();
  const now = Date.now();

  const journeys = (res.results ?? [])
    .map((r) => {
      const intent = JSON.parse(r.intent) as Record<string, unknown>;
      return {
        ref: r.ref,
        created_at: r.created_at,
        status: effectiveStatus(r, now),
        end_reason: r.end_reason ?? (effectiveStatus(r, now) === "abandoned" ? "idle-timeout" : null),
        agent: r.keyid ? r.agent_name : null,
        verified: !!r.keyid,
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
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT ${LEAD_COLUMNS} FROM leads WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?`,
  ).bind(from, config.analytics.listLimit).all<Record<string, unknown>>();
  return json({
    retention_days: config.leads.retentionDays,
    leads: (rows.results ?? []).map((r) => ({ ...r, options: JSON.parse(String(r.options)) })),
  });
}
