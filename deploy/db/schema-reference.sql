-- ETS schema reference (generated with pg_dump --schema-only after migrations 001–009 and 012–019).
-- Do not run this file to install: the application creates the schema itself (npm run setup).
-- Kept for documentation and for DBAs reviewing the structure. Ownership is not shown: on an installed server the
-- log tables and their functions belong to ets_log_owner (deploy/db/harden-log-tables.sql), everything else to ets.
-- PostgreSQL database dump
-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';
-- Name: ets_anchor_append_only(); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_anchor_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'log_chain_anchor is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    username text,
    action text NOT NULL,
    entity text NOT NULL,
    entity_id text,
    summary text,
    old_value jsonb,
    new_value jsonb,
    ip inet,
    context jsonb,
    chain_seq bigint,
    prev_hash text,
    row_hash text
);
-- Name: ets_audit_row_text(public.audit_log); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_audit_row_text(r public.audit_log) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_array(r.id, r.chain_seq, extract(epoch FROM r.ts)::text, r.username, r.action, r.entity, r.entity_id,
    r.summary, r.old_value, r.new_value, r.context, r.ip::text)::text $$;
-- Name: auth_log; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.auth_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    username text,
    event text NOT NULL,
    success boolean NOT NULL,
    ip inet,
    user_agent text,
    detail jsonb,
    chain_seq bigint,
    prev_hash text,
    row_hash text
);
-- Name: ets_auth_row_text(public.auth_log); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_auth_row_text(r public.auth_log) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_array(r.id, r.chain_seq, extract(epoch FROM r.ts)::text, r.username, r.event, r.success, r.ip::text,
    r.user_agent, r.detail)::text $$;
-- Name: ets_chain_hash(text, text); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_chain_hash(prev text, body text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT encode(sha256(convert_to(prev || '|' || body, 'UTF8')), 'hex') $$;
-- Name: ets_ensure_email_unique_index(); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_ensure_email_unique_index() RETURNS boolean
    LANGUAGE plpgsql
    AS $$
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
-- Name: ets_function_change_times(); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_function_change_times() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.progress_changed_at := COALESCE(NEW.progress_changed_at, now());
    NEW.test_changed_at := COALESCE(NEW.test_changed_at, now());
  ELSE
    IF NEW.progress IS DISTINCT FROM OLD.progress THEN NEW.progress_changed_at := now(); END IF;
    IF NEW.test_status IS DISTINCT FROM OLD.test_status THEN NEW.test_changed_at := now(); END IF;
  END IF;
  RETURN NEW;
END $$;
-- Name: ets_log_append_only(); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_log_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
-- Name: ets_log_chain_insert(); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_log_chain_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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
-- Name: ets_purge_log(text, integer, text); Type: FUNCTION; Schema: public; Owner: -
CREATE FUNCTION public.ets_purge_log(p_tbl text, p_days integer, p_actor text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
END $_$;
-- Name: access_log; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.access_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    method text NOT NULL,
    path text NOT NULL,
    status smallint NOT NULL,
    duration_ms integer NOT NULL,
    ip inet,
    user_agent text
);
-- Name: access_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.access_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: access_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.access_log_id_seq OWNED BY public.access_log.id;
-- Name: app_reports; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.app_reports (
    app_id text NOT NULL,
    progress numeric(5,2) DEFAULT 0 NOT NULL,
    status smallint DEFAULT 0 NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    CONSTRAINT app_reports_progress_check CHECK (((progress >= (0)::numeric) AND (progress <= (100)::numeric))),
    CONSTRAINT app_reports_status_check CHECK (((status >= 0) AND (status <= 3)))
);
-- Name: applications; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.applications (
    id text NOT NULL,
    department_id text NOT NULL,
    name_ar text NOT NULL,
    name_en text NOT NULL,
    sub_ar text,
    icon text,
    default_weight numeric(6,2) DEFAULT 1 NOT NULL,
    weight numeric(6,2) DEFAULT 1 NOT NULL,
    note_ar text,
    addendum text,
    scope_cut boolean DEFAULT false NOT NULL,
    extra_module boolean DEFAULT false NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.audit_log_id_seq OWNED BY public.audit_log.id;
-- Name: auth_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.auth_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: auth_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.auth_log_id_seq OWNED BY public.auth_log.id;
-- Name: branding_assets; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.branding_assets (
    key text NOT NULL,
    mime text NOT NULL,
    data bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    CONSTRAINT branding_assets_key_check CHECK ((key = ANY (ARRAY['logo'::text, 'favicon'::text, 'login_bg'::text])))
);
-- Name: departments; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.departments (
    id text NOT NULL,
    name_ar text NOT NULL,
    name_en text NOT NULL,
    short_ar text NOT NULL,
    short_en text NOT NULL,
    color text DEFAULT '#2490ef'::text NOT NULL,
    emblem text,
    is_base boolean DEFAULT false NOT NULL,
    sort integer DEFAULT 0 NOT NULL
);
-- Name: device_pair_codes; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.device_pair_codes (
    code_hash text NOT NULL,
    user_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    device_id integer
);
-- Name: edit_request_items; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.edit_request_items (
    id bigint NOT NULL,
    request_id integer NOT NULL,
    kind text NOT NULL,
    app_id text NOT NULL,
    function_id integer,
    field text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    applied boolean,
    note text,
    meta jsonb,
    CONSTRAINT edit_request_items_kind_check CHECK ((kind = ANY (ARRAY['function'::text, 'report'::text])))
);
-- Name: edit_request_items_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.edit_request_items_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: edit_request_items_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.edit_request_items_id_seq OWNED BY public.edit_request_items.id;
-- Name: edit_requests; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.edit_requests (
    id integer NOT NULL,
    department_id text NOT NULL,
    app_id text NOT NULL,
    kind text NOT NULL,
    summary text,
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by integer,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by integer,
    decided_at timestamp with time zone,
    reason text,
    apply_result jsonb,
    target_app_id text,
    target_department_id text,
    source_approved_by integer,
    source_approved_at timestamp with time zone,
    target_approved_by integer,
    target_approved_at timestamp with time zone,
    meta jsonb,
    CONSTRAINT edit_requests_kind_check CHECK ((kind = ANY (ARRAY['function'::text, 'bulk'::text, 'report'::text, 'add_function'::text, 'remove_function'::text, 'restore_function'::text, 'move_function'::text]))),
    CONSTRAINT edit_requests_move_target_check CHECK (((kind = 'move_function'::text) = ((target_app_id IS NOT NULL) AND (target_department_id IS NOT NULL)))),
    CONSTRAINT edit_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'superseded'::text, 'withdrawn'::text])))
);
-- Name: edit_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.edit_requests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: edit_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.edit_requests_id_seq OWNED BY public.edit_requests.id;
-- Name: error_log; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.error_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    user_id integer,
    level text DEFAULT 'error'::text NOT NULL,
    message text NOT NULL,
    stack text,
    method text,
    path text,
    context jsonb
);
-- Name: error_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.error_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: error_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.error_log_id_seq OWNED BY public.error_log.id;
-- Name: function_duplicates; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.function_duplicates (
    function_id integer NOT NULL,
    duplicate_of_id integer NOT NULL,
    CONSTRAINT function_duplicates_check CHECK ((function_id <> duplicate_of_id))
);
-- Name: function_moves; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.function_moves (
    id bigint NOT NULL,
    function_id integer NOT NULL,
    from_app_id text NOT NULL,
    to_app_id text NOT NULL,
    from_code text NOT NULL,
    to_code text NOT NULL,
    from_dept_id text NOT NULL,
    to_dept_id text NOT NULL,
    weight_mode text NOT NULL,
    weight_share numeric(6,2) DEFAULT 0 NOT NULL,
    reason text NOT NULL,
    moved_by integer,
    moved_at timestamp with time zone DEFAULT now() NOT NULL,
    request_id integer,
    CONSTRAINT function_moves_check CHECK ((from_app_id <> to_app_id)),
    CONSTRAINT function_moves_reason_check CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 500))),
    CONSTRAINT function_moves_weight_mode_check CHECK ((weight_mode = ANY (ARRAY['fixed'::text, 'auto'::text]))),
    CONSTRAINT function_moves_weight_share_check CHECK ((weight_share >= (0)::numeric))
);
-- Name: function_moves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.function_moves_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: function_moves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.function_moves_id_seq OWNED BY public.function_moves.id;
-- Name: functions; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.functions (
    id integer NOT NULL,
    app_id text NOT NULL,
    code text NOT NULL,
    source text NOT NULL,
    name_ar text NOT NULL,
    name_en text,
    reference text,
    vendor_status smallint DEFAULT 0 NOT NULL,
    weight numeric(6,2) DEFAULT 1 NOT NULL,
    progress numeric(5,2) DEFAULT 0 NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    test_status smallint DEFAULT 0 NOT NULL,
    notif_status smallint DEFAULT 0 NOT NULL,
    review_status smallint DEFAULT 0 NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    removed_at timestamp with time zone,
    removed_by integer,
    removed_reason text,
    created_at timestamp with time zone,
    created_by integer,
    disabled_reason text,
    disabled_note text,
    disabled_by integer,
    disabled_at timestamp with time zone,
    item_type text DEFAULT 'function'::text NOT NULL,
    progress_changed_at timestamp with time zone,
    test_changed_at timestamp with time zone,
    CONSTRAINT functions_disabled_note_check CHECK (((disabled_note IS NULL) OR (char_length(disabled_note) <= 500))),
    CONSTRAINT functions_disabled_reason_check CHECK (((disabled_reason IS NULL) OR (disabled_reason = ANY (ARRAY['duplicate'::text, 'out_of_scope'::text, 'not_required'::text, 'other'::text, 'import'::text])))),
    CONSTRAINT functions_item_type_check CHECK ((item_type = ANY (ARRAY['function'::text, 'report'::text]))),
    CONSTRAINT functions_notif_status_check CHECK (((notif_status >= 0) AND (notif_status <= 3))),
    CONSTRAINT functions_progress_check CHECK (((progress >= (0)::numeric) AND (progress <= (100)::numeric))),
    CONSTRAINT functions_review_status_check CHECK (((review_status >= 0) AND (review_status <= 3))),
    CONSTRAINT functions_source_check CHECK ((source = ANY (ARRAY['design'::text, 'vendor_list'::text, 'experience'::text, 'custom'::text]))),
    CONSTRAINT functions_test_status_check CHECK (((test_status >= 0) AND (test_status <= 3))),
    CONSTRAINT functions_vendor_status_check CHECK (((vendor_status >= 0) AND (vendor_status <= 3))),
    CONSTRAINT functions_weight_check CHECK ((weight >= (0)::numeric))
);
-- Name: COLUMN functions.item_type; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.functions.item_type IS 'function | report (1.8.0): which part of the application % the item counts in';
-- Name: COLUMN functions.progress_changed_at; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.functions.progress_changed_at IS 'last change of progress (trigger ets_function_change_times, 1.9.0)';
-- Name: COLUMN functions.test_changed_at; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.functions.test_changed_at IS 'last change of test_status (trigger ets_function_change_times, 1.9.0)';
-- Name: functions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.functions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: functions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.functions_id_seq OWNED BY public.functions.id;
-- Name: import_batches; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.import_batches (
    id integer NOT NULL,
    target text DEFAULT 'department'::text NOT NULL,
    department_id text,
    departments text[] DEFAULT '{}'::text[] NOT NULL,
    filename text,
    file_ts timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    change_count integer DEFAULT 0 NOT NULL,
    summary jsonb,
    uploaded_by integer,
    uploaded_at timestamp with time zone DEFAULT now() NOT NULL,
    lead_by integer,
    lead_at timestamp with time zone,
    lead_note text,
    final_by integer,
    final_at timestamp with time zone,
    final_note text,
    rejected_by integer,
    rejected_at timestamp with time zone,
    reject_reason text,
    applied_at timestamp with time zone,
    apply_result jsonb,
    CONSTRAINT import_batches_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text, 'superseded'::text, 'no_changes'::text]))),
    CONSTRAINT import_batches_target_check CHECK ((target = ANY (ARRAY['department'::text, 'reports'::text])))
);
-- Name: import_batches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.import_batches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: import_batches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.import_batches_id_seq OWNED BY public.import_batches.id;
-- Name: import_changes; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.import_changes (
    id bigint NOT NULL,
    batch_id integer NOT NULL,
    kind text NOT NULL,
    app_id text NOT NULL,
    function_id integer,
    code text,
    field text NOT NULL,
    old_value jsonb,
    new_value jsonb,
    applied boolean,
    note text,
    CONSTRAINT import_changes_kind_check CHECK ((kind = ANY (ARRAY['function'::text, 'report'::text, 'weight'::text])))
);
-- Name: import_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.import_changes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: import_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.import_changes_id_seq OWNED BY public.import_changes.id;
-- Name: log_chain_anchor; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.log_chain_anchor (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    tbl text NOT NULL,
    next_seq bigint NOT NULL,
    prev_hash text NOT NULL,
    deleted bigint NOT NULL,
    cutoff timestamp with time zone NOT NULL,
    actor text
);
-- Name: log_chain_anchor_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.log_chain_anchor_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: log_chain_anchor_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.log_chain_anchor_id_seq OWNED BY public.log_chain_anchor.id;
-- Name: log_chain_head; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.log_chain_head (
    tbl text NOT NULL,
    last_seq bigint DEFAULT 0 NOT NULL,
    last_hash text DEFAULT ''::text NOT NULL
);
-- Name: mobile_devices; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.mobile_devices (
    id integer NOT NULL,
    user_id integer NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    app_version text,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_ip inet,
    last_seen_at timestamp with time zone,
    last_ip inet,
    revoked_at timestamp with time zone,
    revoked_by integer,
    revoke_reason text,
    CONSTRAINT mobile_devices_app_version_check CHECK (((app_version IS NULL) OR (char_length(app_version) <= 40))),
    CONSTRAINT mobile_devices_name_check CHECK (((char_length(name) >= 1) AND (char_length(name) <= 80))),
    CONSTRAINT mobile_devices_platform_check CHECK ((platform = 'android'::text)),
    CONSTRAINT mobile_devices_revoke_reason_check CHECK (((revoke_reason IS NULL) OR (revoke_reason = ANY (ARRAY['user'::text, 'unpaired'::text, 'admin'::text, 'user_disabled'::text, 'user_deleted'::text, 'password_reset'::text, 'inactive'::text]))))
);
-- Name: mobile_devices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.mobile_devices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: mobile_devices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.mobile_devices_id_seq OWNED BY public.mobile_devices.id;
-- Name: notification_prefs; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.notification_prefs (
    user_id integer NOT NULL,
    prefs jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Name: notification_user_blocks; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.notification_user_blocks (
    user_id integer NOT NULL,
    type text NOT NULL,
    channel text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    CONSTRAINT notification_user_blocks_channel_check CHECK ((channel = ANY (ARRAY['all'::text, 'mobile'::text])))
);
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.notifications (
    id bigint NOT NULL,
    user_id integer NOT NULL,
    type text NOT NULL,
    category text NOT NULL,
    severity text NOT NULL,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    link text,
    dept_id text,
    app_id text,
    dedupe_key text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT notifications_category_check CHECK ((category = ANY (ARRAY['tracking'::text, 'approvals'::text, 'plan'::text, 'security'::text, 'system'::text]))),
    CONSTRAINT notifications_link_check CHECK (((link IS NULL) OR (link ~ '^/[A-Za-z0-9/_?=&.-]*$'::text))),
    CONSTRAINT notifications_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text])))
);
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: notifications_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.notifications_id_seq OWNED BY public.notifications.id;
-- Name: notify_state; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.notify_state (
    key text NOT NULL,
    value jsonb,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Name: progress_snapshots; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.progress_snapshots (
    day date NOT NULL,
    total_pct numeric(6,2) NOT NULL,
    fn_pct numeric(6,2) NOT NULL,
    functions integer NOT NULL,
    done integer NOT NULL,
    tested_ok integer NOT NULL,
    notes integer NOT NULL,
    departments jsonb DEFAULT '{}'::jsonb NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Name: roles; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.roles (
    id text NOT NULL,
    name_ar text NOT NULL,
    name_en text NOT NULL,
    description_ar text,
    description_en text,
    full_scope boolean DEFAULT false NOT NULL,
    permissions text[] DEFAULT '{}'::text[] NOT NULL
);
-- Name: schedule; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.schedule (
    id smallint DEFAULT 1 NOT NULL,
    start_date date,
    periods smallint DEFAULT 11 NOT NULL,
    unit text DEFAULT 'month'::text NOT NULL,
    plan numeric(5,2)[],
    actual numeric(5,2)[],
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer,
    end_date date,
    CONSTRAINT schedule_id_check CHECK ((id = 1)),
    CONSTRAINT schedule_periods_check CHECK (((periods >= 1) AND (periods <= 60))),
    CONSTRAINT schedule_unit_check CHECK ((unit = ANY (ARRAY['month'::text, 'fortnight'::text])))
);
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.schema_migrations (
    version text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.sessions (
    id text NOT NULL,
    user_id integer NOT NULL,
    mfa_passed boolean DEFAULT false NOT NULL,
    mfa_stage text,
    ip inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoke_reason text
);
-- Name: settings; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.settings (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);
-- Name: system_log; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.system_log (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    event text NOT NULL,
    message text,
    detail jsonb
);
-- Name: system_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.system_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: system_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.system_log_id_seq OWNED BY public.system_log.id;
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.user_permissions (
    user_id integer NOT NULL,
    permission text NOT NULL,
    granted boolean NOT NULL
);
-- Name: user_recovery_codes; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.user_recovery_codes (
    id integer NOT NULL,
    user_id integer NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
-- Name: COLUMN user_recovery_codes.code_hash; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.user_recovery_codes.code_hash IS 'h1:<hex HMAC-SHA-256> (1.0.0+) or legacy <hex SHA-256>';
-- Name: user_recovery_codes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.user_recovery_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: user_recovery_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.user_recovery_codes_id_seq OWNED BY public.user_recovery_codes.id;
-- Name: user_scopes; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.user_scopes (
    user_id integer NOT NULL,
    kind text NOT NULL,
    ref_id text NOT NULL,
    CONSTRAINT user_scopes_kind_check CHECK ((kind = ANY (ARRAY['department'::text, 'application'::text])))
);
-- Name: users; Type: TABLE; Schema: public; Owner: -
CREATE TABLE public.users (
    id integer NOT NULL,
    username public.citext NOT NULL,
    full_name text NOT NULL,
    email public.citext,
    password_hash text NOT NULL,
    role_id text NOT NULL,
    language text DEFAULT 'ar'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    must_change_password boolean DEFAULT false NOT NULL,
    totp_secret text,
    totp_enabled boolean DEFAULT false NOT NULL,
    totp_exempt boolean DEFAULT false NOT NULL,
    totp_enabled_at timestamp with time zone,
    totp_last_step bigint,
    failed_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    last_login_ip inet,
    password_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by integer,
    last_failed_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by integer,
    delete_reason text,
    CONSTRAINT users_delete_reason_check CHECK (((delete_reason IS NULL) OR (char_length(delete_reason) <= 500))),
    CONSTRAINT users_language_check CHECK ((language = ANY (ARRAY['ar'::text, 'en'::text])))
);
-- Name: users_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE public.users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
-- Name: users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.users_id_seq OWNED BY public.users.id;
-- Name: access_log id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.access_log ALTER COLUMN id SET DEFAULT nextval('public.access_log_id_seq'::regclass);
-- Name: audit_log id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.audit_log ALTER COLUMN id SET DEFAULT nextval('public.audit_log_id_seq'::regclass);
-- Name: auth_log id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.auth_log ALTER COLUMN id SET DEFAULT nextval('public.auth_log_id_seq'::regclass);
-- Name: edit_request_items id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_request_items ALTER COLUMN id SET DEFAULT nextval('public.edit_request_items_id_seq'::regclass);
-- Name: edit_requests id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests ALTER COLUMN id SET DEFAULT nextval('public.edit_requests_id_seq'::regclass);
-- Name: error_log id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.error_log ALTER COLUMN id SET DEFAULT nextval('public.error_log_id_seq'::regclass);
-- Name: function_moves id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves ALTER COLUMN id SET DEFAULT nextval('public.function_moves_id_seq'::regclass);
-- Name: functions id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions ALTER COLUMN id SET DEFAULT nextval('public.functions_id_seq'::regclass);
-- Name: import_batches id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches ALTER COLUMN id SET DEFAULT nextval('public.import_batches_id_seq'::regclass);
-- Name: import_changes id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_changes ALTER COLUMN id SET DEFAULT nextval('public.import_changes_id_seq'::regclass);
-- Name: log_chain_anchor id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.log_chain_anchor ALTER COLUMN id SET DEFAULT nextval('public.log_chain_anchor_id_seq'::regclass);
-- Name: mobile_devices id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.mobile_devices ALTER COLUMN id SET DEFAULT nextval('public.mobile_devices_id_seq'::regclass);
-- Name: notifications id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.notifications ALTER COLUMN id SET DEFAULT nextval('public.notifications_id_seq'::regclass);
-- Name: system_log id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.system_log ALTER COLUMN id SET DEFAULT nextval('public.system_log_id_seq'::regclass);
-- Name: user_recovery_codes id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_recovery_codes ALTER COLUMN id SET DEFAULT nextval('public.user_recovery_codes_id_seq'::regclass);
-- Name: users id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.users ALTER COLUMN id SET DEFAULT nextval('public.users_id_seq'::regclass);
-- Name: access_log access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_pkey PRIMARY KEY (id);
-- Name: app_reports app_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.app_reports
    ADD CONSTRAINT app_reports_pkey PRIMARY KEY (app_id);
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (id);
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
-- Name: auth_log auth_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.auth_log
    ADD CONSTRAINT auth_log_pkey PRIMARY KEY (id);
-- Name: branding_assets branding_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_pkey PRIMARY KEY (key);
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
-- Name: device_pair_codes device_pair_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.device_pair_codes
    ADD CONSTRAINT device_pair_codes_pkey PRIMARY KEY (code_hash);
-- Name: edit_request_items edit_request_items_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_request_items
    ADD CONSTRAINT edit_request_items_pkey PRIMARY KEY (id);
-- Name: edit_requests edit_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_pkey PRIMARY KEY (id);
-- Name: error_log error_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.error_log
    ADD CONSTRAINT error_log_pkey PRIMARY KEY (id);
-- Name: function_duplicates function_duplicates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_duplicates
    ADD CONSTRAINT function_duplicates_pkey PRIMARY KEY (function_id, duplicate_of_id);
-- Name: function_moves function_moves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_pkey PRIMARY KEY (id);
-- Name: functions functions_app_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_app_id_code_key UNIQUE (app_id, code);
-- Name: functions functions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_pkey PRIMARY KEY (id);
-- Name: import_batches import_batches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_pkey PRIMARY KEY (id);
-- Name: import_changes import_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_changes
    ADD CONSTRAINT import_changes_pkey PRIMARY KEY (id);
-- Name: log_chain_anchor log_chain_anchor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.log_chain_anchor
    ADD CONSTRAINT log_chain_anchor_pkey PRIMARY KEY (id);
-- Name: log_chain_head log_chain_head_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.log_chain_head
    ADD CONSTRAINT log_chain_head_pkey PRIMARY KEY (tbl);
-- Name: mobile_devices mobile_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_pkey PRIMARY KEY (id);
-- Name: mobile_devices mobile_devices_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_token_hash_key UNIQUE (token_hash);
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_pkey PRIMARY KEY (user_id);
-- Name: notification_user_blocks notification_user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notification_user_blocks
    ADD CONSTRAINT notification_user_blocks_pkey PRIMARY KEY (user_id, type, channel);
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
-- Name: notify_state notify_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notify_state
    ADD CONSTRAINT notify_state_pkey PRIMARY KEY (key);
-- Name: progress_snapshots progress_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.progress_snapshots
    ADD CONSTRAINT progress_snapshots_pkey PRIMARY KEY (day);
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
-- Name: schedule schedule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_pkey PRIMARY KEY (id);
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);
-- Name: settings settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (key);
-- Name: system_log system_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.system_log
    ADD CONSTRAINT system_log_pkey PRIMARY KEY (id);
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (user_id, permission);
-- Name: user_recovery_codes user_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_recovery_codes
    ADD CONSTRAINT user_recovery_codes_pkey PRIMARY KEY (id);
-- Name: user_scopes user_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_pkey PRIMARY KEY (user_id, kind, ref_id);
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
-- Name: access_log_status_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX access_log_status_idx ON public.access_log USING btree (status);
-- Name: access_log_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX access_log_ts_idx ON public.access_log USING btree (ts DESC);
-- Name: access_log_user_id_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX access_log_user_id_ts_idx ON public.access_log USING btree (user_id, ts DESC);
-- Name: applications_department_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX applications_department_id_idx ON public.applications USING btree (department_id);
-- Name: audit_log_chain_seq_key; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX audit_log_chain_seq_key ON public.audit_log USING btree (chain_seq);
-- Name: audit_log_entity_entity_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX audit_log_entity_entity_id_idx ON public.audit_log USING btree (entity, entity_id);
-- Name: audit_log_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX audit_log_ts_idx ON public.audit_log USING btree (ts DESC);
-- Name: audit_log_user_id_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX audit_log_user_id_ts_idx ON public.audit_log USING btree (user_id, ts DESC);
-- Name: auth_log_chain_seq_key; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX auth_log_chain_seq_key ON public.auth_log USING btree (chain_seq);
-- Name: auth_log_event_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX auth_log_event_idx ON public.auth_log USING btree (event);
-- Name: auth_log_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX auth_log_ts_idx ON public.auth_log USING btree (ts DESC);
-- Name: auth_log_user_id_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX auth_log_user_id_ts_idx ON public.auth_log USING btree (user_id, ts DESC);
-- Name: device_pair_codes_user; Type: INDEX; Schema: public; Owner: -
CREATE INDEX device_pair_codes_user ON public.device_pair_codes USING btree (user_id);
-- Name: edit_request_items_function_id_field_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX edit_request_items_function_id_field_idx ON public.edit_request_items USING btree (function_id, field);
-- Name: edit_request_items_request_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX edit_request_items_request_id_idx ON public.edit_request_items USING btree (request_id);
-- Name: edit_requests_requested_by_status_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX edit_requests_requested_by_status_idx ON public.edit_requests USING btree (requested_by, status);
-- Name: edit_requests_status_department_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX edit_requests_status_department_id_idx ON public.edit_requests USING btree (status, department_id);
-- Name: edit_requests_target_pending; Type: INDEX; Schema: public; Owner: -
CREATE INDEX edit_requests_target_pending ON public.edit_requests USING btree (target_app_id) WHERE (status = 'pending'::text);
-- Name: error_log_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX error_log_ts_idx ON public.error_log USING btree (ts DESC);
-- Name: function_duplicates_target; Type: INDEX; Schema: public; Owner: -
CREATE INDEX function_duplicates_target ON public.function_duplicates USING btree (duplicate_of_id);
-- Name: function_moves_from; Type: INDEX; Schema: public; Owner: -
CREATE INDEX function_moves_from ON public.function_moves USING btree (from_app_id, from_code);
-- Name: function_moves_function; Type: INDEX; Schema: public; Owner: -
CREATE INDEX function_moves_function ON public.function_moves USING btree (function_id, moved_at);
-- Name: function_moves_to; Type: INDEX; Schema: public; Owner: -
CREATE INDEX function_moves_to ON public.function_moves USING btree (to_app_id);
-- Name: functions_app_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX functions_app_id_idx ON public.functions USING btree (app_id);
-- Name: import_batches_status_target_department_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX import_batches_status_target_department_id_idx ON public.import_batches USING btree (status, target, department_id);
-- Name: import_batches_uploaded_at_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX import_batches_uploaded_at_idx ON public.import_batches USING btree (uploaded_at DESC);
-- Name: import_changes_batch_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX import_changes_batch_id_idx ON public.import_changes USING btree (batch_id);
-- Name: log_chain_anchor_tbl; Type: INDEX; Schema: public; Owner: -
CREATE INDEX log_chain_anchor_tbl ON public.log_chain_anchor USING btree (tbl, next_seq);
-- Name: mobile_devices_user; Type: INDEX; Schema: public; Owner: -
CREATE INDEX mobile_devices_user ON public.mobile_devices USING btree (user_id) WHERE (revoked_at IS NULL);
-- Name: notifications_dedupe; Type: INDEX; Schema: public; Owner: -
CREATE INDEX notifications_dedupe ON public.notifications USING btree (dedupe_key, user_id, updated_at DESC);
-- Name: notifications_open_dedupe; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX notifications_open_dedupe ON public.notifications USING btree (user_id, dedupe_key) WHERE (read_at IS NULL);
-- Name: notifications_user_time; Type: INDEX; Schema: public; Owner: -
CREATE INDEX notifications_user_time ON public.notifications USING btree (user_id, created_at DESC, id DESC);
-- Name: notifications_user_unread; Type: INDEX; Schema: public; Owner: -
CREATE INDEX notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);
-- Name: sessions_expires_at_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX sessions_expires_at_idx ON public.sessions USING btree (expires_at);
-- Name: sessions_user_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX sessions_user_id_idx ON public.sessions USING btree (user_id);
-- Name: system_log_ts_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX system_log_ts_idx ON public.system_log USING btree (ts DESC);
-- Name: user_recovery_codes_user_id_idx; Type: INDEX; Schema: public; Owner: -
CREATE INDEX user_recovery_codes_user_id_idx ON public.user_recovery_codes USING btree (user_id);
-- Name: users_deleted_at; Type: INDEX; Schema: public; Owner: -
CREATE INDEX users_deleted_at ON public.users USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);
-- Name: users_email_lower_uniq; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX users_email_lower_uniq ON public.users USING btree (lower((email)::text)) WHERE ((email IS NOT NULL) AND (email OPERATOR(public.<>) ''::public.citext) AND (deleted_at IS NULL));
-- Name: users_username_live_key; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX users_username_live_key ON public.users USING btree (username) WHERE (deleted_at IS NULL);
-- Name: audit_log ets_append_only; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.ets_log_append_only();
-- Name: auth_log ets_append_only; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_append_only BEFORE DELETE OR UPDATE ON public.auth_log FOR EACH ROW EXECUTE FUNCTION public.ets_log_append_only();
-- Name: log_chain_anchor ets_append_only; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_append_only BEFORE DELETE OR UPDATE ON public.log_chain_anchor FOR EACH ROW EXECUTE FUNCTION public.ets_anchor_append_only();
-- Name: audit_log ets_chain; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_chain BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.ets_log_chain_insert();
-- Name: auth_log ets_chain; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_chain BEFORE INSERT ON public.auth_log FOR EACH ROW EXECUTE FUNCTION public.ets_log_chain_insert();
-- Name: functions ets_function_change_times; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_function_change_times BEFORE INSERT OR UPDATE ON public.functions FOR EACH ROW EXECUTE FUNCTION public.ets_function_change_times();
-- Name: audit_log ets_no_truncate; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.ets_log_append_only();
-- Name: auth_log ets_no_truncate; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON public.auth_log FOR EACH STATEMENT EXECUTE FUNCTION public.ets_log_append_only();
-- Name: log_chain_anchor ets_no_truncate; Type: TRIGGER; Schema: public; Owner: -
CREATE TRIGGER ets_no_truncate BEFORE TRUNCATE ON public.log_chain_anchor FOR EACH STATEMENT EXECUTE FUNCTION public.ets_anchor_append_only();
-- Name: access_log access_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.access_log
    ADD CONSTRAINT access_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: app_reports app_reports_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.app_reports
    ADD CONSTRAINT app_reports_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.applications(id) ON DELETE CASCADE;
-- Name: app_reports app_reports_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.app_reports
    ADD CONSTRAINT app_reports_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: applications applications_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);
-- Name: applications applications_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.applications
    ADD CONSTRAINT applications_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: auth_log auth_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.auth_log
    ADD CONSTRAINT auth_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: branding_assets branding_assets_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.branding_assets
    ADD CONSTRAINT branding_assets_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: device_pair_codes device_pair_codes_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.device_pair_codes
    ADD CONSTRAINT device_pair_codes_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.mobile_devices(id) ON DELETE SET NULL;
-- Name: device_pair_codes device_pair_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.device_pair_codes
    ADD CONSTRAINT device_pair_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: edit_request_items edit_request_items_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_request_items
    ADD CONSTRAINT edit_request_items_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.applications(id);
-- Name: edit_request_items edit_request_items_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_request_items
    ADD CONSTRAINT edit_request_items_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.functions(id) ON DELETE CASCADE;
-- Name: edit_request_items edit_request_items_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_request_items
    ADD CONSTRAINT edit_request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.edit_requests(id) ON DELETE CASCADE;
-- Name: edit_requests edit_requests_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.applications(id);
-- Name: edit_requests edit_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: edit_requests edit_requests_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);
-- Name: edit_requests edit_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: edit_requests edit_requests_source_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_source_approved_by_fkey FOREIGN KEY (source_approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: edit_requests edit_requests_target_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_target_app_id_fkey FOREIGN KEY (target_app_id) REFERENCES public.applications(id);
-- Name: edit_requests edit_requests_target_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_target_approved_by_fkey FOREIGN KEY (target_approved_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: edit_requests edit_requests_target_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.edit_requests
    ADD CONSTRAINT edit_requests_target_department_id_fkey FOREIGN KEY (target_department_id) REFERENCES public.departments(id);
-- Name: error_log error_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.error_log
    ADD CONSTRAINT error_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: function_duplicates function_duplicates_duplicate_of_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_duplicates
    ADD CONSTRAINT function_duplicates_duplicate_of_id_fkey FOREIGN KEY (duplicate_of_id) REFERENCES public.functions(id) ON DELETE CASCADE;
-- Name: function_duplicates function_duplicates_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_duplicates
    ADD CONSTRAINT function_duplicates_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.functions(id) ON DELETE CASCADE;
-- Name: function_moves function_moves_from_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_from_app_id_fkey FOREIGN KEY (from_app_id) REFERENCES public.applications(id) ON DELETE CASCADE;
-- Name: function_moves function_moves_from_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_from_dept_id_fkey FOREIGN KEY (from_dept_id) REFERENCES public.departments(id);
-- Name: function_moves function_moves_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.functions(id) ON DELETE CASCADE;
-- Name: function_moves function_moves_moved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_moved_by_fkey FOREIGN KEY (moved_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: function_moves function_moves_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.edit_requests(id) ON DELETE SET NULL;
-- Name: function_moves function_moves_to_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_to_app_id_fkey FOREIGN KEY (to_app_id) REFERENCES public.applications(id) ON DELETE CASCADE;
-- Name: function_moves function_moves_to_dept_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.function_moves
    ADD CONSTRAINT function_moves_to_dept_id_fkey FOREIGN KEY (to_dept_id) REFERENCES public.departments(id);
-- Name: functions functions_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.applications(id) ON DELETE CASCADE;
-- Name: functions functions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: functions functions_disabled_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_disabled_by_fkey FOREIGN KEY (disabled_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: functions functions_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: functions functions_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.functions
    ADD CONSTRAINT functions_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: import_batches import_batches_department_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id);
-- Name: import_batches import_batches_final_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_final_by_fkey FOREIGN KEY (final_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: import_batches import_batches_lead_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_lead_by_fkey FOREIGN KEY (lead_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: import_batches import_batches_rejected_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: import_batches import_batches_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_batches
    ADD CONSTRAINT import_batches_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: import_changes import_changes_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_changes
    ADD CONSTRAINT import_changes_app_id_fkey FOREIGN KEY (app_id) REFERENCES public.applications(id);
-- Name: import_changes import_changes_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_changes
    ADD CONSTRAINT import_changes_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.import_batches(id) ON DELETE CASCADE;
-- Name: import_changes import_changes_function_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.import_changes
    ADD CONSTRAINT import_changes_function_id_fkey FOREIGN KEY (function_id) REFERENCES public.functions(id) ON DELETE CASCADE;
-- Name: mobile_devices mobile_devices_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: mobile_devices mobile_devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.mobile_devices
    ADD CONSTRAINT mobile_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: notification_prefs notification_prefs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: notification_user_blocks notification_user_blocks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notification_user_blocks
    ADD CONSTRAINT notification_user_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: notification_user_blocks notification_user_blocks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notification_user_blocks
    ADD CONSTRAINT notification_user_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: schedule schedule_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.schedule
    ADD CONSTRAINT schedule_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: settings settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: user_recovery_codes user_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_recovery_codes
    ADD CONSTRAINT user_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: user_scopes user_scopes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.user_scopes
    ADD CONSTRAINT user_scopes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- Name: users users_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: users users_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id) ON DELETE SET NULL;
-- Name: users users_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);
-- PostgreSQL database dump complete
