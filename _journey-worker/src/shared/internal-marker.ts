// GENERATED from eleviq-lab/shared — do not edit here; run scripts/sync-shared.mjs
/**
 * ElevIQ internal-traffic marker (requirements INT-1, INT-2, PRV-4).
 *
 * ElevIQ's test tools mark their own requests so the dashboards can hide them.
 * The per-client token is never sent: Cloudflare keeps every request header in
 * its tail and Workers Logs, readable by whoever runs the account. Instead the
 * header carries a short-lived proof made with the token:
 *
 *   X-ElevIQ-Internal: v1.<unix seconds>.<hex HMAC-SHA256(token, "v1.<unix seconds>.<host>")>
 *
 * - Bound to the host requested, so a proof seen on one site is useless on another.
 * - Accepted for MAX_AGE_S either side of the Worker's clock (covers clock skew),
 *   so a proof copied out of a log stops working within minutes.
 * - Within that window it can be replayed; the only effect would be hiding a few
 *   visits from the dashboard, which does not justify nonce storage.
 *
 * The Python tools build the same value (ai-agent-readiness/assets/tools/eleviq_internal.py).
 */

export const INTERNAL_HEADER = "X-ElevIQ-Internal";
export const MARKER_VERSION = "v1";
/** Seconds a proof is accepted either side of now. */
export const MAX_AGE_S = 600;

const enc = new TextEncoder();

function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function message(ts: number, host: string): Uint8Array {
  return enc.encode(`${MARKER_VERSION}.${ts}.${host.toLowerCase()}`);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Builds a header value. Used by tests and the smoke script; the Python tools have their own copy. */
export async function createInternalMarker(secret: string, host: string, now: Date = new Date()): Promise<string> {
  const ts = Math.floor(now.getTime() / 1000);
  const mac = await crypto.subtle.sign("HMAC", await key(secret, "sign"), message(ts, host));
  return `${MARKER_VERSION}.${ts}.${toHex(mac)}`;
}

/**
 * True when `header` is a fresh proof for `host` made with `secret`.
 * False for anything else — missing, malformed, expired, other host, wrong token.
 * The MAC comparison is crypto.subtle.verify, which is constant-time.
 */
export async function verifyInternalMarker(
  header: string | null | undefined,
  secret: string | null | undefined,
  host: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.trim().split(".");
  if (parts.length !== 3 || parts[0] !== MARKER_VERSION || !/^\d{1,12}$/.test(parts[1])) return false;
  const ts = Number(parts[1]);
  if (Math.abs(now.getTime() / 1000 - ts) > MAX_AGE_S) return false;
  const mac = fromHex(parts[2]);
  if (!mac) return false;
  try {
    return await crypto.subtle.verify("HMAC", await key(secret, "verify"), mac, message(ts, host));
  } catch {
    return false;
  }
}
