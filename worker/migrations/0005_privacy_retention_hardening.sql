-- 0005: tighten idempotency privacy + cleanup retention.
--
-- Old idempotency rows may contain provider response payloads with recipient
-- addresses. Drop them instead of trying to rewrite arbitrary JSON shapes; the
-- replay cache is short-lived and duplicate-send protection resumes on new
-- requests.

DELETE FROM idempotency_keys;

DELETE FROM auth_failures
 WHERE ts < unixepoch() - (30 * 24 * 60 * 60);

DELETE FROM rate_reservations
 WHERE updated_at < unixepoch() - (8 * 24 * 60 * 60);

UPDATE settings
   SET value_json = '5',
       updated_at = unixepoch()
 WHERE key = 'schema_version';
