-- ETS 1.9.0 — notifications (the bell, the history page, the Android app) and mobile devices.
--
-- notifications            one row per alert and recipient. Periodic alerts are summaries: one open (unread) row
--                          per user and dedupe_key (e.g. 'stuck:app=pur'), updated in place while unread
--                          (partial unique index). Nothing personal beyond what the recipient may see is stored:
--                          counts and names in params are computed for that recipient's scope. Eligibility
--                          (permission, scope, role, policy) is checked again whenever a row is read
--                          (backend/src/services/notify.js), so a row the user may no longer see is hidden, not
--                          deleted. Not audit data: no audit_log row per alert.
-- notification_prefs       the user's own choices: muted types (all channels / phone only), daily summaries on/off.
-- notification_user_blocks restrictions an administrator puts on one user (block only, never a grant): a type
--                          ('*' = every type that is not mandatory for the user) on every channel or on the phone.
-- notify_state             last state of the periodic checks (department / project status, last run of each job).
-- mobile_devices           phones paired with an account (Android app). Only an HMAC of the device token is stored;
--                          revoked_at / revoked_by / revoke_reason when the device is unpaired or revoked.
-- device_pair_codes        one-time pairing codes (QR on the profile page): HMAC only, 10-minute lifetime.
-- functions.progress_changed_at / test_changed_at
--                          when progress / test status last changed (updated_at changes with any edit, e.g. a
--                          note). Maintained by the trigger below; existing rows are filled from the change history
--                          (audit_log) where it has the value, otherwise from updated_at.

CREATE TABLE IF NOT EXISTS notifications (
  id          bigserial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  category    text NOT NULL CHECK (category IN ('tracking','approvals','plan','security','system')),
  severity    text NOT NULL CHECK (severity IN ('info','warning','critical')),
  params      jsonb NOT NULL DEFAULT '{}',
  link        text CHECK (link IS NULL OR link ~ '^/[A-Za-z0-9/_?=&.-]*$'),
  dept_id     text,
  app_id      text,
  dedupe_key  text NOT NULL,
  count       integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  resolved_at timestamptz                                   -- a summary whose condition no longer holds
);
CREATE INDEX IF NOT EXISTS notifications_user_time ON notifications(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_open_dedupe ON notifications(user_id, dedupe_key) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_dedupe ON notifications(dedupe_key, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs      jsonb NOT NULL DEFAULT '{}',                  -- {muted:[type], mobile_muted:[type], digest:true}
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_user_blocks (
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,                                -- an alert type, or '*'
  channel    text NOT NULL CHECK (channel IN ('all','mobile')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by integer REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, type, channel)
);

CREATE TABLE IF NOT EXISTS notify_state (
  key        text PRIMARY KEY,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mobile_devices (
  id            serial PRIMARY KEY,
  user_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  platform      text NOT NULL CHECK (platform IN ('android')),
  app_version   text CHECK (app_version IS NULL OR char_length(app_version) <= 40),
  token_hash    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_ip    inet,
  last_seen_at  timestamptz,
  last_ip       inet,
  revoked_at    timestamptz,
  revoked_by    integer REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN
    ('user','unpaired','admin','user_disabled','user_deleted','password_reset','inactive'))
);
CREATE INDEX IF NOT EXISTS mobile_devices_user ON mobile_devices(user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS device_pair_codes (
  code_hash  text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  device_id  integer REFERENCES mobile_devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS device_pair_codes_user ON device_pair_codes(user_id);

-- ---------------------------------------------------------------- "stuck" detection
ALTER TABLE functions
  ADD COLUMN IF NOT EXISTS progress_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS test_changed_at     timestamptz;

CREATE OR REPLACE FUNCTION ets_function_change_times() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS ets_function_change_times ON functions;
CREATE TRIGGER ets_function_change_times BEFORE INSERT OR UPDATE ON functions
  FOR EACH ROW EXECUTE FUNCTION ets_function_change_times();

-- One-time fill: the newest change history row that carries the value (a direct edit, an approved request or an
-- import: one 'update' row per function; a bulk set: the items of an application's 'bulk_update' row), else updated_at.
WITH single AS (
  SELECT entity_id::int AS id,
         max(ts) FILTER (WHERE new_value ? 'progress') AS p,
         max(ts) FILTER (WHERE new_value ? 'test_status') AS t
  FROM audit_log
  WHERE entity = 'function' AND entity_id ~ '^[0-9]{1,9}$' AND action IN ('update','create')
  GROUP BY 1
), bulk AS (
  SELECT (i->>'function_id')::int AS id,
         max(l.ts) FILTER (WHERE l.new_value->>'field' = 'progress') AS p,
         max(l.ts) FILTER (WHERE l.new_value->>'field' = 'test_status') AS t
  FROM audit_log l CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.context->'items') = 'array'
    THEN l.context->'items' ELSE '[]'::jsonb END) i
  WHERE l.entity = 'application' AND l.action = 'bulk_update' AND (i->>'function_id') ~ '^[0-9]{1,9}$'
  GROUP BY 1
), h AS (
  SELECT id, max(p) AS p, max(t) AS t FROM (SELECT * FROM single UNION ALL SELECT * FROM bulk) x GROUP BY id
)
UPDATE functions f SET
  progress_changed_at = COALESCE(h.p, f.updated_at),
  test_changed_at = COALESCE(h.t, f.updated_at)
FROM functions f2 LEFT JOIN h ON h.id = f2.id
WHERE f.id = f2.id AND (f.progress_changed_at IS NULL OR f.test_changed_at IS NULL);

COMMENT ON COLUMN functions.progress_changed_at IS 'last change of progress (trigger ets_function_change_times, 1.9.0)';
COMMENT ON COLUMN functions.test_changed_at IS 'last change of test_status (trigger ets_function_change_times, 1.9.0)';
