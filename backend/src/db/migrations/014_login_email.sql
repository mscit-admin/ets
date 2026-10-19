-- ETS 1.6.0 — sign-in with the username OR the e-mail address.
--
-- A login identifier that contains "@" is looked up by e-mail (case-insensitive, lower(email)); anything else by
-- username (routes/auth.js). An e-mail address must therefore name one account only:
--   users_email_lower_uniq  UNIQUE (lower(email)) WHERE email IS NOT NULL AND email <> ''
--
-- Upgrade safety: existing data may already hold the same e-mail on several accounts (nothing prevented it before
-- 1.6.0). The migration must not fail on such data, so the index is created only when there are no duplicates;
-- otherwise it is skipped, a NOTICE is raised (printed by `npm run migrate`) and a warning row is written to
-- system_log listing the duplicated addresses. Until the index exists, signing in by e-mail is refused for an
-- address shared by several accounts (signing in by username is unaffected), and the Users screen / import refuse
-- any new duplicate. After an administrator has given each account its own address, the next `npm run migrate`
-- (run by every update) creates the index: migrate.js calls ets_ensure_email_unique_index() after the migrations.
--
-- Usernames may not contain "@" (create / update / import only accept 3–60 of A–Z a–z 0–9 . _ -), so the two
-- namespaces cannot collide. Accounts created before with "@" in the username (command line only) still sign in:
-- an identifier with "@" falls back to an exact username match when no e-mail matches. They are listed in the same
-- system_log warning so the administrator can rename them.

CREATE OR REPLACE FUNCTION ets_ensure_email_unique_index() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  dups  jsonb;
  ats   jsonb;
BEGIN
  IF to_regclass('users_email_lower_uniq') IS NOT NULL THEN
    RETURN true;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('email', e, 'accounts', n) ORDER BY e) INTO dups
    FROM (SELECT lower(email::text) AS e, count(*) AS n FROM users
          WHERE email IS NOT NULL AND email <> '' GROUP BY 1 HAVING count(*) > 1) d;
  IF dups IS NOT NULL THEN
    SELECT jsonb_agg(username::text ORDER BY username) INTO ats FROM users WHERE position('@' IN username) > 0;
    RAISE NOTICE 'ETS: % e-mail address(es) are used by more than one account; the unique e-mail index was not created. Signing in by e-mail is refused for these addresses until each account has its own address (Users screen), then run npm run migrate again. Addresses: %',
      jsonb_array_length(dups), (SELECT string_agg(x->>'email', ', ') FROM jsonb_array_elements(dups) x);
    INSERT INTO system_log(level, event, message, detail)
    VALUES ('warn', 'email_index_skipped',
            'Unique e-mail index not created: some e-mail addresses are used by more than one account',
            jsonb_build_object('duplicates', dups, 'usernames_with_at', COALESCE(ats, '[]'::jsonb)));
    RETURN false;
  END IF;
  CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email::text)) WHERE email IS NOT NULL AND email <> '';
  RETURN true;
END $$;

SELECT ets_ensure_email_unique_index();
