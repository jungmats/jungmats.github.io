/**
 * D1 persistence for journey state. Writes are guarded by `revision`, so two
 * concurrent calls on one journey cannot both win: the second gets
 * `concurrent-update` and can simply retry.
 */
import type { Env } from "./env";
import type { JourneyState } from "./engine/types";
import { reconstructPrompt } from "./engine/prompt";

interface Row {
  id: string;
  ref: string;
  definition_id: string;
  definition_version: number;
  status: JourneyState["status"];
  end_reason: string | null;
  end_detail: string | null;
  alternative_chosen: string | null;
  keyid: string | null;
  agent_name: string | null;
  trust_tier: string | null;
  intent: string;
  completeness: number;
  completed_steps: string;
  step_data: string;
  revision: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  ended_at: string | null;
}

export const JOURNEY_ID = /^jrn_[a-z2-7]{26}$/;

/** "jrn_" + 128 random bits in lowercase base32 (26 characters). */
export function newJourneyId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return `jrn_${out}`;
}

/** The dashboard's public handle for a journey. The journey id itself is a
 * credential (in `identity: optional` mode it is all that binds a journey),
 * so it is never shown; this one-way reference is. */
export async function refFor(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toState(r: Row): JourneyState {
  return {
    id: r.id,
    definitionId: r.definition_id,
    definitionVersion: r.definition_version,
    status: r.status,
    endReason: r.end_reason,
    endDetail: r.end_detail,
    alternativeChosen: r.alternative_chosen,
    keyid: r.keyid,
    agentName: r.agent_name,
    trustTier: r.trust_tier,
    intent: JSON.parse(r.intent),
    completeness: r.completeness,
    completedSteps: JSON.parse(r.completed_steps),
    stepData: JSON.parse(r.step_data),
    revision: r.revision,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    endedAt: r.ended_at,
  };
}

export async function getJourney(env: Env, id: string): Promise<JourneyState | null> {
  if (!JOURNEY_ID.test(id)) return null;
  const row = await env.DB.prepare("SELECT * FROM journeys WHERE id = ?").bind(id).first<Row>();
  return row ? toState(row) : null;
}

export async function insertJourney(
  env: Env,
  s: JourneyState,
  extra: { transport: "http" | "mcp"; traceparent: string | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO journeys (id, ref, definition_id, definition_version, status, end_reason, end_detail, alternative_chosen,
       keyid, agent_name, trust_tier, intent, intent_kind, human_present, completeness, completed_steps, step_data,
       reconstructed_prompt, transport, traceparent, revision, created_at, updated_at, expires_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      s.id, await refFor(s.id), s.definitionId, s.definitionVersion, s.status, s.endReason, s.endDetail,
      s.alternativeChosen, s.keyid, s.agentName, s.trustTier, JSON.stringify(s.intent), String(s.intent.intent),
      s.intent.human_present === true ? 1 : 0, s.completeness, JSON.stringify(s.completedSteps),
      JSON.stringify(s.stepData), reconstructPrompt(s.intent, s.stepData), extra.transport, extra.traceparent,
      s.revision, s.createdAt, s.updatedAt, s.expiresAt, s.endedAt,
    )
    .run();
}

/** Writes `next` only if the stored journey is still at `prevRevision`.
 * Returns false when another call got there first. */
export async function updateJourney(env: Env, next: JourneyState, prevRevision: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE journeys SET status = ?, end_reason = ?, end_detail = ?, alternative_chosen = ?, completed_steps = ?,
       step_data = ?, reconstructed_prompt = ?, human_present = ?, revision = ?, updated_at = ?, expires_at = ?, ended_at = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(
      next.status, next.endReason, next.endDetail, next.alternativeChosen, JSON.stringify(next.completedSteps),
      JSON.stringify(next.stepData), reconstructPrompt(next.intent, next.stepData),
      next.intent.human_present === true ? 1 : 0, next.revision, next.updatedAt, next.expiresAt, next.endedAt,
      next.id, prevRevision,
    )
    .run();
  return (res.meta.changes ?? 0) === 1;
}
