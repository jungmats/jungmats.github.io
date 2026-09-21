/**
 * Web Bot Auth verification (RFC 9421 HTTP Message Signatures, Ed25519) —
 * production port of the eleviq-lab Demo 1 pattern
 * (eleviq-lab/gateway/src/lib/verify.ts + registry.ts + external-directory.ts).
 *
 * Additive, not gating: most agents calling this gateway won't sign a
 * request, and booking has to keep working for them. A verified signature
 * only enriches the attribution already stamped on every write (see
 * attributionFrom in index.js) — it never blocks or changes the outcome.
 *
 * Two trust tiers, checked in order, same as the lab:
 *   1. own      — our own committed demo key (../keys/booking-agent.jwk.json),
 *                 checked locally, no network call. Published on purpose
 *                 (at /.well-known/http-message-signatures-directory on
 *                 eleviq.solutions) so the pipeline is self-testable; proves
 *                 nothing about a real agent's identity.
 *   2. registry — the Signature-Agent's origin is on our own hardcoded
 *      allow-list (REGISTRY below); if so, fetch THAT operator's own
 *      directory live (cached) and check the key against what it currently
 *      publishes. Never fetches a URL taken from the request — only ever
 *      an origin already in this fixed list.
 */
import { verify } from 'web-bot-auth';
import { verifierFromJWK } from 'web-bot-auth/crypto';
import ownKey from '../keys/booking-agent.jwk.json';

// Tier 2 trust — same curated allow-list as eleviq-lab/gateway/src/lib/registry.ts.
// Confirmed live 2026-09-11 (see that file's comment): chatgpt.com publishes a
// real directory. Adding another operator once they publish one is one line.
const REGISTRY = [{ origin: 'https://chatgpt.com', label: 'ChatGPT', operator: 'OpenAI' }];

const OWN_META = { name: 'ElevIQ booking gateway demo key', operator: 'ElevIQ', domain: 'eleviq.solutions' };

let ownVerifierPromise = null;
function ownVerifier() {
  if (!ownVerifierPromise) {
    const { d, ...pub } = ownKey;
    ownVerifierPromise = verifierFromJWK(pub);
  }
  return ownVerifierPromise;
}

const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 20_000;

// Per-isolate cache, not the Workers Cache API — same reasoning as the lab's
// external-directory.ts: caches.default is unreliable on *.workers.dev.
const directoryCache = new Map();

async function fetchDirectoryKeys(origin) {
  const cached = directoryCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.keys;

  let keys = null;
  try {
    const res = await fetch(origin + DIRECTORY_PATH, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) {
      const text = await res.text();
      if (text.length <= MAX_RESPONSE_BYTES) {
        const body = JSON.parse(text);
        keys = Array.isArray(body.keys) ? body.keys : [];
      }
    }
  } catch {
    // network/parse failure — fall through to stale cache, if any
  }
  keys = keys || cached?.keys || [];
  directoryCache.set(origin, { fetchedAt: Date.now(), keys });
  return keys;
}

async function fetchOperatorVerifier(origin, keyid) {
  const keys = await fetchDirectoryKeys(origin);
  const now = Math.floor(Date.now() / 1000);
  for (const jwk of keys) {
    if (typeof jwk.nbf === 'number' && now < jwk.nbf) continue;
    if (typeof jwk.exp === 'number' && now > jwk.exp) continue;
    try {
      const verifier = await verifierFromJWK(jwk);
      if (verifier.keyid === keyid) return verifier;
    } catch {
      continue; // not a usable key (wrong kty/crv, malformed) — skip it
    }
  }
  return null;
}

// Nonce replay protection — only runs once a NONCES KV binding exists (see
// wrangler.toml). Until then this is skipped, not enforced: a missing
// binding must never make a well-formed signature look like a failure.
async function claimNonce(env, nonce, ttlSeconds) {
  if (!env || !env.NONCES) return true;
  const existing = await env.NONCES.get(nonce);
  if (existing) return false;
  await env.NONCES.put(nonce, '1', { expirationTtl: Math.max(60, Math.ceil(ttlSeconds)) });
  return true;
}

/**
 * Checks a request's Signature/Signature-Input headers, if present.
 * Returns null when the request is unsigned — the normal case today —
 * which callers should treat as "nothing to add", not a failure.
 */
export async function checkSignedAgent(request, env) {
  if (!request.headers.get('Signature') || !request.headers.get('Signature-Input')) return null;

  let matchedTier = null;
  let matchedMeta = null;

  try {
    const result = await verify(request, {
      // Our own demo signer uses a 5 min window; observed real-world
      // operators (OpenAI's chatgpt.com) use up to 1 hour — match that
      // rather than reject legitimate Tier 2 traffic.
      maxAge: 3600,
      clockSkew: 60,
      resolver: async (candidate) => {
        const own = await ownVerifier();
        if (own.keyid === candidate.keyid) {
          matchedTier = 'own';
          matchedMeta = OWN_META;
          return own;
        }

        const sigAgentUri = candidate.signatureAgent?.uri;
        const entry = sigAgentUri ? REGISTRY.find((e) => e.origin === sigAgentUri) : undefined;
        if (!entry) throw new Error('key not in trusted directory');

        const verifier = await fetchOperatorVerifier(entry.origin, candidate.keyid);
        if (!verifier) throw new Error("key not found in operator's own directory");

        matchedTier = 'registry:' + entry.origin;
        matchedMeta = { name: entry.label, operator: entry.operator, domain: new URL(entry.origin).hostname };
        return verifier;
      },
    });

    if (result.nonce) {
      const ttlSeconds = Math.max(1, (result.expires.getTime() - Date.now()) / 1000);
      const firstUse = await claimNonce(env, result.nonce, ttlSeconds);
      if (!firstUse) {
        return { ok: false, reason: 'replayed', detail: 'This exact signature (same nonce) has already been used once.' };
      }
    }

    return {
      ok: true,
      keyid: result.keyid,
      tier: matchedTier,
      agent: matchedMeta,
      created: result.created.toISOString(),
      expires: result.expires.toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      reason: matchedTier ? 'invalid' : 'unknown-key',
      detail: String((err && err.message) || err),
    };
  }
}

/** Short human label for logs, API/MCP responses, and the backend record. */
export function signedAgentLabel(verdict) {
  if (!verdict || !verdict.ok) return '';
  const demo = verdict.tier === 'own' ? ' [demo key — not a real trust proof]' : '';
  return verdict.agent.name + ' (' + verdict.agent.operator + ')' + demo;
}
