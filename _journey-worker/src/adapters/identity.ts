/**
 * Identity adapter: turns a request into the engine's `Caller`.
 *
 * v1: every caller is unsigned, and journeys are bound by their journey_id
 * alone (all definitions use `identity: optional`). Signature headers are
 * ignored rather than verified. Web Bot Auth verification can be added here
 * later, e.g. by porting booking/_gateway-worker/src/verify.js; the engine
 * only ever sees `Caller`.
 */
import type { Caller } from "../engine/types";

export type Identified =
  | { ok: true; caller: Caller }
  | { ok: false; reason: string; detail: string; keyid: string | null };

export const UNSIGNED: Caller = { keyid: null, agentName: null, trustTier: null };

export async function identify(_request: Request): Promise<Identified> {
  return { ok: true, caller: UNSIGNED };
}
