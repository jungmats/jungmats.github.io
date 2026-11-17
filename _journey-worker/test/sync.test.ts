/**
 * src/shared/ is a generated copy of eleviq-lab/shared (scripts/sync-shared.mjs there).
 * This test fails when a file in the copy was edited by hand: edit in eleviq-lab and re-sync.
 * Whether the copy is up to date is checked from eleviq-lab (`npm run check:journey`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

const DIR = new URL("../src/shared/", import.meta.url);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

test("the shared copy matches its manifest (no hand edits)", () => {
  const manifest: Record<string, string> = JSON.parse(readFileSync(new URL("SHARED_MANIFEST.json", DIR), "utf8"));
  const files = readdirSync(DIR).filter((f) => f !== "SHARED_MANIFEST.json").sort();
  assert.deepEqual(files, Object.keys(manifest).sort(), "files listed in the manifest");
  for (const f of files) {
    assert.equal(sha256(readFileSync(new URL(f, DIR), "utf8")), manifest[f], `${f} was edited by hand — edit eleviq-lab/shared and re-sync`);
  }
});
