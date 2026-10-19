-- ETS 1.7.0 — deleting users (soft delete: the account is archived, its history is kept).
--
-- A deleted user keeps their row, so every name in the history (audit_log.username / user_id, functions.updated_by,
-- removed_by, disabled_by, edit requests, import batches, settings, branding…) still resolves. audit_log and auth_log
-- (hash-chained and append-only, migration 012) are never touched: the deletion only adds rows to them.
--   deleted_at / deleted_by / delete_reason   when, by whom and why (reason required by the API: 3–500 characters)
-- A deleted user can never sign in (routes/auth.js, middleware/auth.js treat them as inactive), is left out of the
-- Users list, the Excel export, the bulk import's "username taken" check and the administrator count.
-- The username — and the e-mail address, when it has a unique index — become free for a new account: uniqueness
-- only applies to accounts that are not deleted (partial unique indexes). A deleted account can be restored only
-- while its username and e-mail are still free.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by    integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delete_reason text;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_delete_reason_check;
ALTER TABLE users ADD CONSTRAINT users_delete_reason_check
  CHECK (delete_reason IS NULL OR char_length(delete_reason) <= 500);

-- Username: unique among accounts that are not deleted (citext: case-insensitive).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_live_key ON users(username) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS users_deleted_at ON users(deleted_at) WHERE deleted_at IS NOT NULL;

-- E-mail: when an earlier migration (014, sign-in by e-mail) created a unique index or constraint on the e-mail
-- column, it is recreated with the same name and definition, limited to accounts that are not deleted. Without
-- such an index nothing is done.
DO $$
DECLARE
  ix record;
  def text;
BEGIN
  FOR ix IN
    SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS def,
           pg_get_expr(i.indpred, i.indrelid) AS pred, c.conname
      FROM pg_index i
      LEFT JOIN pg_constraint c ON c.conindid = i.indexrelid AND c.conrelid = i.indrelid
     WHERE i.indrelid = 'users'::regclass AND i.indisunique
       AND pg_get_indexdef(i.indexrelid) ~* '\memail\M'
  LOOP
    IF ix.pred IS NOT NULL AND ix.pred ~* 'deleted_at' THEN
      CONTINUE;                                          -- already limited to accounts that are not deleted
    END IF;
    def := regexp_replace(ix.def, '\s+WHERE\s+.*$', '', 'i');
    def := def || ' WHERE ' || CASE WHEN ix.pred IS NULL THEN '' ELSE '(' || ix.pred || ') AND ' END || 'deleted_at IS NULL';
    IF ix.conname IS NOT NULL THEN
      EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', ix.conname);
    ELSE
      EXECUTE 'DROP INDEX ' || ix.name;
    END IF;
    EXECUTE def;
  END LOOP;
END $$;
