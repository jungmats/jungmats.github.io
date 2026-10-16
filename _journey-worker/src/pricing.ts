/**
 * Price estimation. Pure, so it runs under `node --test`: prices come from
 * config, the budget from the intent envelope's constraints.
 *
 * v1 pricing is deliberately simple: a fixed indicative price per option,
 * summed, no package discounts. website_url, platform and deadline are
 * collected for analysis but do not change the price yet.
 */
import { config } from "./config.ts";

export interface EstimateLine {
  option: string;
  title: string;
  price: number;
  summary: string;
  page: string;
}

export interface Estimate {
  currency: string;
  lines: EstimateLine[];
  total: number;
  vat: string;
  indicative: true;
  prices_as_of: string;
  valid_until: string;
  conditions: string;
}

export type BudgetCheck =
  | { stated: false; note: string }
  | { stated: true; budget: number; currency: string; fits: boolean; options_within_budget: string[] };

const BUDGET_FIELD = /^(price|budget|cost|total|spend)/i;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** The user's budget, if the intent states one as a price ceiling in EUR. */
export function budgetOf(intent: Record<string, unknown>): { value: number; strict: boolean } | null {
  const constraints = Array.isArray(intent.constraints) ? intent.constraints : [];
  for (const c of constraints) {
    if (typeof c !== "object" || c === null) continue;
    const { field, op, value, unit } = c as Record<string, unknown>;
    if (typeof field !== "string" || !BUDGET_FIELD.test(field)) continue;
    if (op !== "lte" && op !== "lt") continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (unit !== undefined && !/^(eur|€)$/i.test(String(unit).trim())) continue;
    return { value, strict: op === "lt" };
  }
  return null;
}

export function buildEstimate(options: string[], now: Date): Estimate {
  const lines = options.map((id) => {
    const o = config.pricing.options[id];
    return { option: id, title: o.title, price: o.price, summary: o.summary, page: o.page };
  });
  return {
    currency: config.pricing.currency,
    lines,
    total: lines.reduce((sum, l) => sum + l.price, 0),
    vat: config.pricing.vat,
    indicative: true,
    prices_as_of: day(now),
    valid_until: day(new Date(now.getTime() + config.pricing.validityDays * 86_400_000)),
    conditions: config.pricing.conditions,
  };
}

export function checkBudget(estimate: Estimate, intent: Record<string, unknown>): BudgetCheck {
  const b = budgetOf(intent);
  if (!b) {
    return {
      stated: false,
      note: 'No budget in EUR found in the intent. Send one as a constraint, e.g. {"field": "price", "op": "lte", "value": 2000, "unit": "EUR"}, to get a fit check.',
    };
  }
  const within = (price: number) => (b.strict ? price < b.value : price <= b.value);
  return {
    stated: true,
    budget: b.value,
    currency: config.pricing.currency,
    fits: within(estimate.total),
    options_within_budget: Object.entries(config.pricing.options)
      .filter(([, o]) => within(o.price))
      .map(([id]) => id),
  };
}
