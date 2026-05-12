-- cf-mail-relay D1 schema, version 1.
--
-- All metadata-only — no message bodies, subjects, or attachment contents are ever stored.

PRAGMA foreign_keys = ON;

------------------------------------------------------------------------------
-- users
------------------------------------------------------------------------------

CREATE TABLE users (
  id              TEXT PRIMARY KEY,                                       -- ulid
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  access_subject  TEXT,                                                   -- CF Access JWT sub
  role            TEXT NOT NULL CHECK (role IN ('admin','sender')),
  disabled_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

------------------------------------------------------------------------------
-- domains
------------------------------------------------------------------------------

CREATE TABLE domains (
  id                 TEXT PRIMARY KEY,
  domain             TEXT UNIQUE NOT NULL,
  cloudflare_zone_id TEXT,
  status             TEXT NOT NULL,                                       -- pending|verified|sandbox|disabled
  dkim_status        TEXT,
  spf_status         TEXT,
  dmarc_status       TEXT,
  enabled            INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

------------------------------------------------------------------------------
-- allowlisted_senders
------------------------------------------------------------------------------

CREATE TABLE allowlisted_senders (
  id          TEXT PRIMARY KEY,
  domain_id   TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,                                              -- full address, or '*@<domain>' wildcard
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (domain_id, email)
);

------------------------------------------------------------------------------
-- smtp_credentials
------------------------------------------------------------------------------

CREATE TABLE smtp_credentials (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  username                TEXT UNIQUE NOT NULL,
  secret_hash             TEXT NOT NULL,                                  -- HMAC-SHA256(CREDENTIAL_PEPPER, secret) hex
  hash_version            INTEGER NOT NULL DEFAULT 1,
  allowed_sender_ids_json TEXT,                                           -- NULL = inherit user's senders
  created_at              INTEGER NOT NULL,
  last_used_at            INTEGER,
  last_used_ip_hash       TEXT,                                           -- HMAC(METADATA_PEPPER, ip)
  revoked_at              INTEGER
);

------------------------------------------------------------------------------
-- api_keys
------------------------------------------------------------------------------

CREATE TABLE api_keys (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  key_prefix              TEXT UNIQUE NOT NULL,                           -- first 8 chars; regenerated on collision
  secret_hash             TEXT NOT NULL,
  hash_version            INTEGER NOT NULL DEFAULT 1,
  scopes_json             TEXT,
  allowed_sender_ids_json TEXT,
  created_at              INTEGER NOT NULL,
  last_used_at            INTEGER,
  revoked_at              INTEGER
);

------------------------------------------------------------------------------
-- send_events  (audit log; metadata only)
------------------------------------------------------------------------------

CREATE TABLE send_events (
  id                     TEXT PRIMARY KEY,
  ts                     INTEGER NOT NULL,
  trace_id               TEXT NOT NULL,
  source                 TEXT NOT NULL CHECK (source IN ('smtp','http')),
  user_id                TEXT,
  credential_id          TEXT,
  api_key_id             TEXT,
  domain_id              TEXT,
  envelope_from          TEXT NOT NULL,
  recipient_count        INTEGER NOT NULL,
  recipient_domains_hash TEXT,                                            -- HMAC(METADATA_PEPPER, sorted_unique_domains)
  mime_size_bytes        INTEGER NOT NULL,
  message_id_hash        TEXT,                                            -- HMAC(METADATA_PEPPER, Message-ID header)
  cf_request_id          TEXT,
  cf_ray_id              TEXT,
  cf_delivered_json      TEXT,
  cf_queued_json         TEXT,
  cf_bounced_json        TEXT,
  status                 TEXT NOT NULL,                                   -- categorical; see plan
  smtp_code              TEXT,
  error_code             TEXT,                                            -- categorical only; never raw provider text
  cf_error_code          TEXT
);
CREATE INDEX idx_send_events_ts     ON send_events(ts DESC);
CREATE INDEX idx_send_events_status ON send_events(status, ts DESC);
CREATE INDEX idx_send_events_trace  ON send_events(trace_id);

------------------------------------------------------------------------------
-- auth_failures
------------------------------------------------------------------------------

CREATE TABLE auth_failures (
  id                 TEXT PRIMARY KEY,
  ts                 INTEGER NOT NULL,
  source             TEXT NOT NULL,
  remote_ip_hash     TEXT,                                                -- HMAC(METADATA_PEPPER, ip)
  attempted_username TEXT,
  reason             TEXT                                                 -- categorical failure reason, including bootstrap/auth setup failures
);
CREATE INDEX idx_auth_failures_ts ON auth_failures(ts DESC);

------------------------------------------------------------------------------
-- rate_reservations (strict per-window caps)
------------------------------------------------------------------------------

CREATE TABLE rate_reservations (
  id          TEXT PRIMARY KEY,
  scope_type  TEXT NOT NULL,                                              -- sender_minute|sender_day|domain_day|credential_day|global_day
  scope_key   TEXT NOT NULL,
  day         TEXT NOT NULL,                                              -- UTC bucket: YYYY-MM-DD or YYYY-MM-DDTHH:MM
  count       INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  UNIQUE (scope_type, scope_key, day)
);

------------------------------------------------------------------------------
-- idempotency_keys
------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  idempotency_key TEXT PRIMARY KEY,
  request_hash    TEXT NOT NULL,                                          -- sha256 of normalized request input
  source          TEXT NOT NULL,                                          -- smtp|http
  status          TEXT NOT NULL,                                          -- pending|completed|failed
  response_json   TEXT,                                                   -- cached response on completed/failed
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL                                        -- created_at + 24h
);
CREATE INDEX idx_idempotency_expires ON idempotency_keys(expires_at);

------------------------------------------------------------------------------
-- settings  (single source for global config + schema version + policy_version)
------------------------------------------------------------------------------

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Seed required settings rows.
INSERT INTO settings (key, value_json, updated_at) VALUES
  ('schema_version',   '1',                                                   unixepoch()),
  ('policy_version',   '1',                                                   unixepoch()),
  ('retention_days',   '90',                                                  unixepoch()),
  ('daily_cap_global', 'null',                                                unixepoch());
