/**
 * Everything this deployment is expected to change, in one place. Options
 * and wording live here, not in the handlers. Prices come from the site's
 * _data/prices.json, the one source for the pages, llms.txt and this Worker.
 */
import prices from "../../_data/prices.json" with { type: "json" };

export interface PricedOption {
  title: string;
  price: number;
  /** A "from" price: the real price is fixed by a quote and can be higher. */
  from: boolean;
  summary: string;
  page: string;
}

/** The offers the price-estimate journey can price: paid, one-off, marked `estimate`. */
function estimableOptions(): Record<string, PricedOption> {
  const pages = new Map(prices.services.map((s) => [s.id, prices.site + s.pages.en]));
  return Object.fromEntries(
    prices.offers
      .filter((o) => o.estimate)
      .map((o) => [o.id, { title: o.name.en, price: o.price, from: o.from, summary: o.summary.en, page: `${pages.get(o.service)}#${o.id}` }]),
  );
}

export const config = {
  /** Where problem+json `type` links and the service description point. */
  site: "https://eleviq.solutions/llms.txt",

  /** Event sinks. D1 is the dashboard's source; the webhook forwards every
   * event as JSON elsewhere. */
  sinks: {
    d1: true,
    webhook: {
      enabled: false,
      url: "",
      /** Sent as `Authorization: Bearer <JOURNEY_WEBHOOK_SECRET>` when that secret is set. */
    },
  },

  analytics: {
    /** /dashboard/ and /api/analytics/ additionally require a valid
     * Cloudflare Access token (src/access.ts). */
    enabled: true,
    /** Upper bound on journeys aggregated per request. */
    maxJourneys: 2000,
    listLimit: 100,
  },

  /** Cloudflare Access (Zero Trust) team domain, the issuer of the tokens
   * src/access.ts verifies. The application's AUD tag is the ACCESS_AUD var. */
  access: {
    teamDomain: "https://nameless-wind-f7be.cloudflareaccess.com",
  },

  pricing: {
    currency: prices.currency,
    vat: prices.vat_included ? "including VAT" : "excluding VAT",
    validityDays: 30,
    conditions:
      "Indicative list price per option, computed automatically: not a quote and not an offer. Options with from: true have a minimum price, fixed by a quote, so the total is then a minimum too. A binding quote follows a free call (book one) or a scope request (both described at https://eleviq.solutions/llms.txt).",
    /** From _data/prices.json. The ids must match the `options` enums in
     * definitions/price-estimate.json, which _tools/build-prices.mjs writes;
     * src/journeys.ts refuses to load if they drift apart. */
    options: estimableOptions(),
    /** The free call: the page is for people, the API for agents that book themselves. */
    bookCall: {
      page: "https://eleviq.solutions/booking/",
      api: "https://eleviq-booking-gateway.gateway-worker.workers.dev",
    },
  },

  /** Emails left with step "close" of the price-estimate journey. After
   * retentionDays a daily cron (src/retention.ts) deletes name and message
   * and reduces the email to its domain. */
  leads: {
    retentionDays: 3,
  },

  /** The MCP endpoint (/mcp, src/mcp/server.ts). */
  mcp: {
    serverName: "eleviq-agent-journeys",
    serverTitle: "ElevIQ Solutions: journeys for AI agents",
    /** Sent with discovery and initialize, before the generated list of journeys. */
    instructions:
      "ElevIQ Solutions (eleviq.solutions) helps businesses get ready for AI agents. These tools are its agent journeys: start one with its start tool, then follow the tools named in each result. Send personal data only with your user's consent. Always end a journey, with its last step or its cancel tool and a reason. For a binding quote or a call with ElevIQ, see https://eleviq.solutions/llms.txt.",
    /** Requests with an Origin header must come from one of these (DNS-rebinding
     * protection, required by the MCP spec). Requests without one are allowed:
     * server-side connectors send none. */
    allowedOrigins: [
      "https://eleviq.solutions",
      "https://agents.eleviq.solutions",
      "https://claude.ai",
      "https://chatgpt.com",
      "http://localhost",
      "http://127.0.0.1",
    ],
    /** How long clients may cache server/discover and tools/list. */
    listTtlMs: 3_600_000,
  },

  /** Reject request bodies larger than this. */
  maxBodyBytes: 32_000,
} as const;
