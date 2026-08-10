-- 0006: extend SMTP duplicate-delivery protection across the v1.1 upgrade.
--
-- v1.0 retained all idempotency rows for 24 hours. v1.1 keeps SMTP rows for
-- seven days so Gmail's roughly 48-hour retry window cannot outlive the
-- duplicate-send fence. Preserve that guarantee for rows created before the
-- Worker upgrade; HTTP API idempotency remains unchanged at 24 hours.

UPDATE idempotency_keys
   SET expires_at = MAX(expires_at, created_at + (7 * 24 * 60 * 60))
 WHERE source = 'smtp';

UPDATE settings
   SET value_json = '6',
       updated_at = unixepoch()
 WHERE key = 'schema_version';
