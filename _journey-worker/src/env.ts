/** The journey Worker's bindings: see wrangler.toml. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Per-IP limit on POST calls (start, steps, cancel). */
  WRITE_LIMITER?: RateLimit;
  /** Per-IP limit on the step that stores contact details. */
  CONTACT_LIMITER?: RateLimit;
  /** AUD tag of the Cloudflare Access application guarding the dashboard. */
  ACCESS_AUD?: string;
  /** "1" in .dev.vars only: serve the dashboard without Access locally. */
  ALLOW_UNAUTHENTICATED_ANALYTICS?: string;
  /** Optional: sent as a bearer token by the webhook sink. */
  JOURNEY_WEBHOOK_SECRET?: string;
}
