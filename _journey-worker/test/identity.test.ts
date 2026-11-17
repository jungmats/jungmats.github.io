import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sign, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

import { identify } from "../src/adapters/identity.ts";
import { startJourney, type OpContext } from "../src/operations.ts";
import { createInternalMarker } from "../src/shared/index.ts";
import type { Env } from "../src/env.ts";

// Test keys published on purpose (copies of eleviq-lab/gateway/keys): the demo agent and an unlisted signer.
const DEMO_KEY = JSON.parse(readFileSync(new URL("./fixtures/keys/demo-agent.jwk.json", import.meta.url), "utf8"));
const UNLISTED_KEY = JSON.parse(readFileSync(new URL("./fixtures/keys/untrusted-agent.jwk.json", import.meta.url), "utf8"));

const HOST = "agents.eleviq.solutions";
const URL_ = `https://${HOST}/journeys/start`;
const TOKEN = "journey-test-token-1f9c";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const env = (over: Partial<Env> = {}) =>
  ({ ACCEPT_DEMO_SIGNATURES: "true", ELEVIQ_INTERNAL_TOKEN: TOKEN, ...over }) as Env;

async function signed(jwk: object, agent: string, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { "Signature-Agent": `sig1="${agent}"`, ...headers };
  const created = new Date();
  const f = await sign(new Request(URL_, { headers: h }), {
    signer: await signerFromJWK(jwk as JsonWebKey),
    created,
    expires: new Date(created.getTime() + 5 * 60_000),
    nonce: generateNonce(),
    target: "@target-uri",
    label: "sig1",
  });
  return { ...h, "Signature-Input": f.signatureInput, Signature: f.signature };
}

const req = (headers: Record<string, string>) => new Request(URL_, { method: "POST", headers });

test("demo-signed: valid, bound to the key, named after the operator's product", async () => {
  const r = await identify(req(await signed(DEMO_KEY, "https://eleviq.solutions", { "User-Agent": "DemoAgent/1.0" })), env());
  assert.ok(r.ok);
  assert.equal(r.evidence.sigStatus, "valid");
  assert.equal(r.evidence.sigAgent, "eleviq.solutions");
  assert.ok(r.caller.keyid);
  assert.equal(r.caller.agentName, "ElevIQ demo agent");
  assert.equal(r.evidence.uaRaw, "DemoAgent/1.0");
});

test("tampered signature: invalid, never refused, caller unsigned", async () => {
  const h = await signed(DEMO_KEY, "https://eleviq.solutions");
  const i = h.Signature.indexOf(":") + 5;
  h.Signature = h.Signature.slice(0, i) + (h.Signature[i] === "A" ? "B" : "A") + h.Signature.slice(i + 1);
  const r = await identify(req(h), env());
  assert.ok(r.ok, "JRN-1: a failed signature never rejects");
  assert.equal(r.evidence.sigStatus, "invalid");
  assert.equal(r.caller.keyid, null);
});

test("demo key with the demo setting off: unverifiable, unsigned", async () => {
  const r = await identify(req(await signed(DEMO_KEY, "https://eleviq.solutions")), env({ ACCEPT_DEMO_SIGNATURES: "false" }));
  assert.ok(r.ok);
  assert.equal(r.evidence.sigStatus, "unverifiable");
  assert.equal(r.caller.keyid, null);
});

test("signer not on the allow-list: unverifiable", async () => {
  const r = await identify(req(await signed(UNLISTED_KEY, "https://agent.example")), env());
  assert.ok(r.ok);
  assert.equal(r.evidence.sigStatus, "unverifiable");
  assert.equal(r.evidence.sigAgent, "agent.example");
});

test("unsigned: none; browser UA not stored; bot UA matched and stored; empty UA is ''", async () => {
  const a = await identify(req({ "User-Agent": CHROME }), env());
  assert.ok(a.ok);
  assert.equal(a.evidence.sigStatus, "none");
  assert.equal(a.evidence.uaRaw, null);
  const b = await identify(req({ "User-Agent": "Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)" }), env());
  assert.ok(b.ok);
  assert.equal(b.evidence.uaMatch, "ChatGPT-User");
  assert.ok(b.evidence.uaRaw);
  const c = await identify(req({}), env());
  assert.ok(c.ok);
  assert.equal(c.evidence.uaRaw, "");
});

test("internal: a fresh proof for this host counts; the raw token, another host's proof or no secret do not", async () => {
  const one = async (header: string, e = env()) => {
    const r = await identify(req({ "X-ElevIQ-Internal": header }), e);
    assert.ok(r.ok);
    return r.evidence.internal;
  };
  assert.equal(await one(await createInternalMarker(TOKEN, HOST)), 1);
  assert.equal(await one(TOKEN), 0);
  assert.equal(await one(await createInternalMarker(TOKEN, "eleviq.solutions")), 0);
  assert.equal(await one(await createInternalMarker(TOKEN, HOST), env({ ELEVIQ_INTERNAL_TOKEN: undefined })), 0);
});

// ---- the stored journey row (JRN-2) ----------------------------------------

function fakeEnv(over: Partial<Env> = {}) {
  const inserts: { sql: string; values: unknown[] }[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (/INSERT INTO journeys\b/.test(sql)) inserts.push({ sql, values });
              return { success: true };
            },
            async first() {
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return { env: { ...env(over), DB } as unknown as Env, inserts };
}

function columnsOf(sql: string): string[] {
  return sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((s) => s.trim());
}

async function startWith(request: Request, client: Record<string, unknown> | null = null) {
  const { env: e, inserts } = fakeEnv();
  const pending: Promise<unknown>[] = [];
  const op: OpContext = {
    env: e,
    ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext,
    origin: `https://${HOST}`,
    now: new Date(),
    transport: client ? "mcp" : "http",
    ip: "203.0.113.9",
    identified: await identify(request, e),
    traceparent: null,
    client,
  };
  const body = {
    definition: "site-visit",
    intent: { intent: "discover", goal: "Find out what ElevIQ offers", human_present: false, agent_claim: { product: "Claude" } },
  };
  const r = await startJourney(op, body);
  await Promise.allSettled(pending);
  return { r, inserts };
}

test("a started journey stores every evidence signal, and a tampered one still starts", async () => {
  const h = await signed(DEMO_KEY, "https://eleviq.solutions", { "User-Agent": "DemoAgent/1.0" });
  const i = h.Signature.indexOf(":") + 5;
  h.Signature = h.Signature.slice(0, i) + (h.Signature[i] === "A" ? "B" : "A") + h.Signature.slice(i + 1);
  const { r, inserts } = await startWith(req({ ...h, "X-ElevIQ-Internal": await createInternalMarker(TOKEN, HOST) }));
  assert.ok(r.ok, `started: ${JSON.stringify(r)}`);
  assert.equal(inserts.length, 1);
  const row = Object.fromEntries(columnsOf(inserts[0].sql).map((c, k) => [c, inserts[0].values[k]]));
  for (const c of ["sig_status", "sig_agent", "cf_bot_category", "ua_match", "ua_raw", "mcp_client", "internal"]) {
    assert.ok(c in row, `column ${c}`);
  }
  assert.equal(row.sig_status, "invalid");
  assert.equal(row.keyid, null);
  assert.equal(row.ua_raw, "DemoAgent/1.0");
  assert.equal(row.internal, 1);
  assert.equal(row.mcp_client, null);
});

test("an MCP start stores the client name", async () => {
  const { r, inserts } = await startWith(req({ "User-Agent": "node" }), { mcp_protocol: "2025-06-18", mcp_client: "claude-ai/0.1.0" });
  assert.ok(r.ok);
  const row = Object.fromEntries(columnsOf(inserts[0].sql).map((c, k) => [c, inserts[0].values[k]]));
  assert.equal(row.mcp_client, "claude-ai/0.1.0");
  assert.equal(row.sig_status, "none");
});
