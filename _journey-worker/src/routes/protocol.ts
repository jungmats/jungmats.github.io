/**
 * The protocol over HTTP:
 *
 *   POST /api/journey/start
 *   GET  /api/journey/{id}
 *   POST /api/journey/{id}/steps/{step}
 *   POST /api/journey/{id}/cancel
 *
 * Each handler parses the request, runs the operation (src/operations.ts)
 * and renders it: next steps as links to POST to. Every refusal on a journey
 * carries the next steps and the cancel link, so an agent can recover on its own.
 */
import { json, problem, readJson } from "../http";
import { identify } from "../adapters/identity";
import { nextSteps } from "../engine/engine";
import {
  cancelJourney, journeyView, journeyViewTail, readJourney, runStep, startJourney,
  type OpContext, type OpResult,
} from "../operations";
import type { JourneyDefinition, JourneyState } from "../engine/types";
import type { Env } from "../env";

type Ctx = { env: Env; ctx: ExecutionContext; origin: string; now: Date };

function links(def: JourneyDefinition, s: JourneyState, origin: string) {
  const base = `${origin}/api/journey/${s.id}`;
  const out: Record<string, string> = { self: base, definition: `${origin}/journeys/${def.id}` };
  if (s.status === "active") out.cancel = `${base}/cancel`;
  return out;
}

function next(def: JourneyDefinition, s: JourneyState, origin: string) {
  return nextSteps(def, s).map((n) => ({
    ...n,
    method: "POST",
    href: `${origin}/api/journey/${s.id}/steps/${n.step}`,
  }));
}

function view(def: JourneyDefinition, s: JourneyState, origin: string, extra: Record<string, unknown> = {}) {
  return {
    ...journeyView(s),
    next_steps: next(def, s, origin),
    ...journeyViewTail(s),
    links: links(def, s, origin),
    ...extra,
  };
}

function render(r: OpResult, origin: string): Response {
  if (r.ok) return json(view(r.def, r.state, origin, r.extra), r.status);
  const j = r.journey;
  return problem(r.problem, {
    ...r.extra,
    ...(j
      ? { journey_status: j.state.status, completed_steps: j.state.completedSteps, next_steps: next(j.def, j.state, origin), links: links(j.def, j.state, origin) }
      : {}),
  });
}

async function opContext(request: Request, c: Ctx): Promise<OpContext> {
  return {
    ...c,
    transport: "http",
    ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
    identified: await identify(request),
    traceparent: request.headers.get("traceparent"),
  };
}

export async function handleStart(request: Request, c: Ctx): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  return render(await startJourney(await opContext(request, c), parsed.body), c.origin);
}

export async function handleGet(request: Request, c: Ctx, id: string): Promise<Response> {
  return render(await readJourney(await opContext(request, c), id), c.origin);
}

export async function handleStep(request: Request, c: Ctx, id: string, stepName: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  return render(await runStep(await opContext(request, c), id, stepName, parsed.body), c.origin);
}

export async function handleCancel(request: Request, c: Ctx, id: string): Promise<Response> {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  return render(await cancelJourney(await opContext(request, c), id, parsed.body), c.origin);
}
