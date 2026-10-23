-- ETS 1.12.18 — test→production release promotion pipeline, PHASE 1 (in-app foundation).
--
-- The administrator proves a version on the test server, then presses one button to promote that exact version to
-- production. Mirrors the backup trust split (backend/src/routes/backups.js + the root backup agent): the API runs
-- UNPRIVILEGED and never deploys anything itself — it records the promotion INTENT here (status 'requested' with a
-- signed manifest), and in Phase 2 a root agent (ets-release-publisher / ets-deploy-agent) validates it again, signs,
-- pushes, pulls, backs up, checks out, runs update.sh and health-gates. In Phase 1 the agent is MOCKED; no git push,
-- no checkout, no deploy happens from the application.
--
-- 1) release_promotions: the intent + lifecycle record. One row per promotion (or rollback). The signed manifest's
--    canonical fields (version, commit, prev_*, nonce, signer) live here; the signing KEY never does (same secrets rule
--    as backups — keys live only in root-owned files the API cannot read).
-- 2) release_agent_status (one row): the latest state the (Phase 2) deploy agent reports back — the deployed
--    version/commit on production, the last pull/verify result, and the last applied nonce for replay protection.
--
-- Forward-only and idempotent (like 022/023): CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS; re-running
-- the migration changes nothing. No data backfill.

CREATE TABLE IF NOT EXISTS release_promotions (
  id             bigserial PRIMARY KEY,
  version        text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  commit         text NOT NULL CHECK (commit ~ '^[0-9a-f]{40}$'),
  prev_version   text CHECK (prev_version IS NULL OR prev_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  prev_commit    text CHECK (prev_commit IS NULL OR prev_commit ~ '^[0-9a-f]{40}$'),
  nonce          text NOT NULL,                      -- random; replay protection, binds the signal to this row
  intent         text NOT NULL DEFAULT 'deploy' CHECK (intent IN ('deploy', 'rollback')),
  auto_rollback  boolean NOT NULL DEFAULT true,      -- Phase 3 honours this on a failed health check; Phase 1 stores/displays it
  requested_by   integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  authorized_by  integer REFERENCES users(id) ON DELETE SET NULL,   -- who passed the password + OTP re-auth + confirm
  authorized_at  timestamptz,
  signer         text,                               -- key id of the release key that signed the manifest
  manifest       jsonb,                              -- the canonical manifest that was signed (no secrets)
  signature      text,                               -- detached Ed25519 signature over the canonical manifest bytes (base64)
  status         text NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'publishing', 'deploying', 'succeeded', 'failed', 'rolled_back', 'cancelled')),
  backup_ref     text,                               -- the pre-deploy backup file name (for the DB rollback path)
  progress       jsonb,                              -- step checklist / percentages reported back, no secrets
  result         jsonb,                              -- health result, migrations applied, timings
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

-- recent / open promotions first (status + id), and the history view
CREATE INDEX IF NOT EXISTS release_promotions_status ON release_promotions (status, id DESC);
-- at most one promotion in flight at a time (no concurrent deploys) — §4.5(7) of the design
CREATE UNIQUE INDEX IF NOT EXISTS release_promotions_one_open ON release_promotions ((1))
  WHERE status IN ('requested', 'publishing', 'deploying');

CREATE TABLE IF NOT EXISTS release_agent_status (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- deployed version/commit, last pull, last verify result
  last_nonce     text,                                 -- nonce of the last applied manifest (replay protection)
  agent_seen_at  timestamptz,
  apply_error    text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
