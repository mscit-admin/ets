-- ETS 0.9.0 — readable audit trail.
--
-- `context` holds what a reader needs to understand a change without looking anything up: how the change
-- came in (direct edit, approved edit request, imported team file), who asked for it and who approved it,
-- and — for changes that touch many items at once (bulk set, edit requests, imports) — the list of items
-- with their value before and after. old_value / new_value keep the before → after of the row's own entity.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS context jsonb;
