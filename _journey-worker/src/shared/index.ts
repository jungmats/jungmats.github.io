// GENERATED from eleviq-lab/shared — do not edit here; run scripts/sync-shared.mjs
/**
 * Shared visitor classification — public API.
 * Edit only in eleviq-lab/shared; other repos get a synced copy
 * (scripts/sync-shared.mjs). See README.md.
 */
export * from "./signatures.ts";
export * from "./derive.ts";
export * from "./signature-check.ts";
export * from "./internal-marker.ts";

import legendEn from "./legend.en.json" with { type: "json" };
import legendFr from "./legend.fr.json" with { type: "json" };

export type Legend = typeof legendEn;
export const LEGENDS: Readonly<Record<"en" | "fr", Legend>> = { en: legendEn, fr: legendFr };
