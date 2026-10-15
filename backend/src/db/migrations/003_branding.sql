-- ETS 0.5.0 — branding images uploaded from Settings → Branding (stored in the DB, so they are backed up).
--   logo     : system icon in the navbar and on the login screen
--   favicon  : browser tab icon
--   login_bg : background picture of the login screen
CREATE TABLE branding_assets (
  key        text PRIMARY KEY CHECK (key IN ('logo','favicon','login_bg')),
  mime       text NOT NULL,
  data       bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by integer REFERENCES users(id) ON DELETE SET NULL
);
