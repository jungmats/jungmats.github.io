// GENERATED from eleviq-lab/shared — do not edit here; run scripts/sync-shared.mjs
/**
 * deriveVisitor — the one classification function (CLS-1). Turns the raw
 * signals stored per page view (or per journey) into kind, evidence level,
 * method, name, flags and referral, at read time, so rule changes apply to
 * all history without migrations.
 *
 * Requirements: agent-analytics/requirements-visitor-evidence.md, §5 and §6.1–6.2.
 */
import {
  isBrowserUserAgent,
  mapCloudflareCategory,
  operatorByHost,
  signatureByName,
  type Kind,
  type Referral,
  type ReferralSignal,
} from "./signatures.ts";

export type Level = "verified" | "attested" | "declared";
export type Method =
  | "web-bot-auth"
  | "journey-credential"
  | "cloudflare"
  | "user-agent"
  | "signature-agent"
  | "journey-declared"
  | "mcp-client";
export type Flag = "contradicted" | "signature-invalid" | "internal";
export type Note = "sig-unchecked";
export type SigStatus = "none" | "valid" | "invalid" | "unverifiable";

/** Stored signals — the columns of LOG-1 plus the legacy columns. */
export interface VisitorSignals {
  ua_match?: string | null;
  /** Stored only for non-browser UAs ("" for an empty UA) or attested visits (LOG-2). */
  ua_raw?: string | null;
  cf_bot_category?: string | null;
  /** Null on rows logged before signature checking existed → legacy row. */
  sig_status?: SigStatus | null;
  /** `Signature-Agent` host; for a valid signature, the host of the operator that vouched. */
  sig_agent?: string | null;
  referrer_agent?: string | null;
  referral_signal?: ReferralSignal | null;
  internal?: number | boolean | null;
  // Legacy columns (still written until LOG-6 drops them).
  visitor?: string | null;
  visitor_category?: string | null;
  // Journey-only evidence (JRN-3).
  agent_claim?: string | null;
  mcp_client?: string | null;
}

export interface VisitorClass {
  kind: Kind;
  level: Level | null;
  method: Method | null;
  name: string | null;
  flags: Flag[];
  notes: Note[];
  referral: Referral | null;
}

const LEGACY_NON_NAMES = (v: string) => v === "human" || v.startsWith("unrecognized");

interface Normalised {
  uaMatch: string | null;
  browserLooking: boolean;
  cfCategory: string | null;
  sigStatus: SigStatus;
  sigAgent: string | null;
  referral: Referral | null;
  internal: boolean;
  agentClaim: string | null;
  mcpClient: string | null;
}

function normalise(s: VisitorSignals): Normalised {
  const legacy = s.sig_status == null;
  const cfCategory = s.cf_bot_category ? s.cf_bot_category : null;
  const agentClaim = s.agent_claim ? s.agent_claim : null;
  const mcpClient = s.mcp_client ? s.mcp_client : null;

  if (legacy) {
    // CLS-10: rebuild what the old logger did not store.
    const v = s.visitor ?? "";
    const uaMatch = s.ua_match ?? (v && !LEGACY_NON_NAMES(v) && signatureByName(v) ? v : null);
    return {
      uaMatch,
      browserLooking: s.visitor_category === "human",
      cfCategory,
      sigStatus: "none",
      sigAgent: null,
      // The old logger read only the Referer header.
      referral: s.referrer_agent ? { by: s.referrer_agent, signal: s.referral_signal ?? "referer" } : null,
      internal: Boolean(s.internal),
      agentClaim,
      mcpClient,
    };
  }

  return {
    uaMatch: s.ua_match ? s.ua_match : null,
    // ua_raw is stored for every non-browser UA, so null means browser-looking.
    browserLooking: s.ua_raw == null ? true : isBrowserUserAgent(s.ua_raw),
    cfCategory,
    // LOG-8 / CLS-6: a signer that is not on the allow-list was never checked against
    // its key, so "invalid" from it (a failure before the key lookup) means "could not
    // check", not "false". Corrects rows stored before the checker fix (2026-11-17).
    sigStatus: s.sig_status === "invalid" && !operatorByHost(s.sig_agent) ? "unverifiable" : (s.sig_status as SigStatus),
    sigAgent: s.sig_agent ? s.sig_agent : null,
    referral: s.referrer_agent && s.referral_signal ? { by: s.referrer_agent, signal: s.referral_signal } : null,
    internal: Boolean(s.internal),
    agentClaim,
    mcpClient,
  };
}

export function deriveVisitor(signals: VisitorSignals): VisitorClass {
  const n = normalise(signals);
  const ua = signatureByName(n.uaMatch);
  const operator = operatorByHost(n.sigAgent);
  const notes: Note[] = [];

  let level: Level | null = null;
  let method: Method | null = null;
  let kind: Kind;
  let name: string | null = null;

  if (n.sigStatus === "valid") {
    // Level 1 — Verified.
    level = "verified";
    method = "web-bot-auth";
    kind = operator?.kind ?? ua?.kind ?? "unknown";
    // A UA name from the same operator is more specific (ChatGPT-User vs "ChatGPT agent").
    name = ua && operator && ua.operator === operator.operator ? ua.name : operator?.product ?? n.sigAgent;
  } else if (n.cfCategory) {
    // Level 2 — Attested.
    level = "attested";
    method = "cloudflare";
    kind = mapCloudflareCategory(n.cfCategory) as Kind;
    name = ua?.name ?? n.cfCategory;
  } else if (ua) {
    level = "declared";
    method = "user-agent";
    kind = ua.kind;
    name = ua.name;
  } else if (n.sigStatus === "unverifiable" && n.sigAgent) {
    // D-1: an unchecked signature still names its operator.
    level = "declared";
    method = "signature-agent";
    kind = operator?.kind ?? "unknown";
    name = operator?.product ?? n.sigAgent;
    notes.push("sig-unchecked");
  } else if (n.agentClaim) {
    level = "declared";
    method = "journey-declared";
    kind = "ai-assistant";
    name = n.agentClaim;
  } else if (n.mcpClient) {
    level = "declared";
    method = "mcp-client";
    kind = "ai-assistant";
    name = n.mcpClient;
  } else {
    kind = n.browserLooking ? "people" : "unknown";
  }

  if (n.sigStatus === "unverifiable" && method !== "signature-agent" && level !== "verified") {
    notes.push("sig-unchecked");
  }

  const flags: Flag[] = [];
  // CLS-4: a name Cloudflare normally verifies, not attested — unless a valid signature proves it.
  if (ua?.cfVerifies && !n.cfCategory && level !== "verified") flags.push("contradicted");
  if (n.sigStatus === "invalid") flags.push("signature-invalid");
  if (n.internal) flags.push("internal");

  return { kind, level, method, name, flags, notes, referral: n.referral };
}

/** Fields deriveVisitor reads, in a fixed order — for GROUP BY in the dashboards. */
export const SIGNAL_FIELDS = [
  "ua_match",
  "ua_raw",
  "cf_bot_category",
  "sig_status",
  "sig_agent",
  "referrer_agent",
  "referral_signal",
  "internal",
  "visitor",
  "visitor_category",
  "agent_claim",
  "mcp_client",
] as const satisfies readonly (keyof VisitorSignals)[];

/** Stable key of the signals that matter, so equal tuples classify once. */
export function signalKey(signals: VisitorSignals): string {
  return JSON.stringify(SIGNAL_FIELDS.map((f) => signals[f] ?? null));
}
