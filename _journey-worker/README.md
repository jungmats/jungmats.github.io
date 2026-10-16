# ElevIQ Agent Journey Worker

The Agent Journey Protocol from ElevIQ Lab (`eleviq-lab/AGENT-JOURNEY-PROTOCOL.md`),
deployed for eleviq.solutions with its own Worker, D1 database and dashboard.
Agents declare their intent, get a `journey_id`, and move through steps; every
attempt is logged, so journeys read as funnels.

Host: `agents.eleviq.solutions`. The agent API is public, while `/dashboard/` and
`/api/analytics/` require Cloudflare Access.

## Journeys

| Journey | Steps | Purpose |
|---|---|---|
| `site-visit` | `report` | An assistant reading the site declares why and reports what it concluded |
| `price-estimate` | `estimate` (repeatable) → `finish` or `follow_up` | Indicative price at once. `follow_up` stores contact details so ElevIQ can get in touch; `finish` ends without them. No email is sent |

Prices and options: `src/config.ts` (`pricing.options`). The `options` and
`preferred_option` enums in `definitions/price-estimate.json` must list the same
ids, and the Worker refuses to load if they differ.

## What differs from the Lab

- **Computed steps.** A step can name a `handler` (`src/handlers.ts`). It runs
  after the engine accepts the step. If it fails, the step is refused with
  `upstream-failed` and the journey is unchanged.
- **Repeatable steps.** `"repeatable": true` lets a completed step be sent again.
  Its logged data is updated: fields sent again replace the earlier values, fields
  left out keep them.
- **`welcome`** in a definition is returned with the start response.
- **Contact details in one place.** `email`, `name` and `message` from the
  `follow_up` step are `sensitive`, so they never reach the journey record or the
  event log. They are stored only in the `leads` table. The dashboard shows them
  under "Follow-up requests" (select the price-estimate journey). After
  `config.leads.retentionDays` (3), a daily cron (`src/retention.ts`) deletes the
  name and message and reduces the email to `@domain`.
- **Nothing is sent.** The Worker sends no email and calls no other service.
- **Access checked in the Worker** (`src/access.ts`), not only at the edge. It
  fails closed when `ACCESS_AUD` is unset.
- **No identity verification or verification codes yet.** All callers are
  unsigned. Email confirmation codes are the next step.

## Develop

```bash
npm install
npm test             # engine + pricing tests
npm run typecheck
npm run db:local     # once
npm run dev          # http://localhost:8790, dashboard at /dashboard/
```

`.dev.vars` (not committed) holds `ALLOW_UNAUTHENTICATED_ANALYTICS=1` so the
dashboard works locally without Access.

Test the retention cron locally with `npx wrangler dev --test-scheduled`, then
open `http://localhost:8790/__scheduled?cron=17+3+*+*+*`.

## First deploy

1. `npx wrangler d1 create eleviq-agent-journeys`. Paste the id into `wrangler.toml`.
2. `npm run db:remote`
3. **Cloudflare Access** (Zero Trust dashboard): add a self-hosted application for
   `agents.eleviq.solutions` with the paths `/dashboard` and `/api/analytics`,
   using the same identity provider and email policy as `insights.eleviq.solutions`.
   Copy its **Application Audience (AUD) tag**, then run
   `npx wrangler secret put ACCESS_AUD`.
4. Uncomment `[[routes]]` in `wrangler.toml`, then run `npm run deploy`.
5. Verify:
   - `https://agents.eleviq.solutions/` returns 200.
   - `/dashboard/` redirects to the Access login.
   - `https://eleviq-agent-journeys.<subdomain>.workers.dev/dashboard/` returns 403.
   - Run one `price-estimate` journey through to `follow_up`, then check that it
     appears under "Follow-up requests" on the dashboard.
6. Only then publish the `llms.txt` section that points agents here.
