-- 008 — sign-in hardening (security remediation 1.0.0, ETS-SEC-001/002/021).
-- Lockout becomes a progressive delay per account that expires on its own: the failure counter now
-- restarts once the last failure is older than LOCKOUT_RESET_MINUTES, so it needs the time of that failure.
-- Safe to re-run; existing counters are kept (a NULL last_failed_at counts as "long ago", so an old
-- counter left over from the previous lockout model restarts at the next failure).
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_at timestamptz;

-- Recovery codes are now stored as "h1:" + HMAC-SHA-256 (key derived from APP_SECRET). Codes made before
-- this version stay valid (plain SHA-256, checked as a fallback) until they are used or regenerated.
COMMENT ON COLUMN user_recovery_codes.code_hash IS 'h1:<hex HMAC-SHA-256> (1.0.0+) or legacy <hex SHA-256>';
