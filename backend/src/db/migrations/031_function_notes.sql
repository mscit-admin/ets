-- ETS 1.12.x — a tracked, auditable NOTES HISTORY for function / report items.
--
-- Before this migration each function kept a single overwritten note in functions.note: the latest text won, the
-- earlier ones were lost. This adds an append-only log table, function_notes, so every note an item ever carries is
-- kept with its author, its timestamp and its lifecycle (the member's «منتهية / غير منتهية» flag, the team lead's
-- decision «معتمدة للعمل» / «مرفوضة», the follow-up chain when a new note replaces a rejected one, and a
-- deletion that only hides a note after the team lead approves it — a note is NEVER hard-deleted, so the audit
-- trail survives). functions.note is KEPT and goes on meaning "the current active note": it is kept in sync by the
-- application with the latest active (non-deleted, non-rejected) note, so the existing "a with-notes status
-- requires a note" rule (routes/tracker.js, services/edits.js, lib/itemRules.js) and every other reader of
-- functions.note keep working unchanged. functions.note is NOT dropped or renamed.
--
-- Status model (who may do what is enforced in routes/tracker.js, reusing the existing scope helpers):
--   • the AUTHOR (the member) toggles `done` on their own notes;
--   • the TEAM LEAD (apv_dept whose scope covers the item's application, as resolved for every other approval in
--     services/edits.js — admins / project managers with full scope act as approver too) sets `decision`;
--   • DELETION needs the team lead's approval: a member requests it (delete_requested_*), the lead approves it
--     (deleted_*); nothing is hidden before that approval.
--
-- Forward-only. Idempotent where sensible: the table and its indexes are created IF NOT EXISTS, and the one-time
-- backfill of existing non-empty notes runs only while the table is still empty, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS function_notes (
  id                  bigserial PRIMARY KEY,
  function_id         integer NOT NULL REFERENCES functions(id) ON DELETE CASCADE,  -- the item the note belongs to
  body                text NOT NULL,                                                -- the note text (never empty)
  author_id           integer REFERENCES users(id) ON DELETE SET NULL,             -- who wrote it (null = unknown / backfilled)
  created_at          timestamptz NOT NULL DEFAULT now(),                           -- when it was written
  done                boolean NOT NULL DEFAULT false,                               -- the author's «منتهية / غير منتهية» flag
  -- the team lead's decision: null = pending, 'approved' = «معتمدة للعمل», 'rejected' = «مرفوضة»
  decision            text CHECK (decision IN ('approved', 'rejected')),
  decided_by          integer REFERENCES users(id) ON DELETE SET NULL,             -- the team lead who decided
  decided_at          timestamptz,
  -- a new note that replaces a rejected one (the follow-up chain): points at the rejected note it supersedes
  replaces            bigint REFERENCES function_notes(id) ON DELETE SET NULL,
  -- soft-delete with the team lead's approval: a member REQUESTS deletion, the lead APPROVES it; the row is only
  -- then hidden (deleted_at set), never removed, so the history is never lost.
  delete_requested_by integer REFERENCES users(id) ON DELETE SET NULL,
  delete_requested_at timestamptz,
  deleted_by          integer REFERENCES users(id) ON DELETE SET NULL,
  deleted_at          timestamptz
);
CREATE INDEX IF NOT EXISTS function_notes_function_id_idx ON function_notes(function_id);
CREATE INDEX IF NOT EXISTS function_notes_created_at_idx ON function_notes(created_at);

-- One-time backfill: so no history is lost, each existing non-empty functions.note becomes one function_notes row.
-- The note's original author is unknown (functions.note kept no author), so author_id is null; created_at is the
-- function's last change time (functions.updated_at — the closest available note change time), else now() by
-- DEFAULT. Runs only while the table is empty, so re-running the migration never duplicates the backfill.
INSERT INTO function_notes (function_id, body, author_id, created_at)
SELECT f.id, btrim(f.note), NULL, f.updated_at
  FROM functions f
 WHERE btrim(COALESCE(f.note, '')) <> ''
   AND NOT EXISTS (SELECT 1 FROM function_notes);
