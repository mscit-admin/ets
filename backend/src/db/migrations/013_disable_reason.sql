-- ETS 1.5.0 — why a function is excluded from the calculation (its checkbox unticked).
--
-- Excluding a function now needs a reason, kept on the function while it stays excluded:
--   disabled_reason  duplicate | out_of_scope | not_required | other — chosen by the user
--                    import                                         — set when an approved import file / the legacy
--                                                                      import turns the function off
--                    NULL                                           — excluded before 1.5.0 ("no reason recorded")
--   disabled_note    free text (up to 500 characters; required for 'other', the batch reference for 'import')
--   disabled_by / disabled_at   who excluded it and when (the requester, for an approved request)
-- function_duplicates lists, for a function excluded as a duplicate, the functions it duplicates (any application).
-- Including the function again clears all of this; the history stays in the audit trail (audit_log is untouched).
-- Functions are never deleted (removal is soft, migration 006); ON DELETE CASCADE only matters if an application
-- and its functions are ever deleted by hand.
-- edit_request_items.meta carries the reason of an exclusion that waits for the team lead, applied on approval.

ALTER TABLE functions
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS disabled_note   text,
  ADD COLUMN IF NOT EXISTS disabled_by     integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS disabled_at     timestamptz;

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_disabled_reason_check;
ALTER TABLE functions ADD CONSTRAINT functions_disabled_reason_check
  CHECK (disabled_reason IS NULL OR disabled_reason IN ('duplicate','out_of_scope','not_required','other','import'));
ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_disabled_note_check;
ALTER TABLE functions ADD CONSTRAINT functions_disabled_note_check
  CHECK (disabled_note IS NULL OR char_length(disabled_note) <= 500);

CREATE TABLE IF NOT EXISTS function_duplicates (
  function_id     integer NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  duplicate_of_id integer NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  PRIMARY KEY (function_id, duplicate_of_id),
  CHECK (function_id <> duplicate_of_id)
);
CREATE INDEX IF NOT EXISTS function_duplicates_target ON function_duplicates(duplicate_of_id);

ALTER TABLE edit_request_items ADD COLUMN IF NOT EXISTS meta jsonb;
