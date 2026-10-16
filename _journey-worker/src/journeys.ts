/**
 * The journey definitions this Worker serves. Adding a journey: drop a JSON
 * file in definitions/ and list it here. Every definition is linted when the
 * Worker loads, so a broken one fails the deploy, not an agent.
 */
import { DefinitionError, lintDefinition } from "./engine/definitions";
import type { JourneyDefinition } from "./engine/types";
import { HANDLERS } from "./handlers";
import { config } from "./config";

import siteVisit from "../definitions/site-visit.json";
import priceEstimate from "../definitions/price-estimate.json";

const ALL = [siteVisit, priceEstimate] as unknown as JourneyDefinition[];

/** Checks the engine cannot make, because they depend on this Worker. */
function checkDeployment(def: JourneyDefinition): JourneyDefinition {
  const errs: string[] = [];
  for (const [name, step] of Object.entries(def.steps)) {
    if (step.handler && !(step.handler in HANDLERS)) errs.push(`step "${name}": unknown handler "${step.handler}"`);
    if (step.user_binding) errs.push(`step "${name}": user_binding is not supported by this Worker yet`);
  }
  if (def.id === "price-estimate") {
    const configured = Object.keys(config.pricing.options).sort().join(",");
    const ids = (e: unknown[] | undefined) => (e ?? []).map(String).filter((v) => v !== "none").sort().join(",");
    if (ids(def.steps.estimate?.fields.properties.options?.items?.enum) !== configured) {
      errs.push(`step "estimate": options enum must equal config.pricing.options (${configured})`);
    }
    if (ids(def.steps.finish?.fields.properties.preferred_option?.enum) !== configured) {
      errs.push(`step "finish": preferred_option enum must equal config.pricing.options plus "none"`);
    }
  }
  if (errs.length) throw new DefinitionError(`journey "${def.id}" is invalid:\n  - ${errs.join("\n  - ")}`);
  return def;
}

export const DEFINITIONS: ReadonlyMap<string, JourneyDefinition> = new Map(
  ALL.map((d) => {
    const def = checkDeployment(lintDefinition(d));
    return [def.id, def] as const;
  }),
);
