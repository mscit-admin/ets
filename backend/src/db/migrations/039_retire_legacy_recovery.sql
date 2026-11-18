-- ETS — retire the pre-1.0.0 recovery-code format (security review finding F4).
--
-- Recovery codes made before 1.0.0 were stored as a bare, unsalted SHA-256 (`<hex>`), which is open to an offline
-- dictionary attack by anyone with a read-only copy of the database. Since 1.0.0 they are a keyed HMAC-SHA-256 with
-- the `h1:` prefix (derived from APP_SECRET), which defeats that. A SHA-256 hash cannot be converted to the keyed
-- form, so the only way to retire the weak format is to drop the legacy rows: the affected users keep signing in with
-- their authenticator (TOTP) and generate fresh codes from their profile (the app already prompts when codes run low).
--
-- After this, every recovery-code hash is the keyed `h1:` form; a CHECK constraint keeps it that way. Forward-only.

DELETE FROM user_recovery_codes WHERE code_hash NOT LIKE 'h1:%';

ALTER TABLE user_recovery_codes
  ADD CONSTRAINT user_recovery_codes_keyed CHECK (code_hash LIKE 'h1:%') NOT VALID;
ALTER TABLE user_recovery_codes VALIDATE CONSTRAINT user_recovery_codes_keyed;

COMMENT ON COLUMN user_recovery_codes.code_hash IS 'h1:<hex HMAC-SHA-256> (keyed, from APP_SECRET); the legacy plain SHA-256 format was retired in migration 039';
