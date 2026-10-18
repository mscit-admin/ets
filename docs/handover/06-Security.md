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
| Client IP | Taken from nginx on the same server only (`TRUST_PROXY=loopback`); a client's own `X-Forwarded-For` cannot change it. Behind a load balancer configure nginx `real_ip` for the balancer's addresses only ([02 §9](02-Installation-Guide.md)); behind a shared NAT all users share the per-IP limits |
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

- A random 256-bit token is sent in the cookie `__Host-ets_sid` (`HttpOnly`, `SameSite=Strict`, `Secure`,
  path `/`), which browsers accept only over HTTPS for the whole site (a development setup over plain http with
  `COOKIE_SECURE=false` uses `ets_sid`). The database stores only its SHA-256. A production server (`NODE_ENV=production`) refuses to start with
  `COOKIE_SECURE=false` unless `ALLOW_INSECURE_COOKIES=true` is set (lab systems only).
- Signing in again from a browser revokes the session it had; completing 2FA issues a new token.
- The session expires 12 h after login (`SESSION_TTL_HOURS`) or after 60 min idle
  (`SESSION_IDLE_MINUTES`).
- Sessions are revoked on logout, password change (other sessions), admin password reset, admin 2FA reset,
  self-service 2FA disable (other sessions), `create-admin` from the command line (all sessions of that account),
  deactivation, admin *End sessions*, and after too many wrong answers to a re-authentication (that session).
- **Live updates (1.4.0, `GET /api/events`, Server-Sent Events):** signed-in users only (`requireAuth`); the
  events carry no data values — only "something changed" with department / application ids, sent only to users
  whose scope includes them — and every screen reloads through its usual scoped endpoint, so the scope rules
  and the export policy are unchanged. Each stream's session is re-checked on every heartbeat (25 s) and at once
  on sign-out, password change / reset, 2FA reset or disable, *End sessions*, deactivation and scope / role
  changes (PostgreSQL `NOTIFY` to every API process); an ended, expired or idle session closes the stream
  (`session_ended`). Neither the stream nor the reloads it triggers (`X-ETS-Live: 1`) count as activity, so an
  open dashboard does not defeat the idle timeout. At most 5 open streams per user (`LIVE_MAX_STREAMS_PER_USER`,
  per API process); opening a stream counts as one request for the general rate limit and is written to the
  access log once (heartbeats are not). The CSP `connect-src 'self'` already allows the same-origin stream.

## 4. Authorisation

- Every API route checks the permission key (`pct`, `wgt`, `tst`, `tog`, `sch`, `rep`, `exp`, `imp`, `usr`,
  `log`, `cfg`, `apv_dept`, `apv_final`) **and**, for tracker data, the data scope (departments/applications) on
  the server. The UI only hides what the
  server would refuse anyway.
- Field-level checks: for example, a tester can change `test_status`/`note` but not `progress`. A user without
  `tst` who sets a «with notes» status may write its note only while the function has no note yet; changing an
  existing note always needs `tst` (also re-checked when such a request is approved).
- Project-wide parameters, the project schedule (`PUT /tracker/schedule`), import and settings (read and write)
  need a full-scope user. The security logs (login & security, requests, errors, system), the log statistics,
  the integrity check and every IP address / user agent are for the **System Administrator role only**; other
  holders of `log` see the audit trail of their scope without IPs (removed by the server, also in CSV exports). Full scope comes only from the role (admin, PM, TM); a user of another role
  with no scope rows sees nothing (fail closed). The JSON export contains only the applications in the user's
  scope (and the project schedule only for full-scope users).
- `usr` (user management) is honoured for the System Administrator role only, and nobody can grant themselves
  permissions, scope or a 2FA exemption (also not through the bulk 2FA exemption, which leaves the caller out).
  An administrator changes their own password only through *My account* (current password asked), never with
  the *Reset password* action on their own account.
- Application-level scope never counts as department scope: edit approvals, import uploads, import approvals and
  batch details are limited to the applications in scope. A reader who sees only part of an import batch gets its
  figures (change count, counts, department figures) computed from the visible changes only and no project
  figure; pending counts on the project status page include only requests / batches of applications in scope.
  The import uploader signs neither approval stage.
- An approved edit request or import is applied only if its author is still active and still allowed to make it.
- Refused requests are logged in the login & security log: `access_denied` (permission / scope), `csrf_rejected`
  (missing CSRF header) and `password_change_required`.
- At least one active administrator always remains.

## 4a. Export policy / سياسة التصدير (1.3.0)

Every file that leaves the system through the screens follows one policy, enforced **on the server**
(`backend/src/routes/export.js`, `routes/logs.js`, `routes/tracker.js`); the buttons are only hidden in the UI.

1. **Permission `exp` for every export** — the Excel exports, the CSV log export (now `log` **and** `exp`) and the
   JSON tracker export. Roles holding `exp` by default: System Administrator, PM, TM, Department Manager, Team
   Lead; a per-user override can add or remove it.
2. **Same scope as the screen.** Each Excel export reads its rows through the same function as the screen it
   mirrors (`summaryData`, `departmentData`, `applicationData`, `listRequests`, `listBatches`, `batchDetail`,
   `listUsers`, `exportRows`), with the screen's filters, so it never contains more than the reader can see.
3. **Strict audit row.** Every export writes `action = export`, `entity = <report key>` (`log` for logs),
   `entity_id` = the department / application / batch / log type, and `new_value = {format, rows, truncated,
   filters, lang, target}` *before* the file is sent; if that row cannot be written the export is refused
   (500, no file — ETS-SEC-049). The Logs screen shows it as a sentence, e.g. «تصدير تقرير «وظائف التطبيق» —
   «…» إلى ملف إكسل (42 صف)» with the filters underneath.
4. **Safe files.** Strings are written as plain values, never as formulas, after the formula neutralisation of
   the CSV exports (a leading `'` before `= + - @ |` and their full-width forms — ETS-SEC-059); characters XML
   cannot carry are dropped. At most 100,000 rows per file. Arabic sheets are right-to-left.

| Report (key) | Screen | Permission | Scope | Sensitivity | Audit (`entity` / `entity_id`) |
|---|---|---|---|---|---|
| Dashboard summary (`summary`) | Dashboard | `exp` | departments in the reader's scope | internal | `summary` / — |
| Project status (`project_status`) | Project status | `exp` | reader's scope (project line = their departments) | internal | `project_status` / — |
| Department (`department`) | Department page | `exp` | department must be visible (else 403 `out_of_scope`) | internal | `department` / department id |
| Application functions (`functions`) | Application page | `exp` | application in scope (else 403); filters `q, source, test, show_off, show_removed` | internal | `functions` / application id |
| Weights (`weights`) | Weight distribution | `exp` | applications in scope | internal | `weights` / — |
| Reports (`reports`) | Reports | `exp` | applications in scope; filter `dept` | internal | `reports` / — |
| Schedule table (`schedule`) | Progress curve | `exp` | the project-wide table the screen shows to every reader | internal | `schedule` / — |
| Edit requests with items (`approvals`) | Approvals | `exp` | same visibility as `GET /approvals`; filters `status, mine` | internal, names of people | `approvals` / — |
| Import batches (`imports`) | Imports | `exp` | same visibility and partial figures as `GET /imports`; filter `status` | internal, names of people | `imports` / — |
| Import batch details (`import_detail`) | Batch page | `exp` | only changes of applications in scope (else 403) | internal | `import_detail` / batch id |
| Users (`users`) | Users | `usr` + System Administrator role + `exp` | all users | **personal data** — only full name, username, role, status, 2FA on/off, scope summary, last login, email; never passwords / hashes, recovery codes, sessions, IPs, user agents, failed attempts or lock times | `users` / — |
| Logs, Excel (`log`) and CSV | Logs | `log` + `exp` | security logs (auth, access, error, system) for administrators only; others the audit trail of their applications, without IP / device | **security-sensitive** | `log` / log type |
| Tracker data, JSON | Settings | `exp` | applications in scope; schedule for full scope only | internal | `tracker` / — |

## 5. Web protections

| Threat | Control |
|---|---|
| CSRF | SameSite=Strict cookie, plus every state-changing request must send `X-Requested-With: ets` (refused otherwise: `403 csrf_rejected`, logged for signed-in users); request bodies must be `application/json` (`415` otherwise) |
| XSS | React escapes output; strict Content-Security-Policy (`default-src 'self'`, no inline scripts, no third-party hosts) on the API (helmet) **and** on the web pages and assets served by nginx (`/etc/nginx/snippets/ets-headers.conf`, included in every nginx location that sets its own headers, because nginx does not inherit `add_header` into such a location) |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` (API and web pages) |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` (camera, microphone, geolocation… off), `Cross-Origin-Opener-Policy` / `-Resource-Policy: same-origin`; `server_tokens off` (no nginx version); `/api/health` does not show the application version |
| TLS details | Always HTTPS (the installer has no plain-HTTP mode). nginx: TLS 1.2/1.3 with forward-secret AEAD ciphers only (Mozilla "intermediate"), no session tickets, HSTS, HTTP → HTTPS redirect. The self-signed certificate is a server certificate (`CA:FALSE`, `serverAuth`, for the ETS address only): never install it as a trusted root CA on client PCs |
| Database connection | Local: loopback only. Remote: always TLS (`PGSSLMODE=require`, or `verify-full` with the DB server's CA in `PGSSLROOTCERT`) for the application and the backup/restore tools; the application refuses to start with an unencrypted connection to another machine. A hand-written `DATABASE_URL` is checked the same way: its host (also `?host=`) and its `sslmode` / `ssl` parameters count (they win over `PGSSLMODE`; `ssl=true` = verify-full), `sslmode=disable/allow/prefer` or `ssl=false/0` to another machine is refused, and the pool always uses the checked TLS settings |
| SQL injection | Parameterised queries only; dynamic column names come from fixed allow-lists |
| Transport | HTTPS (TLS 1.2/1.3) by nginx, HSTS, HTTP → HTTPS redirect |
| CSV injection | Exported cells that could start a formula (`= + - @ \|`, their full-width forms, also after leading spaces/invisible characters, or starting with tab/CR/LF) are prefixed with `'`. Open exports with formulas disabled when in doubt |
| Caching of data | `Cache-Control: no-store` on all API responses |
| Large payloads | Request bodies must be JSON (`415` otherwise), at most 100 kB and 32 levels deep; nginx allows 128 kB. Only the file uploads (`POST /api/imports`, `/api/imports/preview`, `/api/tracker/import`, `PUT /api/branding/:key`) take up to 5 MB (nginx 6 MB), read only after login, CSRF and permission checks |
| Input validation | Ids, dates, pages and lists are checked before they reach the database (`400 invalid_id` / `invalid_value` / `invalid_date`); allow-lists never match inherited names such as `toString` or `__proto__` |
| Visual spoofing | Bidirectional control characters (U+202A–202E, U+2066–2069, U+200E/200F) are removed from all text sent to the API (passwords excepted) |
| Branding images | Metadata (EXIF/GPS, XMP, comments, PNG text chunks) and any bytes after the end of the image are removed on upload; the pixels are not changed |

## 6. Server hardening

- The service runs as the unprivileged `ets` user with systemd sandboxing: no capabilities, `ProtectSystem=strict`,
  `ProtectHome`, `PrivateTmp`, `PrivateDevices`, kernel/clock/hostname/log protection, `ProtectProc=invisible`,
  `NoNewPrivileges`, `RestrictNamespaces`, `RestrictAddressFamilies` (Unix, IPv4/6, netlink), a system-call
  filter (`@system-service`), `UMask=0027` (log files not world-readable) and an IP allow-list (loopback plus a
  remote database given by IP address). It can only write to `/var/log/ets`. Check with
  `systemd-analyze security ets-backend` (about 1.4 "OK" offline, was 7.4).
- The API listens on `127.0.0.1` only (`HOST`); a local PostgreSQL should too (the installer warns when it listens
  on other addresses or `pg_hba.conf` has trust/md5 network rules). When the firewall option is chosen, ufw allows
  only SSH and the web ports.
- `/etc/ets/ets.env` is mode 640, `root:ets`; its earlier versions `ets.env.bak-*` are root-only (5 kept).
- The database role `ets` owns only the `ets` database (not a superuser) and, on a protected installation, not
  the log tables or schema `public`; `PUBLIC` may not connect to it or create objects in its `public` schema. The role's password is set as a SCRAM verifier, never in clear text on
  a command line or in the PostgreSQL log.
- `/opt/ets` holds only the runtime files (no docs, tests, reference data), owned by root; the backend is
  readable by the `ets` group only, the built web pages by everyone (nginx). Packages are installed and the
  frontend is built by the unprivileged `ets-build` user with `npm ci --ignore-scripts`, and `npm audit` runs at
  every install/update. Node.js comes from the NodeSource apt repository, whose signing key fingerprint is
  pinned in `deploy/scripts/deploy-lib.sh` (`NODESOURCE_FPR`; confirm it against NodeSource's documentation
  when they rotate keys). Supported runtime: Node.js 22.12+ or 24+ (Node 22 is maintained until April 2027).
- Dependency updates: `.github/dependabot.yml` proposes npm (backend, frontend) and GitHub Actions updates weekly,
  only for versions published at least 7 days earlier.
- Audit trail: `audit_log` and `auth_log` are append-only (database triggers) and hash-chained; `npm run
  verify-audit` / *Logs → Verify log integrity* recompute the chain. Retention: at least 365 days for the audit
  trail, enforced by the database too. The log tables belong to a separate owner role (`ets_log_owner`), so the
  application's database role can only read and append them; the installer and `update.sh` apply this
  automatically for a local database (`ets-log-protect`), a remote database's DBA applies it once
  (07-Logging-and-Audit.md §3).

## 6a. Secrets and keys

| Secret | Where | Protection |
|---|---|---|
| `APP_SECRET` | `/etc/ets/ets.env` | Encrypts the 2FA secrets (AES-256-GCM, key = HKDF-SHA-256 of `APP_SECRET`, 16-byte tag enforced, format `v2:<key id>:…`; older `v1` values are still read). Placeholders and short or low-variety values are refused at start |
| Database password | `/etc/ets/ets.env` | Root and the `ets` group only |
| Backup key | `/etc/ets/backup.key` (root, 600) | Encrypts the backups (gpg AES-256). Kept **separately** from the backups — see [08-Backup-and-Recovery.md](08-Backup-and-Recovery.md) |

**Rotating `APP_SECRET`** (e.g. after a suspected leak of `ets.env`):

```bash
sudo nano /etc/ets/ets.env
#   APP_SECRET_OLD='<the current value>'
#   APP_SECRET='<new value from: openssl rand -base64 48>'
sudo systemctl restart ets-backend                       # old 2FA secrets still readable via APP_SECRET_OLD
cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env node scripts/rotate-app-secret.js
#   → "Re-encrypted N 2FA secret(s); 0 failure(s)."
sudo nano /etc/ets/ets.env                               # remove the APP_SECRET_OLD line
sudo systemctl restart ets-backend
```

Then store the new `ets.env` in the safe place. Backups taken before the rotation need the old `APP_SECRET`
to read 2FA secrets after a restore (put it in `APP_SECRET_OLD` and run the script again).

## 7. Recommendations for the customer

1. Use a certificate from the organisation's CA or Let's Encrypt instead of the self-signed one.
2. Set the 2FA policy to **Required** after users have been trained. Exempt only service or emergency
   accounts.
3. Keep two administrator accounts, both with 2FA.
4. Keep a copy of `/etc/ets/ets.env` and of the backup key `/etc/ets/backup.key` off the server in a safe place
   (password manager / sealed envelope), **not** together with the backup files.
5. Review the *Login & security* log weekly (failed attempts, lockouts, access denied), run *Logs → Verify log
   integrity* and keep the chain heads it shows somewhere off the server. Forward the journal (`"alert":true`
   events) to a central syslog / SIEM. Check `sudo ets-log-protect status` after updates and restores; with a
   remote database, have the DBA protect the log tables (see 07-Logging-and-Audit.md §3).
6. Apply Ubuntu security updates monthly (`sudo apt update && sudo apt upgrade`) and enable
   `unattended-upgrades`. Apply ETS updates (with their dependency fixes) with `deploy/scripts/update.sh`.
7. Restrict SSH to key-based login and to administrator IPs.
