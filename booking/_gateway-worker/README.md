# ElevIQ booking gateway (Cloudflare Worker)

One Worker, two doors to the existing Apps Script booking backend:

- **HTTP API** for autonomous agents: `GET /slots`, `POST /book`, `POST /waitlist` (documented in `/llms.txt`)
- **MCP server** for connected assistants (Claude, etc.): `POST /mcp`, tools `list_slots` / `book_slot` / `join_waitlist`

Every booking that passes the gateway is stamped with attribution
(self-declared `via` field, User-Agent, Cloudflare verified-bot signal, and
— if the request is signed — a verified Web Bot Auth identity, see
`src/verify.js`), which the Apps Script stores in the Bookings sheet and
mentions in both emails. Rate limiting: 5 booking attempts/min/IP, 60 other
requests/min/IP.

The human booking page (`/booking/`) does **not** use the gateway — it
keeps talking to the Apps Script directly.

## Web Bot Auth (agent-readiness checklist 4.1)

Production port of the eleviq-lab Demo 1 pattern. `src/verify.js` checks any
`Signature`/`Signature-Input` headers against two trust tiers — our own
committed demo key (`keys/booking-agent.jwk.json`, published at
`https://eleviq.solutions/.well-known/http-message-signatures-directory`)
and a small allow-list of real operators (currently `chatgpt.com`, fetched
live). This is **additive**: unsigned requests work exactly as before; a
valid signature only adds a `signed_agent` field to attribution and a
`web_bot_auth` field to the API/MCP response.

Nonce replay protection needs a KV namespace that doesn't exist yet — see
the commented-out `[[kv_namespaces]]` block in `wrangler.toml` for the
one-time `wrangler kv namespace create` step. Until that's created,
signature verification still runs fully; only replay detection is skipped.

Test signing a request against this gateway (mirrors
`eleviq-lab/docs/reference/sign-request.mjs`):

```bash
node sign-request.mjs --url https://eleviq-booking-gateway.gateway-worker.workers.dev/book --send
```

(script + usage in this directory — see `sign-request.mjs`).

## Deploy

```bash
cd booking/_gateway-worker
npm install           # one-time (installs web-bot-auth)
npx wrangler login    # one-time, opens the browser
npx wrangler deploy   # prints the *.workers.dev URL
```

The `_` prefix keeps this directory out of the published GitHub Pages
site (Jekyll skips underscore paths), same as `../_apps-script/`.

## Smoke test

```bash
BASE=https://eleviq-booking-gateway.gateway-worker.workers.dev
curl $BASE/                # API self-description
curl "$BASE/slots?lang=en" # slot list from the live backend
# MCP handshake:
curl -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

Full attribution requires the extended `../_apps-script/Code.gs`
(version `2026-09-18-signed-agent-attribution`) to be pasted into the Apps
Script project and redeployed; until then bookings via the gateway work
but the attribution fields are ignored. Also add the fourth header cell
`Signed Agent` (after `Via | Agent UA | Verified Bot`) to the Bookings and
Waitlist sheets — that column is new, for Web Bot Auth.
