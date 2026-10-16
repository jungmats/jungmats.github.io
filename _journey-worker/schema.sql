-- ElevIQ Agent Journey Worker database (eleviq.solutions).
--
--   npm run db:local
--   npm run db:remote

-- One row per journey. Only fields a definition marks `log: true` are stored
-- (step_data); fields marked `sensitive` (emails, names, messages) never are.
CREATE TABLE IF NOT EXISTS journeys (
  id                   TEXT PRIMARY KEY,      -- "jrn_" + 128 random bits, base32. A credential: never shown on the dashboard
  ref                  TEXT NOT NULL UNIQUE,  -- public reference for the dashboard: sha-256(id), first 16 hex chars
  definition_id        TEXT NOT NULL,
  definition_version   INTEGER NOT NULL,
  status               TEXT NOT NULL,         -- active | achieved | not_achieved | cancelled | abandoned
  end_reason           TEXT,
  end_detail           TEXT,
  alternative_chosen   TEXT,
  keyid                TEXT,                  -- binding key; null when started unsigned
  agent_name           TEXT,                  -- verified agent name
  trust_tier           TEXT,
  intent               TEXT NOT NULL,         -- the intent envelope, JSON
  intent_kind          TEXT NOT NULL,         -- envelope.intent, for grouping
  human_present        INTEGER NOT NULL,
  completeness         REAL NOT NULL,         -- 0..1 share of optional envelope fields supplied
  completed_steps      TEXT NOT NULL,         -- JSON array
  step_data            TEXT NOT NULL,         -- JSON: per step, log:true fields only
  reconstructed_prompt TEXT,                  -- template reconstruction, refreshed on every accepted step
  transport            TEXT NOT NULL,         -- http | mcp
  traceparent          TEXT,                  -- W3C Trace Context, if the agent sent one
  revision             INTEGER NOT NULL,      -- optimistic concurrency
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,         -- idle timeout; lazily turned into "abandoned"
  ended_at             TEXT
);

CREATE INDEX IF NOT EXISTS journeys_created ON journeys (created_at DESC);
CREATE INDEX IF NOT EXISTS journeys_def_status ON journeys (definition_id, status);

-- One row per call attempt, accepted or rejected. Field NAMES only, never values.
CREATE TABLE IF NOT EXISTS journey_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  journey_id     TEXT,                        -- null for a refused start
  definition_id  TEXT,
  ts             TEXT NOT NULL,
  step           TEXT NOT NULL,               -- "start", a step name, "cancel", or "verification-code"
  outcome        TEXT NOT NULL,               -- accepted | rejected
  reason         TEXT,                        -- rejection reason code
  status         INTEGER NOT NULL,            -- HTTP status returned
  details        TEXT,                        -- JSON: offending field names, missing steps
  keyid          TEXT,
  transport      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS journey_events_journey ON journey_events (journey_id, ts);
CREATE INDEX IF NOT EXISTS journey_events_def ON journey_events (definition_id, ts);

-- Contact details left with step "follow-up" of the price-estimate journey. The only
-- table holding personal data, readable only behind Cloudflare Access. After
-- purge_after (config.leads.retentionDays) the daily cron deletes name and
-- message and reduces email to its domain (src/retention.ts).
CREATE TABLE IF NOT EXISTS leads (
  journey_ref  TEXT PRIMARY KEY,              -- journeys.ref, links the lead to its journey on the dashboard
  created_at   TEXT NOT NULL,
  purge_after  TEXT NOT NULL,
  purged_at    TEXT,
  email        TEXT NOT NULL,                 -- full address until purged, then "@domain"
  name         TEXT,
  company      TEXT,
  message      TEXT,
  options      TEXT NOT NULL,                 -- JSON array of option ids
  total        REAL NOT NULL,                 -- the estimate at follow-up time
  currency     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS leads_purge ON leads (purged_at, purge_after);
CREATE INDEX IF NOT EXISTS leads_created ON leads (created_at DESC);
