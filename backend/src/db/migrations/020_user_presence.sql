-- ETS 1.11.0 — who is working on the system now, on which screen, for how long («المستخدمون المتصلون الآن»).
--
-- 1) user_presence: one row per signed-in session that reported where it is (POST /api/presence, web app on every
--    screen change and every 60 s while its tab is visible). Upserted; screen_since moves only when the screen
--    changes. Only a whitelisted screen key and the id of its department / application / record are stored, never
--    free text from the browser to display (backend/src/services/presence.js builds the label). The row goes:
--      - with its session: ON DELETE CASCADE, and the trigger below as soon as the session is revoked (sign-out,
--        expiry detected, revoked by an administrator, password / 2FA reset, account deactivated or deleted);
--      - with the periodic clean-up (services/presence.js, advisory lock) once it is older than 15 minutes or its
--        session is no longer valid (an expiry that no request has noticed yet).
--    client: 'web', or 'mobile' when the request carries "X-ETS-Client: mobile" (the phone app, which uses the web
--    session cookie).
-- 2) user_activity_daily: seconds of activity per user and local day (notify.timezone): the time between two
--    presence reports of any of the user's sessions when they are at most 90 s apart, so several tabs / sessions at
--    the same time are not counted twice. Kept 7 days (clean-up), for «نشط اليوم» only.
-- 3) sessions.login_at: when the sign-in started. A sign-in with 2FA replaces the password-step session by a new one
--    (new token, ETS-SEC-015); the new row keeps the first row's time here, so the session duration starts at the
--    password step. NULL on rows from before 1.11.0: created_at is used then.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS login_at timestamptz;

CREATE TABLE IF NOT EXISTS user_presence (
  session_id     text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  user_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client         text NOT NULL DEFAULT 'web' CHECK (client IN ('web', 'mobile')),
  current_path   text NOT NULL CHECK (char_length(current_path) BETWEEN 1 AND 200),
  current_screen text NOT NULL CHECK (current_screen ~ '^[a-z_]{1,30}$'),
  screen_ref     text CHECK (screen_ref ~ '^[A-Za-z0-9_-]{1,40}$'),
  screen_since   timestamptz NOT NULL DEFAULT now(),
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  user_agent     text CHECK (char_length(user_agent) <= 160),
  ip             inet
);
CREATE INDEX IF NOT EXISTS user_presence_user ON user_presence(user_id);
CREATE INDEX IF NOT EXISTS user_presence_last_seen ON user_presence(last_seen);

CREATE TABLE IF NOT EXISTS user_activity_daily (
  user_id  integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  seconds  integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  last_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- A revoked session leaves the list at once, whichever code path revoked it.
CREATE OR REPLACE FUNCTION ets_presence_session_ended() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM user_presence WHERE session_id = NEW.id;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS sessions_presence_end ON sessions;
CREATE TRIGGER sessions_presence_end AFTER UPDATE OF revoked_at ON sessions
  FOR EACH ROW WHEN (NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL)
  EXECUTE FUNCTION ets_presence_session_ended();
