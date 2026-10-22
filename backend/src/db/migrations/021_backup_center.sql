-- ETS 1.12.0 — backups managed from Settings → «النسخ الاحتياطي» (backend/src/routes/backups.js) and carried out by the
-- root backup agent (backend/scripts/backup-agent.js, ets-backup-agent.service). The API never runs anything as root: it
-- stores the desired configuration and queues jobs here; the agent validates both again before acting.
--
-- 1) backup_config (one row): the desired configuration (backend/src/backup/config.js validateConfig), the cloud
--    credentials encrypted with an HKDF key from APP_SECRET (services/crypto.js, AAD 'backup:<name>') — write-only in the
--    API —, a version number the agent compares with the version it applied, and the administrator's attestation that
--    the backup key / passphrase is escrowed (asked again after a year, and after the key changes).
-- 2) backup_status (one row): written by the agent — applied version, last apply error, inventory of the backup files
--    (local and per destination), free disk space, next timer runs, SSH public key and host fingerprint.
-- 3) backup_jobs: queue of the whitelisted jobs. A job's parameters never hold a secret: a restore key or a new
--    passphrase travels through a root-readable, single-use file encrypted with a one-time key (params.ck), which the
--    agent deletes and wipes from the row as soon as it has read it.
-- 4) notify.backup_max_age_hours: backups are hourly from 1.12.0 — an installation still on the old default (26 h) gets
--    the new default (2 h; the scan never uses less than the backup interval + 1 h).

CREATE TABLE IF NOT EXISTS backup_config (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  config              jsonb NOT NULL,
  secrets             jsonb NOT NULL DEFAULT '{}'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  source              text NOT NULL DEFAULT 'default' CHECK (source IN ('default', 'imported', 'ui')),
  escrow_confirmed_at timestamptz,
  escrow_confirmed_by integer REFERENCES users(id) ON DELETE SET NULL,
  key_id              text CHECK (key_id IS NULL OR key_id ~ '^[0-9a-f]{16}$'),
  key_changed_at      timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          integer REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS backup_status (
  id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_version integer,
  apply_error     text,
  agent_seen_at   timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS backup_jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('backup_now', 'verify_now', 'test_destination', 'generate_ssh_key',
                                             'set_passphrase', 'restore_inspect', 'restore_run')),
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed', 'cancelled')),
  started_at   timestamptz,
  finished_at  timestamptz,
  progress     jsonb,
  result       jsonb,
  log          text CHECK (log IS NULL OR char_length(log) <= 20000)
);
CREATE INDEX IF NOT EXISTS backup_jobs_open ON backup_jobs(status, id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS backup_jobs_kind ON backup_jobs(kind, requested_at DESC);
-- one open job of a kind (per destination for the connection test)
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_one_open ON backup_jobs(kind, COALESCE(params->>'dest', ''))
  WHERE status IN ('queued', 'running');

UPDATE settings SET value = '2'::jsonb, updated_at = now()
 WHERE key = 'notify.backup_max_age_hours' AND value = '26'::jsonb;

-- the backup status (Settings → «النسخ الاحتياطي», notifications S6 / S9 / S10) reads the newest rows of these events
CREATE INDEX IF NOT EXISTS system_log_backup_events ON system_log(event, ts DESC)
  WHERE event IN ('backup', 'backup_failed', 'backup_offsite', 'backup_verify', 'restore');
