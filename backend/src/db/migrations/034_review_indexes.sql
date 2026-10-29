-- ETS — index tidy-up on function_notes, from the database-design review (DB-4), plus a documented deferral (DB-3).
--
-- DB-4 — function_notes indexing. The only reads of this table are per-item, newest-first
-- (services/notes.js): activeNoteText / recordNoteHistory do
--   SELECT ... WHERE function_id=$1 [AND <active>] ORDER BY created_at DESC, id DESC LIMIT 1
-- and noteHistory does
--   SELECT ... WHERE function_id=$1 ORDER BY created_at, id.
-- Migration 031 created two indexes: function_notes_function_id_idx (function_id) and
-- function_notes_created_at_idx (created_at). The standalone created_at index serves NO query — there is no
-- global time-ordered scan of notes — so it is pure write/maintenance overhead. What the hot query actually
-- wants is a composite leading with function_id and carrying the ORDER BY columns, so the per-item lookup is an
-- index range scan with no extra sort. Postgres can read a plain-ASC composite backwards, so one index serves
-- both the DESC (activeNoteText / recordNoteHistory) and the ASC (noteHistory) orderings; id is included as the
-- tie-break the queries actually sort on. Forward-only and idempotent (IF NOT EXISTS / IF EXISTS).
CREATE INDEX IF NOT EXISTS function_notes_fn_recent
  ON function_notes (function_id, created_at, id);

-- Drop the now-redundant standalone created_at-only index from migration 031 (name: function_notes_created_at_idx).
DROP INDEX IF EXISTS function_notes_created_at_idx;

-- (function_notes_function_id_idx is left in place: it is strictly covered by the composite above and could be
-- dropped too, but removing it is outside the scope of this review item and leaving it is harmless.)

-- ---------------------------------------------------------------------------------------------------------------
-- DB-3 — scoped audit-log read (routes/logs.js scopeFilter): DEFERRED, no index added. Rationale:
--
-- The scoped (non-full-scope) audit read filters with
--   l.entity='function' AND l.entity_id ~ '^[0-9]+$' AND l.entity_id::int IN (SELECT id FROM functions WHERE ...)
-- so the ::int cast makes entity_id non-sargable against audit_log(entity, entity_id). The review's suggested fix
-- was a partial expression index:
--   CREATE INDEX ... ON audit_log (((entity_id)::int)) WHERE entity='function' AND entity_id ~ '^[0-9]+$';
-- We do NOT add it, for two reasons:
--
--   1. NOT PROVABLY SAFE TO BUILD. The predicate `entity_id ~ '^[0-9]+$'` rejects non-numeric text but does NOT
--      bound the numeric length, so an all-digit entity_id wider than int4 (e.g. a 20-digit string) still matches
--      the predicate yet overflows on `::int`, raising "integer out of range" at INDEX-BUILD time. audit_log.entity_id
--      is free text; although entity='function' rows are written only with real int4 function ids today, nothing in
--      the schema guarantees that for all historical/arbitrary data, so the build cannot be guaranteed to succeed on
--      every deployment. (A truly safe predicate would also have to cap the value within int4 range.)
--   2. NOT PROVABLY USED. The query shape is `expr IN (SELECT ...)` — a semi-join. Postgres normally plans this as a
--      hash/merge semi-join that does not drive off an index on the outer expression, so the expression index may
--      never be chosen; this cannot be confirmed on a small/seeded database.
--
-- Per the review guidance (correctness over forcing a fix), DB-3 is deferred rather than risk a migration that
-- could fail to build or add an unused index. The query logic in routes/logs.js is intentionally left unchanged.
