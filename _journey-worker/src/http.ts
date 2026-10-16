/** Response helpers for the journey Worker. */
import { config } from "./config";
import type { Rejection } from "./engine/types";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, Signature, Signature-Input, Signature-Agent, traceparent",
  "access-control-expose-headers": "Link",
  "access-control-max-age": "600",
};

/** Every response points at the discovery documents (RFC 8288 Link, RFC 9727 api-catalog). */
export function discoveryLinks(origin: string): string {
  return [
    `<${origin}/.well-known/agent-journeys>; rel="describedby"; type="application/json"`,
    `<${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  ].join(", ");
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra },
  });
}

/** application/problem+json (RFC 9457) from an engine rejection. */
export function problem(r: Pick<Rejection, "status" | "reason" | "title" | "detail">, extra: Record<string, unknown> = {}): Response {
  const body = {
    type: `${config.site}#${r.reason}`,
    title: r.title,
    status: r.status,
    detail: r.detail,
    reason: r.reason,
    ...extra,
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: r.status,
    headers: { "content-type": "application/problem+json; charset=utf-8", ...CORS },
  });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function withHeaders(response: Response, origin: string): Response {
  const r = new Response(response.body, response);
  r.headers.set("X-Robots-Tag", "noindex, nofollow");
  if (!r.headers.has("Link")) r.headers.set("Link", discoveryLinks(origin));
  return r;
}

export type ParsedBody = { ok: true; body: unknown } | { ok: false; response: Response };

/** Reads a JSON body with a size cap. An empty body is `{}`. */
export async function readJson(request: Request): Promise<ParsedBody> {
  const text = await request.text();
  if (text.length > config.maxBodyBytes) {
    return { ok: false, response: problem({ status: 413, reason: "bad-request", title: "Body too large", detail: `Keep request bodies under ${config.maxBodyBytes} bytes.` }) };
  }
  if (!text.trim()) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: problem({ status: 400, reason: "bad-request", title: "Body is not valid JSON", detail: "Send a JSON object with Content-Type: application/json." }) };
  }
}
