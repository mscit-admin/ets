-- ETS — structure management (add / edit / archive departments and applications from the UI).
--
-- Adds a soft-delete ("archive") marker to departments and applications, mirroring functions.removed_at and
-- users.deleted_at. An archived row keeps all its history (moves, imports, edit requests, audit) but is taken OUT of
-- every calculation and every "pick a department / application" list — exactly like a removed function. Nothing is
-- ever hard-deleted, so archiving is fully reversible (restore clears the marker).
--
-- Also introduces the `str` permission ("manage structure") and grants it to the roles that already administer the
-- project (anyone holding `cfg` OR `apv_final` — administrators and project managers). Forward-only and idempotent;
-- seed.js carries the same column defaults and the same grant so a fresh database matches this migration.

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by    integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS archive_reason text;

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS archived_at    timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by    integer REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS archive_reason text;

-- partial indexes: the hot path is "the live (non-archived) rows", so index exactly those
CREATE INDEX IF NOT EXISTS departments_live_idx  ON departments (sort)  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS applications_live_idx  ON applications (sort) WHERE archived_at IS NULL;

-- `str` — manage the project structure (create / edit / archive departments and applications). Granted to the roles
-- that already hold cfg or apv_final; per-user overrides (user_permissions) are untouched.
UPDATE roles
  SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['str']) AS p)
  WHERE NOT ('str' = ANY(permissions))
    AND ('cfg' = ANY(permissions) OR 'apv_final' = ANY(permissions));
