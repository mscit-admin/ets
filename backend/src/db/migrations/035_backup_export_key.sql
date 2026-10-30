-- ETS — allow the export_key backup job (reveal / download the backup encryption key from the web UI, 1.12.x).
--
-- The approved, safe design for revealing the backup key adds a new root-agent job kind, export_key (see
-- backend/src/backup/agent.js: JOB_KINDS + HANDLERS.export_key, and backend/src/routes/backups.js: POST
-- /backups/key/export). backup_jobs.kind carries a CHECK that enumerates the allowed kinds (migration 021), so the
-- new kind must be added to it or the API cannot queue the job (already-migrated databases keep the old constraint,
-- so an ALTER is required — CREATE TABLE IF NOT EXISTS in 021 does not change an existing table).
--
-- This ONLY widens the allowed-value list by one entry. No table, column, index, or row is added or changed, and no
-- secret is involved: the plaintext backup key never touches backup_jobs (the export_key result holds only ciphertext
-- that is useless without the one-time key the API keeps in memory). Forward-only and idempotent.
ALTER TABLE backup_jobs DROP CONSTRAINT IF EXISTS backup_jobs_kind_check;
ALTER TABLE backup_jobs ADD CONSTRAINT backup_jobs_kind_check
  CHECK (kind IN ('backup_now', 'verify_now', 'test_destination', 'generate_ssh_key',
                  'set_passphrase', 'restore_inspect', 'restore_run', 'export_key'));
