-- ETS — optional hardening of the audit trail (ETS-SEC-013): the application role may only READ and APPEND the
-- change history (audit_log) and the sign-in log (auth_log).
--
-- Without this script the two tables are already append-only through triggers and hash-chained (migration 012),
-- but the application role owns them and the schema, so whoever can run SQL as that role (for example after a
-- compromise of the server account) could drop the triggers first. The hash chain then still shows the change
-- (npm run verify-audit), unless the whole chain is recomputed — compare the chain head with the copy written
-- daily to the journal. This script removes that possibility inside the database:
--   - a separate role without login (log_owner) owns the log tables, the chain functions and schema "public";
--   - the application role keeps CREATE on the schema and owns all other tables (migrations keep working),
--     and gets SELECT + INSERT on the log tables, plus EXECUTE on ets_purge_log() for the retention purge.
--
-- Run ONCE, after the application has started at least once on version 1.0.0 or later (migration 012 applied),
-- as the PostgreSQL superuser:
--   sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_user=ets -v log_owner=ets_log_owner \
--        -d ets -f deploy/db/harden-log-tables.sql
-- Safe to run again. Consequences to know:
--   - a later migration that changes audit_log / auth_log (none exists in 1.0.0) must then be applied by the DBA;
--     the update stops with "must be owner of table" and changes nothing;
--   - ets-restore (pg_restore --clean as the application role) can no longer replace these tables: restore as
--     postgres (PGUSER=postgres ets-restore …) and run this script again afterwards;
--   - the database owner can still drop the whole database (that is not silent); keep backups off the server.
-- To undo: ALTER the owners back to db_user (see the end of docs/handover/07-Logging-and-Audit.md).

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE %I NOLOGIN', :'log_owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'log_owner') \gexec

BEGIN;
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
GRANT USAGE ON SEQUENCE audit_log_id_seq, auth_log_id_seq TO :"db_user";
REVOKE ALL ON FUNCTION ets_purge_log(text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ets_purge_log(text, integer, text) TO :"db_user";
COMMIT;

-- check: the application role must not be able to change the log tables any more
SELECT has_table_privilege(:'db_user', 'audit_log', 'UPDATE') AS app_can_update,
       has_table_privilege(:'db_user', 'audit_log', 'DELETE') AS app_can_delete,
       has_table_privilege(:'db_user', 'audit_log', 'TRUNCATE') AS app_can_truncate,
       has_table_privilege(:'db_user', 'audit_log', 'INSERT') AS app_can_insert,
       pg_get_userbyid(c.relowner) AS audit_log_owner
  FROM pg_class c WHERE c.oid = 'audit_log'::regclass;
