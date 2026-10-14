-- ETS 0.8.0 — add / remove / restore functions in any application.
--
-- A removed function is kept (soft removal) so it can be restored and so the catalog seed never re-creates
-- it: removed_at is set and enabled is false, so it counts nowhere in the calculations. Any function can be
-- removed (design, vendor list, experience or custom), with a mandatory reason. Data-entry users' additions,
-- removals and restores wait for the department team lead like their other edits.

ALTER TABLE functions
  ADD COLUMN IF NOT EXISTS removed_at     timestamptz,
  ADD COLUMN IF NOT EXISTS removed_by     integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS removed_reason text,
  ADD COLUMN IF NOT EXISTS created_at     timestamptz,
  ADD COLUMN IF NOT EXISTS created_by     integer REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE edit_requests DROP CONSTRAINT IF EXISTS edit_requests_kind_check;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_kind_check
  CHECK (kind IN ('function','bulk','report','add_function','remove_function','restore_function'));

-- Team members get permission 'tog' (include / exclude, add, remove) — set in src/db/seed.js; their changes
-- wait for the department team lead like all their edits.
