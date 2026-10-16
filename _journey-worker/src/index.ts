/**
 * ElevIQ Agent Journey Worker: the Agent Journey Protocol for eleviq.solutions.
 *
 * An agent declares its intent, gets a journey_id, and moves through steps
 * that are accepted only in order and only with the information each asks
 * for. Every attempt is logged, so journeys read as funnels. The protocol is
 * the one built in ElevIQ Lab (eleviq-lab/AGENT-JOURNEY-PROTOCOL.md); this is
 * a separate deployment with its own data, for real visitors.
 *
 *   GET  /                                          this description
 *   GET  /.well-known/agent-journeys                discovery
 *   GET  /.well-known/api-catalog                   RFC 9727 API catalog
 *   GET  /journeys/{id}[/openapi.json|/arazzo.json] definition and derived descriptions
 *   POST /api/journey/start                         intent handshake
 *   GET  /api/journey/{journey_id}                  state
 *   POST /api/journey/{journey_id}/steps/{step}     perform a step
 *   POST /api/journey/{journey_id}/cancel           end it with a reason
 *   GET  /api/analytics/summary|journeys[/{ref}]|leads  dashboard data   (Cloudflare Access)
 *   GET  /dashboard/                                the dashboard        (Cloudflare Access)
 *
 * Emails left with step close live only in the `leads` table; a daily
 * cron reduces them after config.leads.retentionDays. No email is sent.
 *
 * The engine (src/engine/) is pure and tested with `npm test`.
 */
import { config } from "./config";
import { discoveryLinks, json, preflight, problem, withHeaders } from "./http";
import { handleApiCatalog, handleDefinition, handleWellKnown, PROTOCOL } from "./routes/discovery";
import { handleCancel, handleGet, handleStart, handleStep } from "./routes/protocol";
import { handleDetail, handleLeads, handleList, handleSummary } from "./routes/analytics";
import { checkAccess } from "./access";
import { purgeLeads } from "./retention";
import type { Env } from "./env";

/** Shown at /. Bump it with every deploy that
 * changes what agents see, so a deploy can be checked from outside. */
const VERSION = "2026-10-16-v2";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return preflight();
    try {
      return withHeaders(await route(request, url, env, ctx), url.origin);
    } catch (err) {
      console.error(err);
      return withHeaders(json({ error: "journey_error", detail: String((err as Error)?.message ?? err) }, 500), url.origin);
    }
  },

  /** Daily: reduce leads past their retention period (src/retention.ts). */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(purgeLeads(env, new Date()).then((n) => console.log(`lead retention: ${n} lead(s) reduced`)));
  },
};

async function route(request: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const origin = url.origin;
  const m = request.method;
  const c = { env, ctx, origin, now: new Date() };

  if (path === "/dashboard" || path.startsWith("/dashboard/") || path.startsWith("/api/analytics/")) {
    const access = await checkAccess(request, env);
    if (!access.ok) return problem({ status: 403, reason: "bad-request", title: "Access required", detail: access.detail });
    if (path === "/dashboard" && !url.pathname.endsWith("/")) return Response.redirect(`${origin}/dashboard/`, 301);
    if (path.startsWith("/dashboard")) return env.ASSETS.fetch(request);
  }

  if (m === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const storesContact = /\/steps\/close$/.test(path);
    const limiter = storesContact ? env.CONTACT_LIMITER : env.WRITE_LIMITER;
    if (limiter && !(await limiter.limit({ key: ip })).success) {
      return problem({ status: 429, reason: "bad-request", title: "Too many requests", detail: "Slow down and retry in a minute." });
    }
  }

  if (path === "/" && m === "GET") return info(origin);
  if (path === "/.well-known/agent-journeys" && m === "GET") return handleWellKnown(origin);
  if (path === "/.well-known/api-catalog" && (m === "GET" || m === "HEAD")) return handleApiCatalog(origin);

  let r = /^\/journeys\/([a-z0-9-]+)(?:\/(openapi|arazzo)\.json)?$/.exec(path);
  if (r && m === "GET") return handleDefinition(r[1], origin, (r[2] as "openapi" | "arazzo") ?? "definition");

  if (path === "/api/journey/start" && m === "POST") return handleStart(request, c);

  r = /^\/api\/journey\/([^/]+)$/.exec(path);
  if (r && m === "GET") return handleGet(request, c, r[1]);
  r = /^\/api\/journey\/([^/]+)\/steps\/([^/]+)$/.exec(path);
  if (r && m === "POST") return handleStep(request, c, r[1], r[2]);
  r = /^\/api\/journey\/([^/]+)\/cancel$/.exec(path);
  if (r && m === "POST") return handleCancel(request, c, r[1]);

  if (config.analytics.enabled && m === "GET") {
    if (path === "/api/analytics/summary") return handleSummary(env, url);
    if (path === "/api/analytics/journeys") return handleList(env, url);
    if (path === "/api/analytics/leads") return handleLeads(env, url);
    r = /^\/api\/analytics\/journeys\/([^/]+)$/.exec(path);
    if (r) return handleDetail(env, r[1]);
  }

  return problem(
    { status: 404, reason: "bad-request", title: "Not found", detail: "GET / describes this service; GET /.well-known/agent-journeys lists the journeys." },
  );
}

function info(origin: string): Response {
  return json({
    service: "ElevIQ Solutions: journeys for AI agents",
    protocol: PROTOCOL,
    version: VERSION,
    what: "Tell ElevIQ why you are visiting (journey \"site-visit\"), or estimate the price of an engagement (journey \"price-estimate\").",
    note: "Agent Journey Protocol: an ElevIQ convention, not a ratified standard.",
    start_here: `${origin}/.well-known/agent-journeys`,
    api_catalog: `${origin}/.well-known/api-catalog`,
    instructions: config.site,
    link: discoveryLinks(origin),
  });
}
