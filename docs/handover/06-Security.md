# 06 — Security

## 1. Authentication

| Control | Implementation |
|---|---|
| Password storage | bcrypt, cost 12 (`BCRYPT_ROUNDS`, kept within 10–14). A hash made with another cost is re-hashed at the next successful sign-in |
| Password policy | Minimum length (setting, default 10, never below 10; **12 for administrators**, also in `create-admin`), at most 72 bytes (bcrypt ignores the rest; about 36 Arabic letters), letters + digits, not a common password (built-in offline list, digits/symbols at the ends ignored), must not contain the username, must differ from the current one |
| Forced change | `must_change_password` set when an admin creates or resets an account. Until it is changed the API allows only changing the password, the language, `/auth/me` and sign-out |
| Generic errors | Wrong user, wrong password, disabled account and a paused account all return the same `401 invalid_credentials` (the real reason is logged) |
| Timing | Unknown usernames and paused accounts are checked against a dummy hash made with the same cost (`BCRYPT_ROUNDS`) as real hashes, so response time does not reveal valid usernames |
| Lockout (progressive delay) | Every failed password, 2FA code or recovery-code check on an account counts (login, 2FA step, and the re-authentication on the profile page). From `MAX_FAILED_LOGINS` (5) failures, sign-in to the account pauses for 1, 2, 4, 8 … minutes, at most `LOCK_MINUTES` (15). The pause ends by itself; the counter restarts once the last failure is older than `LOCKOUT_RESET_MINUTES` (60) and is cleared only by a **complete** sign-in (password and 2FA) or by an admin (*Unlock*). Concurrent attempts on one account are checked one after another |
| Rate limiting | API: 30 / 15 min per IP across all password / code checking endpoints (login, 2FA verify / setup / enable / disable, recovery codes, change password), and 30 failed requests / 15 min per account (by the username typed, whether or not it exists), answered with `429 too_many_attempts` + `retry_after` seconds. Every `/api` request: `API_RATE_LIMIT` (600) / min per IP (`429 too_many_requests`). nginx: 10 / min / IP on the same endpoints (any letter case, with or without a trailing slash) |

## 2. Two-factor authentication

- TOTP per RFC 6238 (SHA-1, 6 digits, 30 s) with ±1 step tolerance. Verified against the RFC test vectors
  in `backend/test/totp.test.js`.
- The secret is 160 bits, stored **encrypted with AES-256-GCM** using a key derived from `APP_SECRET`, and
  never returned after enrolment.
- **Replay protection**: the last accepted time step is stored and moved forward with a conditional update, so a
  code cannot be used twice, even when sent in parallel.
- 10 recovery codes of 12 characters (about 59 bits), shown once and stored as HMAC-SHA-256 with a key derived
  from `APP_SECRET` (HKDF), so a database copy alone is not enough to find them. Each can be used once. Codes made
  before version 1.0.0 (plain SHA-256) keep working until used; the profile page asks the user to generate new ones.
- Turning 2FA on from the profile needs the password; turning it off or generating new recovery codes needs the
  password **and** an authenticator or recovery code. Wrong answers count towards the account's pause; reaching
  the limit also ends the session that sent them.
- Policy `off` / `optional` / `required`, plus per-user and bulk exemptions. Every change is logged.
- A login that passed the password but not 2FA gets a *partial* session, which can only call the 2FA
  endpoints; `/auth/me` then returns only the username, language and stage. When 2FA completes, the partial
  session is replaced by a new one (new cookie value).

## 3. Sessions

- A random 256-bit token is sent in the cookie `ets_sid` (`HttpOnly`, `SameSite=Strict`, `Secure` in
  production). With `Secure` the name is `__Host-ets_sid`, which browsers accept only over HTTPS for the whole
  site. The database stores only its SHA-256. A production server (`NODE_ENV=production`) refuses to start with
  `COOKIE_SECURE=false` unless `ALLOW_INSECURE_COOKIES=true` is set (lab systems only).
- Signing in again from a browser revokes the session it had; completing 2FA issues a new token.
- The session expires 12 h after login (`SESSION_TTL_HOURS`) or after 60 min idle
  (`SESSION_IDLE_MINUTES`).
- Sessions are revoked on logout, password change (other sessions), admin password reset, admin 2FA reset,
  self-service 2FA disable (other sessions), `create-admin` from the command line (all sessions of that account),
  deactivation, admin *End sessions*, and after too many wrong answers to a re-authentication (that session).

## 4. Authorisation

- Every API route checks the permission key (`pct`, `wgt`, `tst`, `tog`, `sch`, `rep`, `exp`, `imp`, `usr`,
  `log`, `cfg`) **and** the data scope (departments/applications) on the server. The UI only hides what the
  server would refuse anyway.
- Field-level checks: for example, a tester can change `test_status`/`note` but not `progress`.
- Project-wide parameters, import, settings and full logs need a full-scope user.
- Refused requests are logged as `access_denied` in the login & security log.
- At least one active administrator always remains.

## 5. Web protections

| Threat | Control |
|---|---|
| CSRF | SameSite=Strict cookie, plus every state-changing request must send `X-Requested-With: ets` with JSON |
| XSS | React escapes output; strict Content-Security-Policy (`default-src 'self'`, no inline scripts, no third-party hosts) |
| Clickjacking | `frame-ancestors 'none'`, X-Frame-Options |
| SQL injection | Parameterised queries only; dynamic column names come from fixed allow-lists |
| Transport | HTTPS (TLS 1.2/1.3) by nginx, HSTS, HTTP → HTTPS redirect |
| CSV injection | Exported cells beginning with `= + - @` are prefixed with `'` |
| Caching of data | `Cache-Control: no-store` on all API responses |
| Large payloads | 5 MB JSON limit (API), 6 MB (nginx) |

## 6. Server hardening

- The service runs as the unprivileged `ets` user with systemd sandboxing (`ProtectSystem=strict`,
  `ProtectHome`, `NoNewPrivileges`, `PrivateTmp`). It can only write to `/var/log/ets`.
- The API and PostgreSQL listen on `127.0.0.1` only. The firewall (ufw) allows only SSH, 80 and 443.
- `/etc/ets/ets.env` is mode 640, `root:ets`.
- The database role `ets` owns only the `ets` database (not a superuser).

## 7. Recommendations for the customer

1. Use a certificate from the organisation's CA or Let's Encrypt instead of the self-signed one.
2. Set the 2FA policy to **Required** after users have been trained. Exempt only service or emergency
   accounts.
3. Keep two administrator accounts, both with 2FA.
4. Keep a copy of `/etc/ets/ets.env` with the backups, stored securely and off the server.
5. Review the *Login & security* log weekly (failed attempts, lockouts, access denied).
6. Apply Ubuntu security updates monthly (`sudo apt update && sudo apt upgrade`) and enable
   `unattended-upgrades`.
7. Restrict SSH to key-based login and to administrator IPs.
