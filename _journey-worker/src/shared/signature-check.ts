// GENERATED from eleviq-lab/shared — do not edit here; run scripts/sync-shared.mjs
/**
 * Web Bot Auth signature checker (LOG-3, LOG-4, LOG-7, LOG-8) — ported from
 * jungmats.github.io/booking/_gateway-worker/src/verify.js.
 *
 * Differences from verify.js:
 * - Returns one of four statuses (LOG-7) instead of ok / not ok:
 *     none          no signature sent
 *     valid         checked and correct
 *     invalid       checked and wrong (bad signature, expired, keyid absent
 *                   from a freshly fetched directory, malformed)
 *     unverifiable  could not check (operator not on the allow-list, demo
 *                   key disabled, directory unreachable, unsupported algorithm)
 * - A failed directory fetch is NOT turned into an empty key list — that
 *   would turn "could not check" into "invalid".
 * - The demo key is accepted only when `acceptDemo` is set (on for
 *   eleviq.solutions, off on client sites): its private half is published.
 * - No nonce replay protection: the logger only records, it never grants
 *   anything, and has no KV binding.
 * - Everything with side effects (fetch, clock) is injected.
 */
import { verify, type WebBotVerifier } from "web-bot-auth";
import { verifierFromJWK } from "web-bot-auth/crypto";
import { OPERATORS, type Operator } from "./signatures.ts";
import type { SigStatus } from "./derive.ts";

export interface SignatureCheck {
  sig_status: SigStatus;
  /** Signature-Agent host; for a valid signature, the host of the operator that vouched. */
  sig_agent: string | null;
  keyid: string | null;
  operator: Operator | null;
}

export interface CheckerOptions {
  operators?: readonly Operator[];
  acceptDemo: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  ttlMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
}

const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";

type Stage = "before-resolver" | "unverifiable" | "key-not-found" | "resolved";

/** Thrown inside the resolver to say "we could not check". */
class Unverifiable extends Error {}
/** Thrown inside the resolver to say "checked: this key is not the operator's". */
class KeyNotFound extends Error {}

interface CacheEntry {
  fetchedAt: number;
  verifiers: WebBotVerifier[];
}

function hostOf(uri: string | undefined | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Best-effort host from a raw Signature-Agent header, for failures before parsing. */
function rawAgentHost(header: string | null): string | null {
  if (!header) return null;
  const m = /"([^"]+)"/.exec(header) ?? /(https?:\/\/[^\s;,]+)/.exec(header);
  return hostOf(m ? m[1] : header.trim());
}

function errorChain(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; e && i < 4; i++) {
    const anyE = e as { code?: string; message?: string; cause?: unknown };
    parts.push(`${anyE.code ?? ""} ${anyE.message ?? String(e)}`);
    e = anyE.cause;
  }
  return parts.join(" | ");
}

export function createSignatureChecker(options: CheckerOptions) {
  const operators = options.operators ?? OPERATORS;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? 10 * 60 * 1000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 20_000;

  // Per checker instance = per Worker isolate.
  const cache = new Map<string, CacheEntry>();
  const localVerifiers = new Map<string, Promise<WebBotVerifier[]>>();

  async function verifiersFromJwks(keys: unknown[]): Promise<WebBotVerifier[]> {
    const nowSec = Math.floor(now().getTime() / 1000);
    const out: WebBotVerifier[] = [];
    for (const jwk of keys) {
      const k = jwk as { nbf?: number; exp?: number; d?: unknown };
      if (typeof k.nbf === "number" && nowSec < k.nbf) continue;
      if (typeof k.exp === "number" && nowSec > k.exp) continue;
      try {
        const { d: _private, ...pub } = k as Record<string, unknown>;
        out.push(await verifierFromJWK(pub as unknown as JsonWebKey));
      } catch {
        // not a usable key (wrong kty/crv, malformed) — skip it
      }
    }
    return out;
  }

  function local(op: Operator): Promise<WebBotVerifier[]> {
    let p = localVerifiers.get(op.origin);
    if (!p) {
      p = verifiersFromJwks([...(op.localKeys ?? [])]);
      localVerifiers.set(op.origin, p);
    }
    return p;
  }

  /** Fetches the directory; throws Unverifiable on any failure. */
  async function fetchDirectory(origin: string): Promise<CacheEntry> {
    let res: Response;
    try {
      res = await doFetch(origin + DIRECTORY_PATH, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Unverifiable(`directory unreachable: ${String(err)}`);
    }
    if (!res.ok) throw new Unverifiable(`directory HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Unverifiable("directory too large");
    let body: { keys?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      throw new Unverifiable("directory not JSON");
    }
    if (!Array.isArray(body.keys)) throw new Unverifiable("directory has no keys array");
    const entry = { fetchedAt: now().getTime(), verifiers: await verifiersFromJwks(body.keys) };
    cache.set(origin, entry);
    return entry;
  }

  /** LOG-4: cached with TTL; one forced refetch when the keyid is unknown (key rotation). */
  async function remoteVerifier(op: Operator, keyid: string): Promise<WebBotVerifier> {
    const cached = cache.get(op.origin);
    let entry: CacheEntry;
    let fresh = false;
    if (cached && now().getTime() - cached.fetchedAt < ttlMs) {
      entry = cached;
    } else {
      try {
        entry = await fetchDirectory(op.origin);
        fresh = true;
      } catch (err) {
        if (!cached) throw err;
        entry = cached; // stale keys are better than none; a miss below refetches anyway
      }
    }
    let found = entry.verifiers.find((v) => v.keyid === keyid);
    if (!found && !fresh) {
      entry = await fetchDirectory(op.origin); // throws Unverifiable when unreachable
      fresh = true;
      found = entry.verifiers.find((v) => v.keyid === keyid);
    }
    if (!found) throw new KeyNotFound(`keyid not in ${op.origin}'s directory`);
    return found;
  }

  async function check(request: Request): Promise<SignatureCheck> {
    const sigHeader = request.headers.get("Signature");
    const inputHeader = request.headers.get("Signature-Input");
    const agentHeader = request.headers.get("Signature-Agent");
    if (!sigHeader || !inputHeader) return { sig_status: "none", sig_agent: rawAgentHost(agentHeader), keyid: null, operator: null };

    // How far the check got: decides the status when verify() throws.
    // Held in an object: the resolver callback updates it, which TypeScript's narrowing can't see.
    const progress: { stage: Stage; agentHost: string | null; matched: Operator | null; keyid: string | null } = {
      stage: "before-resolver",
      agentHost: rawAgentHost(agentHeader),
      matched: null,
      keyid: null,
    };

    try {
      await verify(request, {
        // Observed real operators (chatgpt.com) use up to 1 hour.
        maxAge: 3600,
        clockSkew: 60,
        now: now(),
        resolver: async (candidate) => {
          progress.keyid = candidate.keyid;
          progress.agentHost = hostOf(candidate.signatureAgent?.uri) ?? progress.agentHost;
          const agentHost = progress.agentHost;
          try {
            // Demo keys are matched by keyid and never fetched.
            for (const op of operators.filter((o) => o.demo)) {
              const v = (await local(op)).find((x) => x.keyid === candidate.keyid);
              if (v) {
                if (!options.acceptDemo) throw new Unverifiable("demo key not accepted here");
                progress.matched = op;
                progress.stage = "resolved";
                return v;
              }
            }
            const op = operators.find((o) => !o.demo && hostOf(o.origin) === agentHost);
            if (!op) throw new Unverifiable("Signature-Agent not on the allow-list"); // LOG-8: never fetched
            const localV = (await local(op)).find((x) => x.keyid === candidate.keyid);
            const v = localV ?? (await remoteVerifier(op, candidate.keyid));
            progress.matched = op;
            progress.stage = "resolved";
            return v;
          } catch (err) {
            progress.stage = err instanceof KeyNotFound ? "key-not-found" : "unverifiable";
            throw err;
          }
        },
      });
    } catch (err) {
      let status: SigStatus;
      if (progress.stage === "unverifiable") status = "unverifiable";
      else if (progress.stage === "key-not-found" || progress.stage === "resolved") status = "invalid";
      // Failed before our resolver ran. A signer not on the allow-list is never judged (LOG-8,
      // CLS-6): unverifiable. Otherwise malformed, expired, coverage → invalid; unsupported
      // algorithm → unverifiable.
      else if (!operators.some((o) => hostOf(o.origin) === progress.agentHost)) status = "unverifiable";
      else status = /unsupported|is not allowed/i.test(errorChain(err)) ? "unverifiable" : "invalid";
      return { sig_status: status, sig_agent: progress.agentHost, keyid: progress.keyid, operator: null };
    }

    const op = progress.matched;
    return { sig_status: "valid", sig_agent: op ? hostOf(op.origin) : progress.agentHost, keyid: progress.keyid, operator: op };
  }

  return { check };
}
