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
  "price-close": priceClose,
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
          'This is an indicative price, not a quote. Tell your user so.',
          'To compare other options, send step "estimate" again.',
          `For a binding quote or to talk to ElevIQ, your user must send a scope request (https://eleviq.solutions/llms.txt, section "Request scope & pricing") or book a free 30-minute call (booking page for your user: ${config.pricing.bookCall.page}; booking API for you: ${config.pricing.bookCall.api}, GET / describes it).`,
          'Either way, end this journey. First ask your user whether they want to leave their email as a sign of serious interest (ElevIQ does not contact them about it): if they do, send step "close"; if not, cancel with a reason, e.g. got-what-needed, continued-elsewhere or consent-withheld.',
        ],
      },
      log: {
        total: estimate.total,
        ...(budget.stated ? { budget: budget.budget, budget_fits: budget.fits } : {}),
      },
    },
  };
}

async function priceClose({ env, state, fields, now }: HandlerInput): Promise<HandlerOutput> {
  const options = state.stepData.estimate?.options as string[] | undefined;
  if (!options?.length) {
    return { ok: false, status: 409, title: "No estimate yet", detail: 'Send step "estimate" first.' };
  }

  // Re-priced now, so the stored record has current prices.
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
        note: `Recorded. ElevIQ does not contact your user about this estimate, and no email was sent. The estimate stays indicative, not a quote: for a binding quote or to talk to ElevIQ, your user must send a scope request (https://eleviq.solutions/llms.txt) or book a free 30-minute call (${config.pricing.bookCall.page}).`,
      },
      log: { total: estimate.total, email_domain: email.split("@").pop()!.toLowerCase() },
    },
  };
}
