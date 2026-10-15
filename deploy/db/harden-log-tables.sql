-- ETS — protection of the audit trail in the database (ETS-SEC-013): the application role may only READ and
-- APPEND the change history (audit_log) and the sign-in log (auth_log).
--
-- Migration 012 makes the two tables append-only (triggers) and hash-chained. This script also takes away the
-- application role's ownership, so that whoever can run SQL as that role (for example after a compromise of the
-- server account) cannot drop the triggers or rewrite the chain:
--   - a role without login (log_owner, default ets_log_owner) owns the log tables, the chain functions and
--     schema "public";
--   - the application role keeps CREATE on the schema and owns all other tables, gets SELECT + INSERT on the log
--     tables, SELECT on the chain tables and sequences (pg_dump), and EXECUTE on ets_purge_log() (retention purge).
--
-- Applied AUTOMATICALLY for a local database by deploy/install.sh and deploy/scripts/update.sh, through
-- /usr/local/sbin/ets-log-protect (deploy/scripts/log-protect.sh), which also applies later migrations and
-- restores as the superuser so that they keep working. For a database on another server the DBA runs it as a
-- superuser (see docs/handover/07-Logging-and-Audit.md §3):
--   psql -v ON_ERROR_STOP=1 -v db_user=ets -v log_owner=ets_log_owner -d ets -f harden-log-tables.sql
-- Safe to run again (idempotent). Before migration 012 is applied it changes nothing and says so.
-- When ets-log-protect includes this file inside its own transaction it sets the psql variable ets_wrapped.

\set ON_ERROR_STOP on
SELECT to_regclass('public.log_chain_head') IS NOT NULL AS ets_has_chain \gset
\if :ets_has_chain
SELECT format('CREATE ROLE %I NOLOGIN', :'log_owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'log_owner') \gexec

\if :{?ets_wrapped}
\else
BEGIN;
\endif
SET LOCAL search_path = public, pg_catalog;
-- the schema owner may drop any table in it: the schema moves to the log owner, the application keeps CREATE
ALTER SCHEMA public OWNER TO :"log_owner";
GRANT USAGE, CREATE ON SCHEMA public TO :"db_user";

ALTER TABLE audit_log OWNER TO :"log_owner";
ALTER TABLE auth_log OWNER TO :"log_owner";
ALTER TABLE log_chain_head OWNER TO :"log_owner";
ALTER TABLE log_chain_anchor OWNER TO :"log_owner";
ALTER FUNCTION ets_log_chain_insert() OWNER TO :"log_owner";
ALTER FUNCTION ets_log_append_only() OWNER TO :"log_owner";
ALTER FUNCTION ets_anchor_append_only() OWNER TO :"log_owner";
ALTER FUNCTION ets_purge_log(text, integer, text) OWNER TO :"log_owner";
ALTER FUNCTION ets_audit_row_text(audit_log) OWNER TO :"log_owner";
ALTER FUNCTION ets_auth_row_text(auth_log) OWNER TO :"log_owner";
ALTER FUNCTION ets_chain_hash(text, text) OWNER TO :"log_owner";

REVOKE ALL ON audit_log, auth_log, log_chain_head, log_chain_anchor FROM PUBLIC, :"db_user";
GRANT SELECT, INSERT ON audit_log, auth_log TO :"db_user";
GRANT SELECT ON log_chain_head, log_chain_anchor TO :"db_user";
-- sequences of the log tables (moved with their table): nextval for INSERT, SELECT for pg_dump (ets-backup)
SELECT format('GRANT USAGE, SELECT ON SEQUENCE %s TO %I', s.oid::regclass, :'db_user')
  FROM pg_class s JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = s.oid AND d.deptype IN ('a', 'i')
 WHERE s.relkind = 'S' AND d.refobjid IN ('audit_log'::regclass, 'auth_log'::regclass, 'log_chain_anchor'::regclass) \gexec
REVOKE ALL ON FUNCTION ets_purge_log(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ets_purge_log(text, integer, text) TO :"db_user";

-- check inside the transaction: if the application role could still change the logs, nothing is committed
SET LOCAL ets.harden_app = :'db_user';
DO $$
DECLARE app text := current_setting('ets.harden_app'); t text;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = app) THEN
    RAISE WARNING 'the application role % is a SUPERUSER: it can still change the logs. Give the application a role without superuser.', app;
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['audit_log', 'auth_log', 'log_chain_head', 'log_chain_anchor'] LOOP
    IF pg_has_role(app, (SELECT relowner FROM pg_class WHERE oid = t::regclass), 'USAGE')
       OR has_table_privilege(app, t, 'UPDATE') OR has_table_privilege(app, t, 'DELETE')
       OR has_table_privilege(app, t, 'TRUNCATE') OR has_table_privilege(app, t, 'TRIGGER') THEN
      RAISE EXCEPTION 'hardening check failed: role % can still change %', app, t;
    END IF;
  END LOOP;
END $$;
\if :{?ets_wrapped}
\else
COMMIT;
\endif

SELECT has_table_privilege(:'db_user', 'audit_log', 'UPDATE') AS app_can_update,
       has_table_privilege(:'db_user', 'audit_log', 'DELETE') AS app_can_delete,
       has_table_privilege(:'db_user', 'audit_log', 'TRUNCATE') AS app_can_truncate,
       has_table_privilege(:'db_user', 'audit_log', 'INSERT') AS app_can_insert,
       pg_get_userbyid(c.relowner) AS audit_log_owner
  FROM pg_class c WHERE c.oid = 'audit_log'::regclass;
\else
\echo 'harden-log-tables: migration 012 (log_chain_head) is not applied yet; nothing changed. Run it again after the application has migrated.'
\endif
