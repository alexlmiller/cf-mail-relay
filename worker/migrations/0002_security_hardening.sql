-- Security hardening schema, version 2.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS relay_nonces (
  key_id     TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, nonce)
);
CREATE INDEX IF NOT EXISTS idx_relay_nonces_expires ON relay_nonces(expires_at);

UPDATE send_events
   SET cf_delivered_json = CASE
         WHEN cf_delivered_json IS NULL THEN NULL
         WHEN json_valid(cf_delivered_json) THEN
           CASE
             WHEN json_type(cf_delivered_json) = 'array' THEN json_object('count', json_array_length(cf_delivered_json))
             ELSE json_object('count', NULL)
           END
         ELSE json_object('count', NULL)
       END,
       cf_queued_json = CASE
         WHEN cf_queued_json IS NULL THEN NULL
         WHEN json_valid(cf_queued_json) THEN
           CASE
             WHEN json_type(cf_queued_json) = 'array' THEN json_object('count', json_array_length(cf_queued_json))
             ELSE json_object('count', NULL)
           END
         ELSE json_object('count', NULL)
       END,
       cf_bounced_json = CASE
         WHEN cf_bounced_json IS NULL THEN NULL
         WHEN json_valid(cf_bounced_json) THEN
           CASE
             WHEN json_type(cf_bounced_json) = 'array' THEN json_object('count', json_array_length(cf_bounced_json))
             ELSE json_object('count', NULL)
           END
         ELSE json_object('count', NULL)
       END
 WHERE cf_delivered_json IS NOT NULL
    OR cf_queued_json IS NOT NULL
    OR cf_bounced_json IS NOT NULL;

UPDATE settings
   SET value_json = '2',
       updated_at = unixepoch()
 WHERE key = 'schema_version';
