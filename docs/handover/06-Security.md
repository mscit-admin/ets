# 06 — Security

## 1. Authentication

| Control | Implementation |
|---|---|
| Password storage | bcrypt, cost 12 (`BCRYPT_ROUNDS`) |
| Password policy | Minimum length (setting, default 10), letters + digits, must not contain the username, must differ from the current one |
| Forced change | `must_change_password` set when an admin creates or resets an account. The API refuses everything except `/api/auth/*` until it is changed |
| Generic errors | Wrong user, wrong password and disabled account all return `invalid_credentials` (the real reason is logged) |
| Timing | Unknown usernames are checked against a dummy hash made with the same cost (`BCRYPT_ROUNDS`) as real hashes, so response time does not reveal valid usernames |
| Lockout | After `MAX_FAILED_LOGINS` (5) failures, locked for `LOCK_MINUTES` (15). Wrong 2FA codes count too. Admins can unlock |
| Rate limiting | 30 requests / 15 min / IP on login and 2FA endpoints in the API, plus 10 / min / IP on `/api/auth/login` in nginx |

## 2. Two-factor authentication

- TOTP per RFC 6238 (SHA-1, 6 digits, 30 s) with ±1 step tolerance. Verified against the RFC test vectors
  in `backend/test/totp.test.js`.
- The secret is 160 bits, stored **encrypted with AES-256-GCM** using a key derived from `APP_SECRET`, and
  never returned after enrolment.
- **Replay protection**: the last accepted time step is stored, so a code cannot be used twice.
- 10 recovery codes, shown once and stored as SHA-256 hashes. Each can be used once.
- Policy `off` / `optional` / `required`, plus per-user and bulk exemptions. Every change is logged.
- A login that passed the password but not 2FA gets a *partial* session, which can only call the 2FA
  endpoints.

## 3. Sessions

- A random 256-bit token is sent in the cookie `ets_sid` (`HttpOnly`, `SameSite=Strict`, `Secure` in
  production). The database stores only its SHA-256.
- The session expires 12 h after login (`SESSION_TTL_HOURS`) or after 60 min idle
  (`SESSION_IDLE_MINUTES`).
- Sessions are revoked on logout, password change (other sessions), admin password reset, deactivation, and
  admin *End sessions*.

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
