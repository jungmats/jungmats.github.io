# ElevIQ booking gateway (Cloudflare Worker)

One Worker, two doors to the existing Apps Script booking backend:

- **HTTP API** for autonomous agents: `GET /slots`, `POST /book` (documented in `/llms.txt`)
- **MCP server** for connected assistants (Claude, etc.): `POST /mcp`, tools `list_slots` / `book_slot`

Every booking that passes the gateway is stamped with attribution
(self-declared `via` field, User-Agent, Cloudflare verified-bot signal),
which the Apps Script stores in the Bookings sheet and mentions in both
emails. Rate limiting: 5 booking attempts/min/IP, 60 other requests/min/IP.

The human booking page (`/booking/`) does **not** use the gateway — it
keeps talking to the Apps Script directly.

## Deploy

```bash
cd booking/_gateway-worker
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
(version `2026-08-17-agent-attribution`) to be pasted into the Apps
Script project and redeployed; until then bookings via the gateway work
but the attribution fields are ignored. Also add the three header cells
`Via | Agent UA | Verified Bot` to the Bookings sheet.
