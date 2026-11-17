// GENERATED from eleviq-lab/shared — do not edit here; run scripts/sync-shared.mjs
/**
 * Signature list and lookups for visitor classification — the single source
 * for every component (logger, visitor dashboard, journey worker). Edit only
 * here; the journey worker gets a synced copy (scripts/sync-shared.mjs).
 *
 * Requirements: agent-analytics/requirements-visitor-evidence.md
 * (consulting-methodology repo) — CLS-2, CLS-4, CLS-7, CLS-8, LOG-8.
 */

export type Kind = "people" | "ai-assistant" | "search" | "ai-training" | "other-bot" | "unknown";

export interface UaSignature {
  /** Matched case-insensitively as a substring of the User-Agent. */
  pattern: string;
  name: string;
  operator: string;
  kind: Exclude<Kind, "people" | "unknown">;
  /**
   * Cloudflare normally attests this name. A visit claiming it without
   * attestation is flagged `contradicted` (CLS-4). Set from observed
   * attestation rates (≥ 90 % excluding ElevIQ's own audit runs, ≥ 10
   * visits), reviewed quarterly (DOC-3). Last set 2026-11-17 from the
   * eleviq.solutions log 2026-09-11 → 2026-11-17.
   */
  cfVerifies: boolean;
}

// Order matters: more specific names before the names they contain
// (ChatGPT-User before GPTBot, Claude-SearchBot before ClaudeBot, …).
// Sourced from Cloudflare's AI Crawl Control bot reference.
export const UA_SIGNATURES: readonly UaSignature[] = [
  { pattern: "ChatGPT-User", name: "ChatGPT-User", operator: "OpenAI", kind: "ai-assistant", cfVerifies: true },
  { pattern: "OAI-SearchBot", name: "OAI-SearchBot", operator: "OpenAI", kind: "search", cfVerifies: true },
  { pattern: "GPTBot", name: "GPTBot", operator: "OpenAI", kind: "ai-training", cfVerifies: true },
  { pattern: "Claude-User", name: "Claude-User", operator: "Anthropic", kind: "ai-assistant", cfVerifies: false },
  { pattern: "Claude-SearchBot", name: "Claude-SearchBot", operator: "Anthropic", kind: "search", cfVerifies: false },
  { pattern: "ClaudeBot", name: "ClaudeBot", operator: "Anthropic", kind: "ai-training", cfVerifies: true },
  { pattern: "Perplexity-User", name: "Perplexity-User", operator: "Perplexity", kind: "ai-assistant", cfVerifies: false },
  { pattern: "PerplexityBot", name: "PerplexityBot", operator: "Perplexity", kind: "search", cfVerifies: false },
  // Google-Extended is a robots.txt token, not a User-Agent; kept so old rows still resolve.
  { pattern: "Google-Extended", name: "Google-Extended", operator: "Google", kind: "ai-training", cfVerifies: false },
  { pattern: "Googlebot", name: "Googlebot", operator: "Google", kind: "search", cfVerifies: true },
  { pattern: "bingbot", name: "Bingbot", operator: "Microsoft", kind: "search", cfVerifies: true },
  { pattern: "meta-externalagent", name: "meta-externalagent", operator: "Meta", kind: "ai-training", cfVerifies: false },
  // Link previews for shared posts — other-bot (§5.2), not search.
  { pattern: "facebookexternalhit", name: "facebookexternalhit", operator: "Meta", kind: "other-bot", cfVerifies: true },
  { pattern: "DuckDuckBot", name: "DuckDuckBot", operator: "DuckDuckGo", kind: "search", cfVerifies: true },
  { pattern: "Bytespider", name: "Bytespider", operator: "ByteDance", kind: "ai-training", cfVerifies: false },
  { pattern: "Applebot", name: "Applebot", operator: "Apple", kind: "search", cfVerifies: true },
  { pattern: "Amazonbot", name: "Amazonbot", operator: "Amazon", kind: "ai-training", cfVerifies: true },
  { pattern: "CCBot", name: "CCBot", operator: "Common Crawl", kind: "ai-training", cfVerifies: false },
  { pattern: "MistralAI-User", name: "MistralAI-User", operator: "Mistral", kind: "ai-assistant", cfVerifies: false },
];

export function matchUserAgent(ua: string | null | undefined): UaSignature | null {
  if (!ua) return null;
  const lower = ua.toLowerCase();
  return UA_SIGNATURES.find((s) => lower.includes(s.pattern.toLowerCase())) ?? null;
}

export function signatureByName(name: string | null | undefined): UaSignature | null {
  if (!name) return null;
  return UA_SIGNATURES.find((s) => s.name === name) ?? null;
}

// A real browser's UA contains "Mozilla/5.0" plus an engine/browser token.
// HTTP libraries ("python-requests/2.x", "curl/8.x", …) fail this test.
const BROWSER_TOKENS = ["AppleWebKit", "Gecko", "Chrome", "Safari", "Firefox", "Edg/", "OPR/"];

/** Browser-shaped UAs that announce automation (CLS-8). */
export const AUTOMATION_MARKERS: readonly string[] = [
  "HeadlessChrome",
  "Lighthouse",
  "PhantomJS",
  "Puppeteer",
  "Playwright",
  "Selenium",
  "Cypress",
];

/**
 * Looks like a person's browser: "Mozilla/5.0" + an engine token, no
 * automation marker (CLS-8), and no recognised bot name — several bots
 * (GPTBot, ChatGPT-User) use browser-shaped UAs.
 */
export function isBrowserUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return false;
  if (!ua.includes("Mozilla/5.0")) return false;
  if (matchUserAgent(ua)) return false;
  if (!BROWSER_TOKENS.some((t) => ua.includes(t))) return false;
  const lower = ua.toLowerCase();
  return !AUTOMATION_MARKERS.some((m) => lower.includes(m.toLowerCase()));
}

/** Cloudflare verified-bot category → kind (CLS-2). Null when not attested. */
export function mapCloudflareCategory(category: string | null | undefined): Kind | null {
  if (!category) return null;
  switch (category) {
    case "AI Assistant":
      return "ai-assistant";
    case "AI Search":
    case "Search Engine Crawler":
      return "search";
    case "AI Crawler":
      return "ai-training";
    default:
      // Observed: Search Engine Optimization, Monitoring & Analytics,
      // Page Preview, Feed Fetcher, Webhooks — all non-AI automation.
      return "other-bot";
  }
}

// AI assistant chat UIs — a Referer from one of these means a person clicked
// a link the assistant showed them (CLS-7), not that the assistant fetched.
export const REFERRER_HOSTS: Readonly<Record<string, string>> = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "perplexity.ai": "Perplexity",
  "www.perplexity.ai": "Perplexity",
  "claude.ai": "Claude",
  "copilot.microsoft.com": "Copilot",
  "gemini.google.com": "Gemini",
  "you.com": "You.com",
};

/** `utm_source` values assistants add to links (lower-cased). */
export const UTM_SOURCES: Readonly<Record<string, string>> = {
  "chatgpt.com": "ChatGPT",
  chatgpt: "ChatGPT",
  openai: "ChatGPT",
  perplexity: "Perplexity",
  "perplexity.ai": "Perplexity",
  "claude.ai": "Claude",
  claude: "Claude",
  copilot: "Copilot",
  "copilot.microsoft.com": "Copilot",
  gemini: "Gemini",
  "gemini.google.com": "Gemini",
};

export type ReferralSignal = "referer" | "utm";
export interface Referral {
  by: string;
  signal: ReferralSignal;
}

/** Referer host first, then `utm_source` of the page URL. */
export function classifyReferral(referer: string | null | undefined, pageUrl?: string | null): Referral | null {
  if (referer) {
    try {
      const by = REFERRER_HOSTS[new URL(referer).hostname.toLowerCase()];
      if (by) return { by, signal: "referer" };
    } catch {
      // not a URL — ignore
    }
  }
  if (pageUrl) {
    try {
      const utm = new URL(pageUrl).searchParams.get("utm_source");
      const by = utm ? UTM_SOURCES[utm.trim().toLowerCase()] : undefined;
      if (by) return { by, signal: "utm" };
    } catch {
      // not a URL — ignore
    }
  }
  return null;
}

/** Public Ed25519 JWK (never the private part). */
export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg?: string;
  kid?: string;
}

export interface Operator {
  /** Exact origin as it appears in `Signature-Agent`, e.g. "https://chatgpt.com". */
  origin: string;
  operator: string;
  product: string;
  kind: Exclude<Kind, "people" | "unknown">;
  /**
   * Demo key whose private half is published for testing. Accepted only
   * where the deployment enables it (eleviq.solutions), never on client
   * sites — there it would let anyone appear Verified (LOG-8).
   */
  demo?: boolean;
  /** Keys checked locally, without fetching a directory. */
  localKeys?: readonly PublicJwk[];
}

/**
 * Operator allow-list (LOG-8). Key directories are fetched only for these
 * origins; a URL taken from a request is never fetched otherwise. Adding an
 * operator is one entry, reviewed quarterly (DOC-1).
 */
export const OPERATORS: readonly Operator[] = [
  // Directory confirmed live 2026-09-11 (eleviq-lab/gateway/src/lib/registry.ts).
  { origin: "https://chatgpt.com", operator: "OpenAI", product: "ChatGPT agent", kind: "ai-assistant" },
  {
    origin: "https://eleviq.solutions",
    operator: "ElevIQ",
    product: "ElevIQ demo agent",
    kind: "ai-assistant",
    demo: true,
    // Public half of eleviq-lab/gateway/keys/demo-agent.jwk.json.
    localKeys: [
      { kty: "OKP", crv: "Ed25519", alg: "EdDSA", kid: "eleviq-lab-demo-agent", x: "flVbVXE7eUkNMzaUZnvc3xPCejXb9cHB1IYTrwFLgic" },
    ],
  },
];

/** Allow-listed operator for a `Signature-Agent` host or origin. */
export function operatorByHost(hostOrOrigin: string | null | undefined): Operator | null {
  if (!hostOrOrigin) return null;
  let host = hostOrOrigin.toLowerCase();
  try {
    if (host.includes("://")) host = new URL(host).host;
  } catch {
    return null;
  }
  return OPERATORS.find((o) => new URL(o.origin).host === host) ?? null;
}
