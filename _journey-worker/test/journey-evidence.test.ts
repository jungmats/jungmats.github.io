import { test } from "node:test";
import assert from "node:assert/strict";

import { addToAgent, claimVsConfirmed, classifier, parseFilters, passes, type AgentAgg, type EvidenceRow, type Filters } from "../src/journey-evidence.ts";

const f = (q = ""): Filters => {
  const r = parseFilters(new URLSearchParams(q));
  if (!r.ok) throw new Error(r.error);
  return r.filters;
};
const intent = (claim?: string) => JSON.stringify({ intent: "discover", goal: "x", ...(claim ? { agent_claim: { product: claim } } : {}) });

const signedDemo: EvidenceRow = { sig_status: "valid", sig_agent: "eleviq.solutions", ua_raw: "DemoAgent/1.0", internal: 0, intent: intent("ElevIQ demo") };
const unsignedClaim: EvidenceRow = { sig_status: "none", ua_raw: "node", internal: 0, intent: intent("Claude") };
const mcpOnly: EvidenceRow = { sig_status: "none", ua_raw: "node", mcp_client: "claude-ai/0.1.0", internal: 0, intent: intent() };
const tampered: EvidenceRow = { sig_status: "invalid", sig_agent: "eleviq.solutions", ua_raw: "x", internal: 0, intent: intent() };
const legacyClaim: EvidenceRow = { sig_status: null, intent: intent("ChatGPT") };
const legacyBare: EvidenceRow = { sig_status: null, intent: intent() };
const contradicted: EvidenceRow = { sig_status: "none", ua_match: "ChatGPT-User", ua_raw: "Mozilla/5.0 (compatible; ChatGPT-User/1.0)", internal: 0, intent: intent("Claude") };

test("AC-8: a demo-signed journey is Verified, named after the operator", () => {
  const c = classifier()(signedDemo);
  assert.equal(c.level, "verified");
  assert.equal(c.method, "web-bot-auth");
  assert.equal(c.name, "ElevIQ demo agent");
});

test("AC-8: an unsigned journey with an agent_claim is Declared (journey-declared)", () => {
  const c = classifier()(unsignedClaim);
  assert.equal(c.level, "declared");
  assert.equal(c.method, "journey-declared");
  assert.equal(c.name, "Claude");
});

test("an MCP client name alone is Declared (mcp-client)", () => {
  const c = classifier()(mcpOnly);
  assert.equal(c.method, "mcp-client");
  assert.equal(c.name, "claude-ai/0.1.0");
});

test("a tampered signature is flagged, never Verified", () => {
  const c = classifier()(tampered);
  assert.ok(c.flags.includes("signature-invalid"));
  assert.notEqual(c.level, "verified");
});

test("journeys from before the signals existed are classified, not 'unverified'", () => {
  const cl = classifier();
  assert.equal(cl(legacyClaim).level, "declared");
  assert.equal(cl(legacyClaim).name, "ChatGPT");
  assert.equal(cl(legacyBare).level, null);
  assert.equal(cl(legacyBare).kind, "unknown");
});

test("minimum evidence applies; a refused start (no journey) shows only under All", () => {
  const cl = classifier();
  assert.equal(passes(cl(signedDemo), f("min=verified")), true);
  assert.equal(passes(cl(unsignedClaim), f("min=verified")), false);
  assert.equal(passes(cl(unsignedClaim), f("min=attested")), false);
  assert.equal(passes(cl(unsignedClaim), f()), true);
  assert.equal(passes(null, f()), true);
  assert.equal(passes(null, f("min=attested")), false);
  assert.equal(passes(null, f("kinds=ai-assistant")), false);
});

test("agents: one row per name, unnamed journeys grouped per kind, levels and flags counted", () => {
  const cl = classifier();
  const m = new Map<string, AgentAgg>();
  for (const r of [signedDemo, signedDemo, unsignedClaim, legacyBare, tampered, contradicted]) addToAgent(m, cl(r), 0.5);
  const demo = m.get("n:ElevIQ demo agent")!;
  assert.equal(demo.journeys, 2);
  assert.equal(demo.levels.verified, 2);
  assert.deepEqual(demo.methods, ["web-bot-auth"]);
  const unnamed = m.get("k:unknown")!;
  assert.equal(unnamed.name, null);
  assert.equal(unnamed.journeys, 2);
  assert.equal(unnamed.flags["signature-invalid"], 1);
});

test("Declared → confirmed identity: confirmed only from Verified or Attested; contradiction marked", () => {
  const cl = classifier();
  assert.deepEqual(claimVsConfirmed(signedDemo, cl(signedDemo)), { declared: "ElevIQ demo", confirmed: "ElevIQ demo agent", level: "verified", contradicted: false });
  assert.deepEqual(claimVsConfirmed(unsignedClaim, cl(unsignedClaim)), { declared: "Claude", confirmed: null, level: null, contradicted: false });
  assert.equal(claimVsConfirmed(contradicted, cl(contradicted))!.contradicted, true);
  assert.equal(claimVsConfirmed(mcpOnly, cl(mcpOnly)), null, "no claim, no row");
});

test("invalid filters are rejected", () => {
  for (const q of ["min=high", "kinds=robots", "lang=de"]) assert.equal(parseFilters(new URLSearchParams(q)).ok, false, q);
});
