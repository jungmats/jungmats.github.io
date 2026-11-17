-- Journey evidence signals (agent-analytics requirements JRN-2; same rules as the site logger's LOG-1).
--
--   npx wrangler d1 execute eleviq-agent-journeys-staging --env staging --remote --file migrations/0002_journey_evidence.sql
--   npx wrangler d1 execute eleviq-agent-journeys --remote --file migrations/0002_journey_evidence.sql
--
-- Additive only: existing journeys get NULL (internal gets 0), and the running Worker names its
-- INSERT columns, so it keeps working. sig_status NULL marks a journey started before this change.

ALTER TABLE journeys ADD COLUMN sig_status TEXT;
ALTER TABLE journeys ADD COLUMN sig_agent TEXT;
ALTER TABLE journeys ADD COLUMN cf_bot_category TEXT;
ALTER TABLE journeys ADD COLUMN ua_match TEXT;
ALTER TABLE journeys ADD COLUMN ua_raw TEXT;
ALTER TABLE journeys ADD COLUMN mcp_client TEXT;
ALTER TABLE journeys ADD COLUMN internal INTEGER NOT NULL DEFAULT 0;
