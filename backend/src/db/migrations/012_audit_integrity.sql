-- 012 — audit-trail integrity (security remediation 1.0.0, ETS-SEC-013 / 048 / 052). Safe on an existing installation.
--
-- 1) Hash chain. Every row of audit_log and auth_log gets chain_seq (1, 2, 3 … in the order the rows were
--    written), prev_hash (row_hash of the row before) and row_hash = SHA-256(prev_hash || canonical row content).
--    The values are set by the database itself (BEFORE INSERT trigger, one writer at a time per table), also for
--    rows written by migrations or by hand. Changing, deleting or inserting a row anywhere in the chain breaks it;
--    `npm run verify-audit` and GET /api/logs/integrity (administrators) recompute it. user_id is not part of the
--    hash (it becomes NULL when a user is deleted); the username is.
-- 2) Append-only. UPDATE, DELETE and TRUNCATE on the two tables are refused, except
--      - the ON DELETE SET NULL of user_id when a user is deleted, and
--      - the retention purge, done only by ets_purge_log(): oldest rows first (a prefix of the chain), never rows
--        younger than the floor (audit_log 365 days, auth_log 30 days). Each purge leaves a log_chain_anchor row
--        (prev_hash of the first kept row, rows deleted, who), so the verification accepts the shortened chain.
--    The database role of the application still owns these tables after this migration and could drop the
--    triggers (DDL): the chain makes such tampering detectable, and deploy/db/harden-log-tables.sql (applied by
--    ets-log-protect on every install/update of a local database, or by the DBA) moves the log tables to a
--    separate owner role so that the application role can only read and append.
-- 3) Audit retention is its own setting (logs.audit_retention_days, at least 365 days). An installation
--    that kept everything longer than 365 days keeps that period for the audit trail.

ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS row_hash text;
ALTER TABLE auth_log ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE auth_log ADD COLUMN IF NOT EXISTS prev_hash text;
ALTER TABLE auth_log ADD COLUMN IF NOT EXISTS row_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS audit_log_chain_seq_key ON audit_log(chain_seq);
CREATE UNIQUE INDEX IF NOT EXISTS auth_log_chain_seq_key ON auth_log(chain_seq);

-- Last link of each chain (the row lock on it serialises writers of that table until they commit).
CREATE TABLE IF NOT EXISTS log_chain_head (
  tbl       text PRIMARY KEY,
  last_seq  bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT ''
);
-- One row per retention purge: the chain may then start at next_seq with prev_hash instead of at 1 with ''.
CREATE TABLE IF NOT EXISTS log_chain_anchor (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  tbl       text NOT NULL,
  next_seq  bigint NOT NULL,
  prev_hash text NOT NULL,
  deleted   bigint NOT NULL,
  cutoff    timestamptz NOT NULL,
  actor     text
);
CREATE INDEX IF NOT EXISTS log_chain_anchor_tbl ON log_chain_anchor(tbl, next_seq);

-- Canonical content of a row (jsonb text output is deterministic; ts as epoch so the session time zone does not matter).
CREATE OR REPLACE FUNCTION ets_audit_row_text(r audit_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(r.id, r.chain_seq, extract(epoch FROM r.ts)::text, r.username, r.action, r.entity, r.entity_id,
    r.summary, r.old_value, r.new_value, r.context, r.ip::text)::text $$;
CREATE OR REPLACE FUNCTION ets_auth_row_text(r auth_log) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_array(r.id, r.chain_seq, extract(epoch FROM r.ts)::text, r.username, r.event, r.success, r.ip::text,
    r.user_agent, r.detail)::text $$;
CREATE OR REPLACE FUNCTION ets_chain_hash(prev text, body text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(prev || '|' || body, 'UTF8')), 'hex') $$;

-- BEFORE INSERT: next link of the chain. ts is always the database time (no back-dated rows).
CREATE OR REPLACE FUNCTION ets_log_chain_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h log_chain_head%ROWTYPE;
BEGIN
  INSERT INTO log_chain_head(tbl) VALUES (TG_TABLE_NAME) ON CONFLICT (tbl) DO NOTHING;
  SELECT * INTO h FROM log_chain_head WHERE tbl = TG_TABLE_NAME FOR UPDATE;
  NEW.ts := now();
  NEW.chain_seq := h.last_seq + 1;
  NEW.prev_hash := h.last_hash;
  IF TG_TABLE_NAME = 'audit_log' THEN
    NEW.row_hash := ets_chain_hash(NEW.prev_hash, ets_audit_row_text(NEW::audit_log));
  ELSE
    NEW.row_hash := ets_chain_hash(NEW.prev_hash, ets_auth_row_text(NEW::auth_log));
  END IF;
  UPDATE log_chain_head SET last_seq = NEW.chain_seq, last_hash = NEW.row_hash WHERE tbl = TG_TABLE_NAME;
  RETURN NEW;
END $$;

-- BEFORE UPDATE / DELETE / TRUNCATE: append-only.
CREATE OR REPLACE FUNCTION ets_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- the only change allowed: user_id → NULL when the user is deleted (foreign key ON DELETE SET NULL)
    IF NEW.user_id IS NULL AND OLD.user_id IS NOT NULL
       AND (to_jsonb(NEW) - 'user_id') = (to_jsonb(OLD) - 'user_id') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION '% is append-only: rows cannot be changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  ELSIF TG_OP = 'DELETE' THEN
    IF current_setting('ets.log_purge', true) = TG_TABLE_NAME
       AND OLD.ts < now() - make_interval(days => CASE TG_TABLE_NAME WHEN 'audit_log' THEN 365 ELSE 30 END) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only: rows are removed only by the retention purge (ets_purge_log)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RAISE EXCEPTION '% is append-only: TRUNCATE is not allowed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- Chain the rows already there, oldest first.
DO $$
DECLARE r record; prev text; seq bigint;
BEGIN
  LOCK TABLE audit_log, auth_log IN EXCLUSIVE MODE;
  SELECT coalesce(max(chain_seq), 0), coalesce((SELECT row_hash FROM audit_log WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1), '')
    INTO seq, prev FROM audit_log;
  FOR r IN SELECT id FROM audit_log WHERE chain_seq IS NULL ORDER BY id LOOP
    seq := seq + 1;
    UPDATE audit_log SET chain_seq = seq, prev_hash = prev WHERE id = r.id;
    UPDATE audit_log l SET row_hash = ets_chain_hash(prev, ets_audit_row_text(l)) WHERE id = r.id RETURNING row_hash INTO prev;
  END LOOP;
  INSERT INTO log_chain_head(tbl, last_seq, last_hash) VALUES ('audit_log', seq, prev)
    ON CONFLICT (tbl) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash;

  SELECT coalesce(max(chain_seq), 0), coalesce((SELECT row_hash FROM auth_log WHERE chain_seq IS NOT NULL ORDER BY chain_seq DESC LIMIT 1), '')
    INTO seq, prev FROM auth_log;
  FOR r IN SELECT id FROM auth_log WHERE chain_seq IS NULL ORDER BY id LOOP
    seq := seq + 1;
    UPDATE auth_log SET chain_seq = seq, prev_hash = prev WHERE id = r.id;
    UPDATE auth_log l SET row_hash = ets_chain_hash(prev, ets_auth_row_text(l)) WHERE id = r.id RETURNING row_hash INTO prev;
  END LOOP;
  INSERT INTO log_chain_head(tbl, last_seq, last_hash) VALUES ('auth_log', seq, prev)
    ON CONFLICT (tbl) DO UPDATE SET last_seq = EXCLUDED.last_seq, last_hash = EXCLUDED.last_hash;
END $$;

DROP TRIGGER IF EXISTS ets_chain ON audit_log;
DROP TRIGGER IF EXISTS ets_append_only ON audit_log;
DROP TRIGGER IF EXISTS ets_no_truncate ON audit_log;
DROP TRIGGER IF EXISTS ets_chain ON auth_log;
DROP TRIGGER IF EXISTS ets_append_only ON auth_log;
DROP TRIGGER IF EXISTS ets_no_truncate ON auth_log;
CREATE TRIGGER ets_chain BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ets_log_chain_insert();
CREATE TRIGGER ets_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION ets_log_append_only();
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION ets_log_append_only();
CREATE TRIGGER ets_chain BEFORE INSERT ON auth_log FOR EACH ROW EXECUTE FUNCTION ets_log_chain_insert();
CREATE TRIGGER ets_append_only BEFORE UPDATE OR DELETE ON auth_log FOR EACH ROW EXECUTE FUNCTION ets_log_append_only();
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON auth_log FOR EACH STATEMENT EXECUTE FUNCTION ets_log_append_only();

-- The anchors are append-only too.
CREATE OR REPLACE FUNCTION ets_anchor_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'log_chain_anchor is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
DROP TRIGGER IF EXISTS ets_append_only ON log_chain_anchor;
DROP TRIGGER IF EXISTS ets_no_truncate ON log_chain_anchor;
CREATE TRIGGER ets_append_only BEFORE UPDATE OR DELETE ON log_chain_anchor FOR EACH ROW EXECUTE FUNCTION ets_anchor_append_only();
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON log_chain_anchor FOR EACH STATEMENT EXECUTE FUNCTION ets_anchor_append_only();

-- Retention purge of a chained table: deletes the oldest rows (a prefix of the chain) older than `days`, never
-- fewer days than the floor, and records an anchor. Returns the number of rows deleted. SECURITY DEFINER: after
-- deploy/db/harden-log-tables.sql it runs as the log owner, the only way the application role can remove rows.
CREATE OR REPLACE FUNCTION ets_purge_log(p_tbl text, p_days integer, p_actor text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE floor_days integer; cutoff timestamptz; keep_from bigint; first_kept record; n bigint;
BEGIN
  IF p_tbl NOT IN ('audit_log', 'auth_log') THEN RAISE EXCEPTION 'not a chained log table: %', p_tbl; END IF;
  floor_days := CASE p_tbl WHEN 'audit_log' THEN 365 ELSE 30 END;
  cutoff := now() - make_interval(days => greatest(coalesce(p_days, floor_days), floor_days));
  PERFORM 1 FROM log_chain_head WHERE tbl = p_tbl FOR UPDATE;            -- no writer while the start moves
  -- the oldest row that stays: every row before it in the chain is older than the cutoff
  EXECUTE format('SELECT min(chain_seq) FROM %I WHERE ts >= $1', p_tbl) INTO keep_from USING cutoff;
  IF keep_from IS NULL THEN
    EXECUTE format('SELECT max(chain_seq) + 1 FROM %I', p_tbl) INTO keep_from;
    IF keep_from IS NULL THEN RETURN 0; END IF;
  END IF;
  PERFORM set_config('ets.log_purge', p_tbl, true);
  EXECUTE format('DELETE FROM %I WHERE chain_seq < $1', p_tbl) USING keep_from;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('ets.log_purge', '', true);
  IF n > 0 THEN
    EXECUTE format('SELECT chain_seq, prev_hash FROM %I WHERE chain_seq = $1', p_tbl) INTO first_kept USING keep_from;
    INSERT INTO log_chain_anchor(tbl, next_seq, prev_hash, deleted, cutoff, actor)
    VALUES (p_tbl, keep_from,
      coalesce(first_kept.prev_hash, (SELECT last_hash FROM log_chain_head WHERE tbl = p_tbl)), n, cutoff, left(p_actor, 100));
  END IF;
  RETURN n;
END $$;

-- 3) separate audit retention (at least 365 days; an existing longer period is kept)
INSERT INTO settings(key, value)
SELECT 'logs.audit_retention_days', to_jsonb(greatest(365, (value #>> '{}')::int))
  FROM settings WHERE key = 'logs.retention_days' AND jsonb_typeof(value) = 'number'
ON CONFLICT (key) DO NOTHING;

