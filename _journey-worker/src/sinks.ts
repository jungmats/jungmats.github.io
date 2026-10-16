/**
 * Event sinks: one event per call attempt, accepted or rejected. Which sinks
 * run is configuration (src/config.ts), not code.
 *
 * Every write goes through ctx.waitUntil: logging can never delay or fail the
 * response an agent is waiting for.
 */
import type { Env } from "./env";
import { config } from "./config";

export interface JourneyEvent {
  journeyId: string | null;
  definitionId: string | null;
  step: string;
  outcome: "accepted" | "rejected";
  reason: string | null;
  status: number;
  /** Field names and missing steps only, never values. */
  details: Record<string, unknown> | null;
  keyid: string | null;
  transport: "http" | "mcp";
}

export function emit(env: Env, ctx: ExecutionContext, e: JourneyEvent): void {
  const ts = new Date().toISOString();

  if (config.sinks.d1) {
    const write = env.DB.prepare(
      `INSERT INTO journey_events (journey_id, definition_id, ts, step, outcome, reason, status, details, keyid, transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(e.journeyId, e.definitionId, ts, e.step, e.outcome, e.reason, e.status,
        e.details ? JSON.stringify(e.details) : null, e.keyid, e.transport)
      .run();
    ctx.waitUntil(write.catch((err) => console.error("journey event write failed:", err)));
  }

  const hook = config.sinks.webhook;
  if (hook.enabled && hook.url) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (env.JOURNEY_WEBHOOK_SECRET) headers.authorization = `Bearer ${env.JOURNEY_WEBHOOK_SECRET}`;
    const body = JSON.stringify({ type: "journey.event", ts, ...e });
    ctx.waitUntil(
      fetch(hook.url, { method: "POST", headers, body })
        .then((r) => { if (!r.ok) console.error(`journey webhook returned ${r.status}`); })
        .catch((err) => console.error("journey webhook failed:", err)),
    );
  }
}
