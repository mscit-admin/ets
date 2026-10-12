-- ETS — ERP Tracking System : initial schema
-- Applied by backend/src/db/migrate.js inside a transaction.

CREATE EXTENSION IF NOT EXISTS citext;

-- ============================================================
-- 1. Identity & access
-- ============================================================
CREATE TABLE roles (
  id          text PRIMARY KEY,                 -- admin, mgr, ed, qa, obs
  name_ar     text NOT NULL,
  name_en     text NOT NULL,
  description_ar text,
  description_en text,
  full_scope  boolean NOT NULL DEFAULT false,   -- sees every department regardless of scope
  permissions text[] NOT NULL DEFAULT '{}'      -- default permission keys of the role
);

CREATE TABLE users (
  id               serial PRIMARY KEY,
  username         citext NOT NULL UNIQUE,
  full_name        text NOT NULL,
  email            citext,
  password_hash    text NOT NULL,
  role_id          text NOT NULL REFERENCES roles(id),
  language         text NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en')),
  is_active        boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  -- Two-factor authentication (TOTP, RFC 6238)
  totp_secret      text,                         -- encrypted (AES-256-GCM) with APP_SECRET
  totp_enabled     boolean NOT NULL DEFAULT false,
  totp_exempt      boolean NOT NULL DEFAULT false, -- admin switched 2FA off for this user
  totp_enabled_at  timestamptz,
  totp_last_step   bigint,                       -- last accepted 30 s step (blocks code replay)
  -- Lockout
  failed_attempts  integer NOT NULL DEFAULT 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  last_login_ip    inet,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       integer REFERENCES users(id) ON DELETE SET NULL
);

-- One-time backup codes for 2FA (stored hashed)
CREATE TABLE user_recovery_codes (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON user_recovery_codes(user_id);

-- Per-user permission overrides (true = grant, false = revoke) on top of the role
CREATE TABLE user_permissions (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission text NOT NULL,
  granted    boolean NOT NULL,
  PRIMARY KEY (user_id, permission)
);

-- Data scope: departments and/or applications a user is limited to.
-- No rows = full scope.
CREATE TABLE user_scopes (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('department','application')),
  ref_id     text NOT NULL,
  PRIMARY KEY (user_id, kind, ref_id)
);

CREATE TABLE sessions (
  id           text PRIMARY KEY,                -- sha256 of the cookie token
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mfa_passed   boolean NOT NULL DEFAULT false,
  mfa_stage    text,                            -- null | 'verify' | 'enroll'
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  revoke_reason text
);
CREATE INDEX ON sessions(user_id);
CREATE INDEX ON sessions(expires_at);

-- Key/value system settings (2FA policy, calculation parameters, retention…)
CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- 2. Tracker catalog & progress
-- ============================================================
CREATE TABLE departments (
  id        text PRIMARY KEY,
  name_ar   text NOT NULL,
  name_en   text NOT NULL,
  short_ar  text NOT NULL,
  short_en  text NOT NULL,
  color     text NOT NULL DEFAULT '#2490ef',
  emblem    text,
  is_base   boolean NOT NULL DEFAULT false,     -- infrastructure/requirements: no reports track
  sort      integer NOT NULL DEFAULT 0
);

CREATE TABLE applications (
  id            text PRIMARY KEY,
  department_id text NOT NULL REFERENCES departments(id),
  name_ar       text NOT NULL,
  name_en       text NOT NULL,
  sub_ar        text,
  icon          text,
  default_weight numeric(6,2) NOT NULL DEFAULT 1,
  weight        numeric(6,2) NOT NULL DEFAULT 1,  -- used in 'fixed' weighting mode
  note_ar       text,
  addendum      text,                             -- addendum / BRD version label
  scope_cut     boolean NOT NULL DEFAULT false,   -- scope reduced by later versions
  extra_module  boolean NOT NULL DEFAULT false,   -- absent from the design, found in vendor list
  sort          integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    integer REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX ON applications(department_id);

-- Functions (requirements) of each application.
--   source: design      = from the approved detailed design document
--           vendor_list = from the vendor's operational function list
--           experience  = gap added from experience (disabled by default)
--   vendor_status : 0 none, 1 works, 2 works with a note, 3 in progress (vendor's claim)
--   test_status   : 0 not tested, 1 passed with note, 2 passed, 3 failed (project team)
--   notif_status  : 0 n/a, 1 working, 2 working with notes, 3 not working
--   review_status : 0 not needed, 1 needed & present, 2 needed & missing, 3 present with notes
CREATE TABLE functions (
  id            serial PRIMARY KEY,
  app_id        text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  code          text NOT NULL,                  -- D0.., X0.. (stable, matches original tracker)
  source        text NOT NULL CHECK (source IN ('design','vendor_list','experience','custom')),
  name_ar       text NOT NULL,
  name_en       text,
  reference     text,
  vendor_status smallint NOT NULL DEFAULT 0 CHECK (vendor_status BETWEEN 0 AND 3),
  weight        numeric(6,2) NOT NULL DEFAULT 1 CHECK (weight >= 0),
  progress      numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  enabled       boolean NOT NULL DEFAULT true,
  test_status   smallint NOT NULL DEFAULT 0 CHECK (test_status BETWEEN 0 AND 3),
  notif_status  smallint NOT NULL DEFAULT 0 CHECK (notif_status BETWEEN 0 AND 3),
  review_status smallint NOT NULL DEFAULT 0 CHECK (review_status BETWEEN 0 AND 3),
  note          text NOT NULL DEFAULT '',
  sort          integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    integer REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (app_id, code)
);
CREATE INDEX ON functions(app_id);

-- Reports track (per application, non-base departments)
--   status: 0 not needed, 1 needed & delivered, 2 needed & missing, 3 delivered with notes
CREATE TABLE app_reports (
  app_id     text PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  progress   numeric(5,2) NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status     smallint NOT NULL DEFAULT 0 CHECK (status BETWEEN 0 AND 3),
  note       text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL
);

-- Project schedule (single row): planned S-curve vs actual cumulative progress
CREATE TABLE schedule (
  id         smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  start_date date,
  periods    smallint NOT NULL DEFAULT 11 CHECK (periods BETWEEN 1 AND 60),
  unit       text NOT NULL DEFAULT 'month' CHECK (unit IN ('month','fortnight')),
  plan       numeric(5,2)[],                    -- cumulative planned % per period (null = S-curve)
  actual     numeric(5,2)[],                    -- cumulative actual % per period (nulls allowed)
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL
);

-- ============================================================
-- 3. Logs
-- ============================================================
-- Authentication & security events: login, logout, 2FA, lockout, password…
CREATE TABLE auth_log (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  username   text,
  event      text NOT NULL,
  success    boolean NOT NULL,
  ip         inet,
  user_agent text,
  detail     jsonb
);
CREATE INDEX ON auth_log(ts DESC);
CREATE INDEX ON auth_log(user_id, ts DESC);
CREATE INDEX ON auth_log(event);

-- Audit trail of every data change (old/new values)
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  username   text,
  action     text NOT NULL,                     -- create | update | delete | import | bulk…
  entity     text NOT NULL,                     -- function | application | user | setting…
  entity_id  text,
  summary    text,
  old_value  jsonb,
  new_value  jsonb,
  ip         inet
);
CREATE INDEX ON audit_log(ts DESC);
CREATE INDEX ON audit_log(entity, entity_id);
CREATE INDEX ON audit_log(user_id, ts DESC);

-- HTTP access log (every API request)
CREATE TABLE access_log (
  id          bigserial PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  method      text NOT NULL,
  path        text NOT NULL,
  status      smallint NOT NULL,
  duration_ms integer NOT NULL,
  ip          inet,
  user_agent  text
);
CREATE INDEX ON access_log(ts DESC);
CREATE INDEX ON access_log(user_id, ts DESC);
CREATE INDEX ON access_log(status);

-- Application errors
CREATE TABLE error_log (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id) ON DELETE SET NULL,
  level      text NOT NULL DEFAULT 'error',
  message    text NOT NULL,
  stack      text,
  method     text,
  path       text,
  context    jsonb
);
CREATE INDEX ON error_log(ts DESC);

-- System events: startup, shutdown, migrations, seeding, imports, retention purge…
CREATE TABLE system_log (
  id         bigserial PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  level      text NOT NULL DEFAULT 'info',
  event      text NOT NULL,
  message    text,
  detail     jsonb
);
CREATE INDEX ON system_log(ts DESC);
