# Backend "audit offert"

Standalone Apps Script for the unlisted free-audit page at
`/fr/audit-offert/`. Independent from the booking backend — its own Google
Sheet, its own Web App deployment.

## One-time setup

1. Create a new Google Sheet (e.g. "ElevIQ — Audits offerts"). Copy its id
   from the URL: `docs.google.com/spreadsheets/d/`**`<SHEET_ID>`**`/edit`.
2. Open the Apps Script project. Either route works:
   - **From the Sheet** (simplest): Extensions → Apps Script. The script is
     then bound to that Sheet and step 4 is optional.
   - **Standalone**: script.google.com → New project. Then step 4 is
     required.
   Delete the stub, paste `Code.gs`, save. Rename the project (top-left) to
   "ElevIQ — Audits offerts".
3. Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   Approve the consent screen (Advanced → "Go to … (unsafe)" → Allow — this
   is normal for your own script; the sensitive scope is just "send email as
   you").
4. Project Settings → Script Properties → add **`SHEET_ID`** = the id from
   step 1. (Skip only if the script is bound to the Sheet per step 2.)
5. Copy the `/exec` URL. Paste it into `fr/audit-offert/index.html` as
   `API_URL` (replace `REPLACE_WITH_AUDIT_APPS_SCRIPT_URL`). Open that
   `/exec` URL in a browser — it must return
   `{"version":"2026-09-03-audit-offert-v2"}`. If it shows an error page,
   the deployment or the URL is wrong.
6. First submission creates a `FreeAudits` tab with the header row. You can
   also create it by hand:

   | Code | Campagne | Claimed At | Name | Email | Website | Lang |
   |------|----------|-----------|------|-------|---------|------|

## Troubleshooting "something went wrong"

- Open the `/exec` URL directly. Not JSON → wrong URL, or you copied the
  editor / `/dev` URL instead of the deployment's `/exec` URL.
- Page shows the error but `/exec` returns the version JSON → open the
  browser console on the page; the backend reason is logged there.
  `server_error` with a `detail` about "No spreadsheet" → set `SHEET_ID`
  (step 4).
- After any `Code.gs` edit you must publish a **new version** of the
  deployment (see below), otherwise the old code stays live.

## Granting free audits

Add one row per available audit. Fill only **Code** (and optionally
**Campagne**, free text, for your own tracking). Leave the other columns
blank — the script fills them when the audit is claimed.

- Same code on N rows = N audits available under that code.
- Codes are matched case-insensitively and trimmed.
- Share the link as `https://eleviq.solutions/fr/audit-offert/?code=THECODE`
  to pre-fill the code field.

Example:

| Code        | Campagne          | Claimed At | Name | Email | Website | Lang |
|-------------|-------------------|-----------|------|-------|---------|------|
| LINKEDIN-01 | Post LinkedIn sept |            |      |       |         |      |
| LINKEDIN-01 | Post LinkedIn sept |            |      |       |         |      |
| PARTENAIRE-X | Intro via X       |            |      |       |         |      |

## Behaviour

- Code has a free row → row filled, confirmation email to requester +
  notification to `matthias.jung@eleviq.solutions`, page shows
  "Félicitations !".
- Code exhausted or unknown → nothing written, notification email to you
  only, page shows "Désolé, plus de places".

## After editing `Code.gs`

Deploy → Manage deployments → edit the existing deployment → **New version**.
Bump `CODE_VERSION` in the file first so a plain GET to the `/exec` URL
confirms which version is live.

## Optional

- Script Property `SIGNATURE_FR` overrides the email signature without a
  redeploy (use literal `\n` for line breaks).
