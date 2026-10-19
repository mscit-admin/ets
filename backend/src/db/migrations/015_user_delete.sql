-- ETS 1.7.0 — deleting users (soft delete: the account is archived, its history is kept).
--
-- A deleted user keeps their row, so every name in the history (audit_log.username / user_id, functions.updated_by,
-- removed_by, disabled_by, edit requests, import batches, settings, branding…) still resolves. audit_log and auth_log
-- (hash-chained and append-only, migration 012) are never touched: the deletion only adds rows to them.
--   deleted_at / deleted_by / delete_reason   when, by whom and why (reason required by the API: 3–500 characters)
-- A deleted user can never sign in (routes/auth.js, middleware/auth.js treat them as inactive), is left out of the
-- Users list, the Excel export, the bulk import's "username taken" check and the administrator count.
-- The username and the e-mail address become free for a new account: uniqueness
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


-- E-mail (1.6.0, migration 014): users_email_lower_uniq is limited to accounts that are not deleted. The function of
-- migration 014 is replaced so that every later call (migrate.js runs it at each start while the index is missing)
-- builds the same partial index: duplicates are counted among accounts that are not deleted, and an index built
-- without the deleted_at condition (by 014) is rebuilt with it. Same name, so routes/users.js still recognises it.
CREATE OR REPLACE FUNCTION ets_ensure_email_unique_index() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  dups  jsonb;
  ats   jsonb;
  pred  text;
BEGIN
  SELECT pg_get_expr(i.indpred, i.indrelid) INTO pred FROM pg_index i WHERE i.indexrelid = to_regclass('users_email_lower_uniq');
  IF to_regclass('users_email_lower_uniq') IS NOT NULL THEN
    IF pred ~* 'deleted_at' THEN
      RETURN true;
    END IF;
    DROP INDEX users_email_lower_uniq;        -- the 1.6.0 shape: rebuilt below (no duplicate can exist, it was unique)
  END IF;
  SELECT jsonb_agg(jsonb_build_object('email', e, 'accounts', n) ORDER BY e) INTO dups
    FROM (SELECT lower(email::text) AS e, count(*) AS n FROM users
          WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL GROUP BY 1 HAVING count(*) > 1) d;
  IF dups IS NOT NULL THEN
    SELECT jsonb_agg(username::text ORDER BY username) INTO ats FROM users WHERE position('@' IN username) > 0 AND deleted_at IS NULL;
    RAISE NOTICE 'ETS: % e-mail address(es) are used by more than one account; the unique e-mail index was not created. Signing in by e-mail is refused for these addresses until each account has its own address (Users screen), then run npm run migrate again. Addresses: %',
      jsonb_array_length(dups), (SELECT string_agg(x->>'email', ', ') FROM jsonb_array_elements(dups) x);
    INSERT INTO system_log(level, event, message, detail)
    VALUES ('warn', 'email_index_skipped',
            'Unique e-mail index not created: some e-mail addresses are used by more than one account',
            jsonb_build_object('duplicates', dups, 'usernames_with_at', COALESCE(ats, '[]'::jsonb)));
    RETURN false;
  END IF;
  CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email::text))
    WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL;
  RETURN true;
END $$;

SELECT ets_ensure_email_unique_index();
