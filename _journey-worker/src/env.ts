/** The journey Worker's bindings: see wrangler.toml. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Per-IP limit on POST calls (start, steps, cancel). */
  WRITE_LIMITER?: RateLimit;
  /** Per-IP limit on steps with a sensitive field (contact details). */
  CONTACT_LIMITER?: RateLimit;
  /** AUD tag of the Cloudflare Access application guarding the dashboard. */
  ACCESS_AUD?: string;
  /** "1" in .dev.vars only: serve the dashboard without Access locally. */
  ALLOW_UNAUTHENTICATED_ANALYTICS?: string;
  /** Optional: sent as a bearer token by the webhook sink. */
  JOURNEY_WEBHOOK_SECRET?: string;
  /** Secret: marks ElevIQ's own test journeys (X-ElevIQ-Internal proof; requirements INT-2). */
  ELEVIQ_INTERNAL_TOKEN?: string;
  /** "true" only on ElevIQ's own deployment: accept the published demo signing key (LOG-8). */
  ACCEPT_DEMO_SIGNATURES?: string;
  /** "true" shows internal journeys on the dashboard, with a banner (INT-4). Consultant only. */
  SHOW_INTERNAL?: string;
}
