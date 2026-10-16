/**
 * Lead retention, run by the daily cron (wrangler.toml [triggers]). Once a
 * lead is past purge_after (config.leads.retentionDays after it was left),
 * its name and message are deleted and its email is reduced to "@domain".
 * The estimate itself (options, total, company) stays for analysis.
 */
import type { Env } from "./env";

export async function purgeLeads(env: Env, now: Date): Promise<number> {
  const res = await env.DB.prepare(
    `UPDATE leads
        SET email = '@' || lower(substr(email, instr(email, '@') + 1)),
            name = NULL,
            message = NULL,
            purged_at = ?
      WHERE purged_at IS NULL AND purge_after <= ?`,
  )
    .bind(now.toISOString(), now.toISOString())
    .run();
  return res.meta.changes ?? 0;
}
