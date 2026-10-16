/**
 * Cloudflare Access check for /dashboard/ and /api/analytics/.
 *
 * Access protects the custom domain at the edge, but the same Worker also
 * answers on *.workers.dev (or any route added later) where Access does not
 * run. So the Worker verifies the Access token itself and fails closed:
 *
 *   ACCESS_AUD unset                      -> refused (unless ALLOW_UNAUTHENTICATED_ANALYTICS=1, local dev only)
 *   no Cf-Access-Jwt-Assertion header     -> refused
 *   token not signed by the team's keys,
 *   wrong audience/issuer, or expired     -> refused
 */
import { config } from "./config";
import type { Env } from "./env";

interface Jwk extends JsonWebKey { kid: string }

let keyCache: { at: number; keys: Jwk[] } | null = null;
const KEY_TTL_MS = 60 * 60 * 1000;

async function signingKeys(force = false): Promise<Jwk[]> {
  if (!force && keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.keys;
  const res = await fetch(`${config.access.teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs returned ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };
  keyCache = { at: Date.now(), keys };
  return keys;
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodeJson = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s)));

export type AccessResult = { ok: true; email: string | null } | { ok: false; detail: string };

export async function checkAccess(request: Request, env: Env): Promise<AccessResult> {
  if (!env.ACCESS_AUD) {
    if (env.ALLOW_UNAUTHENTICATED_ANALYTICS === "1") return { ok: true, email: null };
    return { ok: false, detail: "Access is not configured for this deployment (ACCESS_AUD unset)." };
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, detail: "No Cloudflare Access token. Open this page through its protected domain." };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, detail: "Malformed Access token." };
  let header: { kid?: string; alg?: string };
  let claims: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string };
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return { ok: false, detail: "Malformed Access token." };
  }
  if (header.alg !== "RS256") return { ok: false, detail: "Unexpected token algorithm." };

  let jwk = (await signingKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await signingKeys(true)).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, detail: "Token signed by an unknown key." };

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return { ok: false, detail: "Token signature does not verify." };

  const now = Date.now() / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(env.ACCESS_AUD)) return { ok: false, detail: "Token is for another Access application." };
  if (claims.iss !== config.access.teamDomain) return { ok: false, detail: "Token from another Access team." };
  if (!claims.exp || claims.exp < now) return { ok: false, detail: "Token expired. Reload the page." };
  if (claims.nbf && claims.nbf > now + 60) return { ok: false, detail: "Token not valid yet." };

  return { ok: true, email: claims.email ?? null };
}
