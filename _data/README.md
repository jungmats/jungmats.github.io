# Prices on the website

Not served on eleviq.solutions (Jekyll skips folders that start with `_`), but readable by anyone on GitHub: the repo is public.

`_data/prices.json` is the only place where website prices live. The master price list is
`~/Documents/Consulting/consulting-methodology/price-list.md`. This file holds only its
**public** part: only offers that are shown on the website. This repo is public, so don't mention unpublished offers or prices here.

## Change a price

1. Edit the price in `_data/prices.json` (and in `price-list.md`).
2. Run from the repo root:
   ```bash
   node _tools/build-prices.mjs
   ```
3. Run the worker tests: `cd _journey-worker && npm test`.
4. Push the site **and** deploy the worker: `cd _journey-worker && npm run deploy`.
   The worker reads `prices.json` when it is built, so the quote service keeps the old prices until it is deployed again.

## Add a new public offer

1. Add an entry to `offers` in `prices.json`:
   - `id`: lowercase with hyphens, e.g. `new-offer`. It becomes the page anchor, the JSON-LD id and the quote service option.
   - `service`: the page it belongs to (`ai-agent-readiness` or `agentic-web-monetization`).
   - `name` and `summary` in `en` and `fr`.
   - `price` (a number, 0 = free), `from` (true for a "from" price), `unit` (`once` or `month`), optional `minimum_months`.
   - `estimate`: true if the quote service should price it. Only allowed for paid one-off offers. An offer with a setup fee plus a monthly fee would need a code change in `_journey-worker/src/pricing.ts` first.
2. On **both** language pages of that service, write the card or line by hand and give it the anchor and a price marker:
   ```html
   <div class="offering-card" id="new-offer">
     <h3>…</h3>
     <p>…</p>
     <p class="price"><!-- price:new-offer --><!-- /price:new-offer --></p>
   </div>
   ```
   Leave the marker empty: the script fills it ("€99 excl. VAT", "à partir de 490 € HT", …).
3. Run the steps under "Change a price".

To remove an offer, delete its entry and its card or line on both pages, then run the same steps.

## What the script writes (never edit these by hand)

| File | Generated part |
|--|--|
| `services/*.html`, `fr/services/*.html` | the `Service` JSON-LD between `<!-- prices:jsonld -->` markers; each price between `<!-- price:<id> -->` markers |
| `index.html`, `fr/index.html` | the list of services between `<!-- prices:catalog -->` markers |
| `_journey-worker/definitions/price-estimate.json` | the `options` and `preferred_option` lists |
| `_journey-worker/definitions/site-visit.json` | the `services` list |
| `llms.txt` | the "List prices" section |

All other text on the pages (card descriptions, FAQ, "quoted from the site report…") is hand-written. If it mentions an offer by name, update it yourself.

## Safety checks

- `node _tools/build-prices.mjs --check` changes nothing and fails if any generated part is out of date.
- The script writes nothing if a page is missing a price marker or an anchor for one of its offers, or has a marker for an unknown offer.
- The worker refuses to start if its journey definitions and `prices.json` disagree, and `npm test` checks the same.

## Why prices must be visible

Google requires structured data to match what the page shows, and AI agents quote visible text most reliably. So a price goes into the JSON-LD only if it is also shown on the page, and the script makes sure it always is.
