/**
 * The protocol over MCP: POST /mcp, Streamable HTTP, JSON responses only,
 * stateless. Tools come from the journey definitions (src/mcp/tools.ts) and
 * run the same operations as HTTP (src/operations.ts).
 *
 * Dual-era, as the MCP spec allows:
 *   modern  (2026-07-28)               every request carries its protocol version,
 *                                      clientInfo and capabilities in params._meta;
 *                                      headers MCP-Protocol-Version, Mcp-Method and
 *                                      Mcp-Name must match the body.
 *   legacy  (2025-11-25 and earlier)   initialize handshake; no session is kept,
 *                                      so no Mcp-Session-Id is minted.
 */
import { config } from "../config";
import { DEFINITIONS } from "../journeys";
import { identify } from "../adapters/identity";
import { nextSteps } from "../engine/engine";
import { isPlainObject } from "../engine/validate";
import {
  cancelJourney, journeyView, journeyViewTail, readJourney, runStep, startJourney,
  type OpContext, type OpResult,
} from "../operations";
import { cancelTool, startTool, stepTool, toolsFor, type ToolRoute } from "./tools";
import type { JourneyDefinition, JourneyState } from "../engine/types";
import type { Env } from "../env";

const MODERN = ["2026-07-28"];
const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_VERSIONS = [...MODERN, ...LEGACY];

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT = "io.modelcontextprotocol/clientInfo";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER = "io.modelcontextprotocol/serverInfo";

/** Built once per isolate; a definition that breaks a tool rule fails at startup. */
const TOOLS = toolsFor(DEFINITIONS.values());

type Ctx = { env: Env; ctx: ExecutionContext; origin: string; now: Date };
type Id = string | number | null;
type Era = "modern" | "legacy";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Authorization, traceparent",
  "access-control-max-age": "600",
};

function send(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
}

const rpcError = (id: Id, code: number, message: string, data?: unknown, status = 200) =>
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);

export function mcpPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

export function mcpMethodNotAllowed(): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Use POST: this MCP endpoint is stateless and has no GET stream." } }), {
    status: 405,
    headers: { "content-type": "application/json", allow: "POST, OPTIONS", ...CORS },
  });
}

function originAllowed(origin: string | null): boolean {
  if (!origin) return true;
  return config.mcp.allowedOrigins.some((o) => origin === o || (o.startsWith("http://") && origin.startsWith(`${o}:`)));
}

/** Mcp-Name may be sent as =?base64?…?= (MCP Streamable HTTP, Value Encoding). */
function decodeHeader(v: string | null): string | null {
  const m = v ? /^=\?base64\?(.*)\?=$/.exec(v) : null;
  if (!m) return v;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

function instructions(): string {
  const list = [...DEFINITIONS.values()]
    .filter((d) => d.identity !== "required")
    .map((d) => `- ${startTool(d.id)}: ${d.title}.`)
    .join("\n");
  return `${config.mcp.instructions}\n\nJourneys:\n${list}`;
}

export async function handleMcp(request: Request, c: Ctx, version: string): Promise<Response> {
  if (!originAllowed(request.headers.get("Origin"))) {
    return rpcError(null, -32600, "Origin not allowed.", undefined, 403);
  }

  const text = await request.text();
  if (text.length > config.maxBodyBytes) return rpcError(null, -32600, `Request too large: keep it under ${config.maxBodyBytes} bytes.`, undefined, 413);
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "Parse error: the body must be one JSON-RPC message.", undefined, 400);
  }
  if (!isPlainObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(isPlainObject(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null, -32600, "Invalid request: send one JSON-RPC 2.0 request (batches are not supported).", undefined, 400);
  }

  // Notifications (no id) need no answer.
  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202, headers: CORS });
  const id = msg.id as Id;
  const method = msg.method;
  const params = isPlainObject(msg.params) ? msg.params : {};
  const meta = isPlainObject(params._meta) ? params._meta : {};
  const headerVersion = request.headers.get("MCP-Protocol-Version");

  const serverInfo = { name: config.mcp.serverName, title: config.mcp.serverTitle, version };

  // Legacy handshake.
  if (method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
    log(request, "legacy", requested, method, isPlainObject(params.clientInfo) ? params.clientInfo : null);
    return send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: instructions(),
      },
    });
  }

  const era: Era = META_VERSION in meta || (headerVersion !== null && MODERN.includes(headerVersion)) ? "modern" : "legacy";
  let protocol: string;
  let client: Record<string, unknown> | null = null;

  if (era === "modern") {
    const v = meta[META_VERSION];
    if (typeof v !== "string") return rpcError(id, -32602, `Invalid params: _meta["${META_VERSION}"] is required.`, undefined, 400);
    if (!MODERN.includes(v)) return rpcError(id, -32022, "Unsupported protocol version", { supported: MODERN, requested: v }, 400);
    if (!isPlainObject(meta[META_CAPS])) return rpcError(id, -32602, `Invalid params: _meta["${META_CAPS}"] is required.`, undefined, 400);
    if (headerVersion !== v) return rpcError(id, -32020, `Header mismatch: MCP-Protocol-Version header ${JSON.stringify(headerVersion)} does not match _meta version "${v}".`, undefined, 400);
    const headerMethod = request.headers.get("Mcp-Method");
    if (headerMethod !== method) return rpcError(id, -32020, `Header mismatch: Mcp-Method header ${JSON.stringify(headerMethod)} does not match method "${method}".`, undefined, 400);
    if (method === "tools/call") {
      const headerName = decodeHeader(request.headers.get("Mcp-Name"));
      if (headerName !== params.name) return rpcError(id, -32020, `Header mismatch: Mcp-Name header ${JSON.stringify(headerName)} does not match tool name ${JSON.stringify(params.name)}.`, undefined, 400);
    }
    protocol = v;
    client = isPlainObject(meta[META_CLIENT]) ? meta[META_CLIENT] : null;
  } else {
    if (headerVersion !== null && !LEGACY.includes(headerVersion)) {
      return rpcError(id, -32022, "Unsupported protocol version", { supported: [...MODERN, ...LEGACY], requested: headerVersion }, 400);
    }
    // Before 2025-06-18 clients sent no version header.
    protocol = headerVersion ?? "2025-03-26";
  }
  log(request, era, protocol, method, client);

  /** Modern results say they are complete and who answered. */
  const result = (r: Record<string, unknown>) =>
    send({ jsonrpc: "2.0", id, result: era === "modern" ? { resultType: "complete", ...r, _meta: { [META_SERVER]: serverInfo } } : r });
  const cache = era === "modern" ? { ttlMs: config.mcp.listTtlMs, cacheScope: "public" } : {};

  switch (method) {
    case "ping":
      return result({});
    case "server/discover":
      if (era !== "modern") break;
      return result({
        supportedVersions: MODERN,
        capabilities: { tools: { listChanged: false } },
        instructions: instructions(),
        ...cache,
      });
    case "tools/list":
      return result({ tools: TOOLS.tools, ...cache });
    case "tools/call": {
      const name = params.name;
      const route = typeof name === "string" ? TOOLS.routes.get(name) : undefined;
      if (!route) return rpcError(id, -32602, `Unknown tool: ${String(name)}. Call tools/list for the tools.`);
      const args = isPlainObject(params.arguments) ? params.arguments : {};
      const op: OpContext = {
        ...c,
        transport: "mcp",
        ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
        identified: await identify(request),
        traceparent: typeof meta.traceparent === "string" ? meta.traceparent : request.headers.get("traceparent"),
        client: { mcp_protocol: protocol, ...(client ? { mcp_client: clientLabel(client) } : {}) },
      };
      return result(await callTool(op, route, args));
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`, undefined, era === "modern" ? 404 : 200);
}

function clientLabel(info: Record<string, unknown>): string {
  return [info.name, info.version].filter((v) => typeof v === "string" && v).join("/").slice(0, 120);
}

/** One line per call in the Worker logs, to see which clients come and how they identify. */
function log(request: Request, era: Era, protocol: string, method: string, client: Record<string, unknown> | null): void {
  console.log(JSON.stringify({
    mcp: method, era, protocol,
    client: client ? clientLabel(client) : null,
    user_agent: (request.headers.get("User-Agent") ?? "").slice(0, 200),
  }));
}

/* -------------------------------------------------------------- tool calls */

async function callTool(c: OpContext, route: ToolRoute, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (route.op === "start") return render(await startJourney(c, { definition: route.definition, intent: args }));

  const { journey_id: journeyId, ...rest } = args;
  if (typeof journeyId !== "string" || !journeyId) {
    return toolError({
      error: { status: 422, reason: "fields-missing", title: "journey_id is missing", detail: "Send the journey_id the start tool returned, or start a new journey." },
    });
  }
  switch (route.op) {
    case "get":
      return render(await readJourney(c, journeyId));
    case "cancel":
      return render(await cancelJourney(c, journeyId, rest, route.definition));
    case "step": {
      const { human_present: humanPresent, ...fields } = rest;
      const body = { fields, ...(typeof humanPresent === "boolean" ? { human_present: humanPresent } : {}) };
      return render(await runStep(c, journeyId, route.step, body, route.definition));
    }
  }
}

/** Next steps as tools: the step's own fields are in that tool's inputSchema. */
function nextTools(def: JourneyDefinition, s: JourneyState) {
  return {
    next_steps: nextSteps(def, s).map((n) => ({
      step: n.step,
      tool: stepTool(def.id, n.step),
      title: n.title,
      description: n.description,
      require_human_present: n.require_human_present,
    })),
    ...(s.status === "active" ? { cancel_tool: cancelTool(def.id) } : {}),
  };
}

function render(r: OpResult): Record<string, unknown> {
  if (r.ok) {
    const body = { ...journeyView(r.state), ...nextTools(r.def, r.state), ...journeyViewTail(r.state), ...r.extra };
    return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: false };
  }
  const j = r.journey;
  const { status, reason, title, detail } = r.problem;
  const { start_definition: startDef, ...extra } = r.extra;
  return toolError({
    error: { status, reason, title, detail },
    ...extra,
    ...(typeof startDef === "string" ? { start_tool: startTool(startDef) } : {}),
    ...(j ? { journey_status: j.state.status, completed_steps: j.state.completedSteps, ...nextTools(j.def, j.state) } : {}),
  });
}

function toolError(body: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: true };
}
