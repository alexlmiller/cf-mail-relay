-- 0004: store the SMTP relay hostname for client setup instructions.

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('smtp_host', 'null', unixepoch());

UPDATE settings
   SET value_json = '4',
       updated_at = unixepoch()
 WHERE key = 'schema_version';
