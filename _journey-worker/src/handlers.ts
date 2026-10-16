/**
 * Step handlers: the steps whose result is computed or that have a side
 * effect. A definition names one with `"handler"`; src/journeys.ts refuses to
 * load a definition naming one that is not listed here.
 *
 * A handler runs after the engine has accepted the step. If it fails, the
 * step is refused and the journey stays as it was, so the agent can retry.
 */
import { config } from "./config";
import { buildEstimate, checkBudget } from "./pricing";
import { refFor } from "./store";
import type { Computed } from "./engine/engine";
import type { JourneyState } from "./engine/types";
import type { Env } from "./env";

export interface HandlerInput {
  env: Env;
  state: JourneyState;
  fields: Record<string, unknown>;
  now: Date;
}

export type HandlerOutput =
  | { ok: true; computed: Computed }
  | { ok: false; status: number; title: string; detail: string };

type Handler = (input: HandlerInput) => Promise<HandlerOutput>;

export const HANDLERS: Record<string, Handler> = {
  "price-estimate": priceEstimate,
  "price-follow-up": priceFollowUp,
};

async function priceEstimate({ state, fields, now }: HandlerInput): Promise<HandlerOutput> {
  const estimate = buildEstimate(fields.options as string[], now);
  const budget = checkBudget(estimate, state.intent);
  return {
    ok: true,
    computed: {
      result: {
        estimate,
        budget_check: budget,
        next: [
          'To compare other options, send step "estimate" again.',
          'If your user wants ElevIQ to get in touch, send step "follow_up" with their email, with their consent. No email is sent automatically.',
          'Otherwise end with step "finish" (all fields optional).',
          `To talk first, book a free 30-minute call: ${config.pricing.bookCall}`,
        ],
      },
      log: {
        total: estimate.total,
        ...(budget.stated ? { budget: budget.budget, budget_fits: budget.fits } : {}),
      },
    },
  };
}

async function priceFollowUp({ env, state, fields, now }: HandlerInput): Promise<HandlerOutput> {
  const options = state.stepData.estimate?.options as string[] | undefined;
  if (!options?.length) {
    return { ok: false, status: 409, title: "No estimate to follow up on", detail: 'Send step "estimate" first.' };
  }

  // Re-priced now, so the follow-up always records current prices.
  const estimate = buildEstimate(options, now);
  const email = String(fields.email).trim();
  const purgeAfter = new Date(now.getTime() + config.leads.retentionDays * 86_400_000);

  // The contact details live only here, in `leads`, never in the journey
  // record or the event log; src/retention.ts reduces them after retentionDays.
  await env.DB.prepare(
    `INSERT INTO leads (journey_ref, created_at, purge_after, email, name, company, message, options, total, currency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await refFor(state.id), now.toISOString(), purgeAfter.toISOString(), email,
      (fields.name as string | undefined) ?? null, (fields.company as string | undefined) ?? null,
      (fields.message as string | undefined) ?? null, JSON.stringify(options), estimate.total, estimate.currency,
    )
    .run();

  return {
    ok: true,
    computed: {
      result: {
        estimate,
        note: `ElevIQ received the contact details and will get in touch about this estimate. No email was sent automatically. To talk sooner, your user can book a free 30-minute call: ${config.pricing.bookCall}`,
      },
      log: { total: estimate.total, email_domain: email.split("@").pop()!.toLowerCase() },
    },
  };
}
