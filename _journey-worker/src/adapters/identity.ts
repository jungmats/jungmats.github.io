/**
 * Identity adapter: turns a request into the engine's `Caller`, plus the
 * evidence signals stored with a journey (requirements JRN-1, JRN-2).
 *
 * Web Bot Auth signatures are checked with the shared checker (src/shared/,
 * a generated copy of eleviq-lab/shared). A journey is never refused for its
 * signature (JRN-1): a failed or uncheckable signature is recorded as such,
 * and the caller proceeds unsigned. Only a valid signature fills `keyid`,
 * which then binds the journey to that key (engine.ts).
 */
import {
  createSignatureChecker,
  INTERNAL_HEADER,
  isBrowserUserAgent,
  matchUserAgent,
  verifyInternalMarker,
  type SigStatus,
} from "../shared/index.ts";
import type { Caller } from "../engine/types.ts";
import type { Env } from "../env.ts";

/** The start request's signals, stored on the journey (JRN-2; same rules as the site logger). */
export interface Evidence {
  sigStatus: SigStatus;
  sigAgent: string | null;
  cfCategory: string | null;
  uaMatch: string | null;
  /** LOG-2: only non-browser or attested User-Agents; "" for an empty one. */
  uaRaw: string | null;
  internal: 0 | 1;
}

export type Identified =
  | { ok: true; caller: Caller; evidence: Evidence }
  | { ok: false; reason: string; detail: string; keyid: string | null };

export const UNSIGNED: Caller = { keyid: null, agentName: null, trustTier: null };

const UA_RAW_MAX = 512;

// One checker per isolate, so its key-directory cache lives across requests (LOG-4).
let checker: ReturnType<typeof createSignatureChecker> | null = null;
let checkerAcceptsDemo: boolean | null = null;

function signatureChecker(env: Env) {
  const acceptDemo = env.ACCEPT_DEMO_SIGNATURES === "true";
  if (!checker || checkerAcceptsDemo !== acceptDemo) {
    checker = createSignatureChecker({ acceptDemo });
    checkerAcceptsDemo = acceptDemo;
  }
  return checker;
}

function rawUserAgent(ua: string | null, cfCategory: string | null): string | null {
  if (!ua) return "";
  if (isBrowserUserAgent(ua) && !cfCategory) return null;
  return ua.slice(0, UA_RAW_MAX);
}

export async function identify(request: Request, env: Env): Promise<Identified> {
  const cf = (request as Request & { cf?: { verifiedBotCategory?: string } }).cf;
  const cfCategory = cf?.verifiedBotCategory || null;
  const ua = request.headers.get("User-Agent");

  const [sig, internal] = await Promise.all([
    signatureChecker(env)
      .check(request)
      .catch(() => ({ sig_status: "unverifiable" as const, sig_agent: null, keyid: null, operator: null })),
    verifyInternalMarker(request.headers.get(INTERNAL_HEADER), env.ELEVIQ_INTERNAL_TOKEN, new URL(request.url).host),
  ]);

  const caller: Caller =
    sig.sig_status === "valid" && sig.keyid
      ? { keyid: sig.keyid, agentName: sig.operator?.product ?? sig.sig_agent, trustTier: null }
      : UNSIGNED;

  return {
    ok: true,
    caller,
    evidence: {
      sigStatus: sig.sig_status,
      sigAgent: sig.sig_agent,
      cfCategory,
      uaMatch: matchUserAgent(ua)?.name ?? null,
      uaRaw: rawUserAgent(ua, cfCategory),
      internal: internal ? 1 : 0,
    },
  };
}
