#!/usr/bin/env node
/**
 * Evidence smoke test for the journey worker (agent-analytics AC-8).
 *
 *   node scripts/smoke-evidence.mjs <base-url> [cases]     e.g. https://agents.eleviq.solutions a,c
 *
 * Starts site-visit journeys, one per case:
 *   a  demo-key signed, over HTTP                → Verified, "ElevIQ demo agent"
 *   b  unsigned, with agent_claim "Claude"       → Declared (journey-declared)
 *   c  over MCP with clientInfo                  → mcp_client stored
 *   d  tampered signature                        → started anyway, signature-invalid
 *   e  marked as ElevIQ test traffic             → internal 1
 *
 * Every case carries the internal marker when INTERNAL=1 (production: so the
 * test journeys never reach the client view). The marker needs the token:
 * ELEVIQ_INTERNAL_TOKEN in the environment, else read from the token store
 * (~/.config/eleviq/internal-tokens/eleviq.env). Never prints the token.
 * Prints each case's journey ref-able id prefix and HTTP status as JSON.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sign, generateNonce } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";
import { createInternalMarker } from "../src/shared/internal-marker.ts";

const BASE = (process.argv[2] ?? "http://localhost:8790").replace(/\/$/, "");
const CASES = (process.argv[3] ?? "a,b,c,d,e").split(",");
const HOST = new URL(BASE).host;
const RUN = Date.now().toString(36);
const DEMO_KEY = JSON.parse(readFileSync(new URL("../test/fixtures/keys/demo-agent.jwk.json", import.meta.url), "utf8"));

function token() {
  if (process.env.ELEVIQ_INTERNAL_TOKEN) return process.env.ELEVIQ_INTERNAL_TOKEN;
  const f = join(homedir(), ".config/eleviq/internal-tokens/eleviq.env");
  if (!existsSync(f)) return null;
  const line = readFileSync(f, "utf8").split("\n").find((l) => l.startsWith("ELEVIQ_INTERNAL_TOKEN="));
  return line ? line.slice("ELEVIQ_INTERNAL_TOKEN=".length).trim() : null;
}

async function internalHeader(always) {
  if (!always && process.env.INTERNAL !== "1") return {};
  const t = token();
  if (!t) throw new Error("no internal token available");
  return { "X-ElevIQ-Internal": await createInternalMarker(t, HOST) };
}

const body = (claim) => ({
  definition: "site-visit",
  intent: { intent: "discover", goal: `Smoke test ${RUN}`, human_present: false, ...(claim ? { agent_claim: { product: claim } } : {}) },
});

async function signedHeaders(url, extra) {
  const h = { "Signature-Agent": `sig1="https://eleviq.solutions"`, "User-Agent": `ElevIQ-Smoke/1.0 ${RUN}`, ...extra };
  const created = new Date();
  const f = await sign(new Request(url, { method: "POST", headers: h }), {
    signer: await signerFromJWK(DEMO_KEY),
    created,
    expires: new Date(created.getTime() + 5 * 60_000),
    nonce: generateNonce(),
    target: "@target-uri",
    label: "sig1",
  });
  return { ...h, "Signature-Input": f.signatureInput, Signature: f.signature };
}

async function http(id, headers, claim) {
  const url = `${BASE}/api/journey/start`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body(claim)) });
  const j = await res.json().catch(() => ({}));
  return { id, status: res.status, journey: j.journey_id ? `${j.journey_id.slice(0, 8)}…` : null, verified_agent: j.verified_agent ?? null };
}

async function mcp(id, headers) {
  const tool = "start_site_visit";
  const v = "2026-07-28";
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": v, "Mcp-Method": "tools/call", "Mcp-Name": tool,
      "User-Agent": `ElevIQ-Smoke/1.0 ${RUN}`, ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: tool,
        arguments: body(null).intent,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": v,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": { name: "eleviq-smoke", version: RUN },
        },
      },
    }),
  });
  const j = await res.json().catch(() => ({}));
  return { id, status: res.status, error: j.error?.message ?? (j.result?.isError ? "tool error" : null) };
}

const out = [];
for (const c of CASES) {
  const internal = await internalHeader(c === "e");
  if (c === "a") out.push(await http("a", await signedHeaders(`${BASE}/api/journey/start`, internal)));
  if (c === "b") out.push(await http("b", { "User-Agent": `ElevIQ-Smoke/1.0 ${RUN}`, ...internal }, "Claude"));
  if (c === "c") out.push(await mcp("c", internal));
  if (c === "d") {
    const h = await signedHeaders(`${BASE}/api/journey/start`, internal);
    const i = h.Signature.indexOf(":") + 5;
    h.Signature = h.Signature.slice(0, i) + (h.Signature[i] === "A" ? "B" : "A") + h.Signature.slice(i + 1);
    out.push(await http("d", h));
  }
  if (c === "e") out.push(await http("e", { "User-Agent": `ElevIQ-Smoke/1.0 ${RUN}`, ...internal }));
}
console.log(JSON.stringify({ base: BASE, run: RUN, internal_all: process.env.INTERNAL === "1", cases: out }, null, 2));
