/** Deployment rules derived from a definition, shared by every transport. Pure. */
import type { JourneyDefinition } from "./engine/types.ts";

/** A step whose fields include a sensitive one (contact details) gets the strict rate limit. */
export function storesContact(def: JourneyDefinition, step: string): boolean {
  const props = def.steps[step]?.fields.properties ?? {};
  return Object.values(props).some((f) => f.sensitive);
}
