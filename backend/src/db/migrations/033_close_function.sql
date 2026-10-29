-- ETS — close / lock a completed function (final endorsement).
--
-- A user holding the final approval (apv_final — «الاعتماد النهائي (مدير المشروع / الفني)») closes a function that is
-- finished and needs nothing further. A closed function is LOCKED from editing (progress, test / notification / review
-- status, weight, enabled, note, type, rename, remove, move) until it is reopened; the only state changes allowed on it
-- are closing and reopening.
--
-- IMPORTANT — a closed function is NOT excluded from the percentage / weight calculation. It stays counted and is
-- treated as 100 % complete in the weighted progress (services/calc.js). This is the opposite of an excluded / removed
-- item (which leaves the calculation): closing ≠ excluding.
--
-- A function is closed iff closed_at IS NOT NULL. The close itself is captured by closed_at / closed_by and an
-- audit_log row (action 'close'); reopening is appended to function_reopenings (the official document + the reason +
-- who / when) and written to the audit log (action 'reopen'). Forward-only and idempotent.

ALTER TABLE functions
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_by integer REFERENCES users(id) ON DELETE SET NULL;

-- Append-only reopen audit. Reopening requires an attached official document (a real file: PDF or image) AND a written
-- reason, both mandatory. The document is stored in the database as bytes, like the branding images (migration 003), so
-- it is backed up with everything else; doc_name / doc_mime / doc_size keep its metadata for serving and display.
CREATE TABLE IF NOT EXISTS function_reopenings (
  id          bigserial PRIMARY KEY,
  function_id integer     NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  reopened_by integer     REFERENCES users(id) ON DELETE SET NULL,
  reopened_at timestamptz NOT NULL DEFAULT now(),
  reason      text        NOT NULL,
  doc_name    text        NOT NULL,
  doc_mime    text        NOT NULL,
  doc_size    integer     NOT NULL,
  doc_data    bytea       NOT NULL
);

CREATE INDEX IF NOT EXISTS function_reopenings_function_idx ON function_reopenings(function_id, reopened_at DESC);
