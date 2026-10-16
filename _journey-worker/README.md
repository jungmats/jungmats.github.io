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
| `price-estimate` | `estimate` (repeatable) → `close`, or the built-in cancel | Indicative price at once. `close` ends it and stores the user's email as a commitment signal (ElevIQ never contacts anyone about an estimate); without an email the agent cancels, with a reason and optional feedback fields (`cancel` in the definition). No email is sent |

## Two transports: HTTP and MCP

Both run the same operations (`src/operations.ts`): the same engine checks, rate
limits and event log. Only parsing and rendering differ.

- **HTTP** (`src/routes/protocol.ts`): `POST /api/journey/start` and so on. Next
  steps are links to POST to.
- **MCP** (`src/mcp/`): `POST /mcp`, Streamable HTTP, JSON responses only,
  stateless. The tools are generated from the definitions when the Worker loads:
  `start_<journey>`, `<journey>_<step>`, `cancel_<journey>` and `get_journey`, with
  hyphens turned into underscores. A new definition brings its tools; a definition
  that breaks a tool rule (invalid or duplicate name, a step field named
  `journey_id`) fails the deploy. Next steps name the tool to call.
  - The server is dual-era. Modern clients (protocol 2026-07-28) send version,
    `clientInfo` and capabilities with every request, and the headers must
    match the body. Legacy clients (2025-11-25 and earlier) use the `initialize`
    handshake; no session is kept.
  - Modern clients' `clientInfo` is logged with the start event (`mcp_client`)
    and shown on the dashboard under "MCP clients". Every MCP call also writes
    one line with the client and User-Agent to the Worker logs.
  - Definitions with `identity: "required"` get no tools, because MCP clients
    don't sign their calls.

Rate limits, per IP: 30 calls a minute for start, steps and cancel, and 3 a
minute for any step with a `sensitive` field (`src/rules.ts`).

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
  `close` step are `sensitive`, so they never reach the journey record or the
  event log. They are stored only in the `leads` table. The dashboard shows them
  under "Emails left" (select the price-estimate journey). After
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
npm test             # engine, pricing and MCP tool tests
npm run typecheck
npm run db:local     # once
npm run dev          # http://localhost:8790, dashboard at /dashboard/
```

`.dev.vars` (not committed) holds `ALLOW_UNAUTHENTICATED_ANALYTICS=1` so the
dashboard works locally without Access.

Local MCP checks: `npx @modelcontextprotocol/inspector`, pointed at
`http://localhost:8790/mcp` (transport "Streamable HTTP").

Test the retention cron locally with `npx wrangler dev --test-scheduled`, then
open `http://localhost:8790/__scheduled?cron=17+3+*+*+*`.

## Staging

A separate Worker, `eleviq-agent-journeys-staging`, on its `workers.dev` URL, with
its own D1 (`eleviq-agent-journeys-staging`) and rate-limit namespaces. It never
touches `agents.eleviq.solutions` or the production data. Its dashboard is closed
(no `ACCESS_AUD`); read its data with
`npx wrangler d1 execute eleviq-agent-journeys-staging --env staging --remote --command "…"`.

```bash
npm run db:staging       # once: applies schema.sql
npm run deploy:staging   # tests, then deploy
```

Locally against the staging config (no production routes, so links stay on localhost):
`npx wrangler dev --env staging --persist-to <dir>`.

A change goes to staging first, then to production with `npm run deploy`. If
production misbehaves, `npx wrangler rollback` restores the previous version.

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
   - Run one `price-estimate` journey through to `close`, then check that it
     appears under "Emails left" on the dashboard.
6. Only then publish the `llms.txt` section that points agents here.
