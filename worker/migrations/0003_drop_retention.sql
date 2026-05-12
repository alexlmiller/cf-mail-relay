-- 0003: drop the unused retention_days settings row.
--
-- The settings table seeded a `retention_days` row in 0001_init.sql, but the
-- Worker never reads it (there is no retention job). Dropping the orphan to
-- keep the surface honest. If retention is added later, a future migration
-- can reintroduce the key with the implementing code.

DELETE FROM settings WHERE key = 'retention_days';

UPDATE settings
   SET value_json = '3',
       updated_at = unixepoch()
 WHERE key = 'schema_version';
