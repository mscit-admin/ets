-- ETS 1.11.0 — read-only sessions of the Android app («ETS Alerts» 1.1.0 shows the web application in the app).
--
-- client:   'web' (a browser) or 'mobile' (the Android app's built-in browser, recognised at sign-in by the
--           "ETSAlerts/<version> (Android)" marker it adds to its User-Agent — middleware/auth.js).
-- readonly: the session may read (GET) but not change anything: every POST / PUT / PATCH / DELETE is refused with
--           403 readonly_session, except signing in and out, the 2FA step, a forced password change, the language
--           and the user's own alerts (marking them read, preferences) — middleware/auth.js, readonlyGuard.
--           It is a restriction, never a privilege: claiming to be the app (the User-Agent can be spoofed) only takes
--           rights away. A session keeps the flag for its whole life; the 2FA step's new session inherits it.
-- Existing sessions are browser sessions: 'web', not read-only.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS readonly boolean NOT NULL DEFAULT false;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_client_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_client_check CHECK (client IN ('web', 'mobile'));
