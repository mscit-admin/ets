# 06 — Security

## 1. Authentication

| Control | Implementation |
|---|---|
| Sign-in name (1.6.0) | The login field takes the **username or the e-mail address**. The value is trimmed; one containing `@` is looked up by `lower(email)`, anything else by username (case-insensitive, as before). Usernames cannot contain `@` (create, update, import, `create-admin`), so the two never collide; an older account whose username has `@` is still found by it when no e-mail matches. An e-mail address belongs to one account (unique index on `lower(email)`, migration 014; the API refuses a duplicate with `email_taken`). If old data still has an address on several accounts (index not created yet, [05 §3b](05-Database-Design.md)), signing in **by that address** is refused with the generic error and logged `login_ambiguous_email`; by username it works |
| Password storage | bcrypt, cost 12 (`BCRYPT_ROUNDS`, kept within 10–14). A hash made with another cost is re-hashed at the next successful sign-in |
| Password policy | Minimum length (setting, default 10, never below 10; **12 for administrators**, also in `create-admin`), at most 72 bytes (bcrypt ignores the rest; about 36 Arabic letters), letters + digits, not a common password (built-in offline list, digits/symbols at the ends ignored), must not contain the username, must differ from the current one |
| Forced change | `must_change_password` set when an admin creates or resets an account. Until it is changed the API allows only changing the password, the language, `/auth/me` and sign-out |
| Generic errors | Wrong user or e-mail, wrong password, disabled account, a paused account and an e-mail address shared by several accounts all return the same `401 invalid_credentials`, without a cookie (the real reason is logged). The answer is the same whether the username or the e-mail address was typed, so neither can be used to find out which accounts or addresses exist |
| Timing | Unknown usernames / e-mail addresses, shared addresses and paused accounts are checked against a dummy hash made with the same cost (`BCRYPT_ROUNDS`) as real hashes, so response time does not reveal valid usernames or addresses (the e-mail lookup adds one indexed query, far below the bcrypt time) |
| Lockout (progressive delay) | Every failed password, 2FA code or recovery-code check on an account counts (login, 2FA step, and the re-authentication on the profile page). From `MAX_FAILED_LOGINS` (5) failures, sign-in to the account pauses for 1, 2, 4, 8 … minutes, at most `LOCK_MINUTES` (15). The pause ends by itself; the counter restarts once the last failure is older than `LOCKOUT_RESET_MINUTES` (60) and is cleared only by a **complete** sign-in (password and 2FA) or by an admin (*Unlock*). Concurrent attempts on one account are checked one after another. The counter and that queue belong to the **account** (resolved user id): failures typed with the username and with the e-mail address add up — e.g. 3 by username + 2 by e-mail pause the account, and a pause applies to both names |
| Client IP | Taken from nginx on the same server only (`TRUST_PROXY=loopback`); a client's own `X-Forwarded-For` cannot change it. Behind a load balancer configure nginx `real_ip` for the balancer's addresses only ([02 §9](02-Installation-Guide.md)); behind a shared NAT all users share the per-IP limits |
| Rate limiting | API: 30 / 15 min per IP across all password / code checking endpoints (login, 2FA verify / setup / enable / disable, recovery codes, change password), and 30 failed requests / 15 min per account (by the name typed — username or e-mail, trimmed and in lower case — whether or not it exists; the username and the e-mail address of one account are two separate budgets here, the account counter above adds them up), answered with `429 too_many_attempts` + `retry_after` seconds. Every `/api` request: `API_RATE_LIMIT` (600) / min per IP (`429 too_many_requests`). nginx: 10 / min / IP on the same endpoints (any letter case, with or without a trailing slash) |

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
  (`SESSION_IDLE_MINUTES`). The server is the authority: an expired session is revoked by the first request that
  presents it (`revoke_reason = 'expired'`, `auth_log` `session_expired` with `detail.reason` idle / absolute), the
  cookie is cleared, and every later request with it — any route, a reload or a hard reload — is refused
  (`session_revoked_reuse`).
- **Idle = no genuine user activity (1.12.2).** Only a request carrying `X-ETS-Activity: 1` moves
  `sessions.last_seen_at` (at most once per 30 s). The web app sends it only from real input — `pointerdown`,
  `keydown`, `wheel`, `touchstart` (not `mousemove`, which browsers also fire when content moves under a still
  pointer) — as `POST /api/auth/activity`, at most once a minute (`frontend/src/lib/activity.js`). Data loads, polls,
  `/auth/me` checks, live reloads (`X-ETS-Live: 1`, which wins over the activity header), the live stream and
  presence reports never extend a session, so an open screen or a forgotten tab cannot keep it alive. Before
  1.12.2 the rule was the reverse (every request counted except the stream, `X-ETS-Live` and presence), so any
  untagged automatic request — e.g. the 30 s refresh of Settings → «النسخ الاحتياطي», or a page reload — kept
  the session alive.
- **The browser signs out on its own:** when a tab has seen no input for `SESSION_IDLE_MINUTES` (or the absolute end
  is reached) it asks the server (`/auth/me`, not activity); if another tab of the same browser kept the session
  alive it waits for the new deadline, otherwise it calls `POST /api/auth/logout {reason:"idle"}` (session revoked,
  cookie cleared) and shows the sign-in page with «انتهت الجلسة بسبب عدم النشاط». A hidden tab or a sleeping PC is
  checked when the tab becomes visible again. A failed session check (network, 5xx) no longer shows the sign-in
  page while the session may still be valid, and an older answer can no longer overwrite a newer one.
- The phone app (`mobile/`) sends `X-ETS-Activity: 1` on the requests a person starts and `X-ETS-Live: 1` on its
  automatic ones (polling, live reloads, presence, session checks).
- Sessions are revoked on logout, password change (other sessions), admin password reset, admin 2FA reset,
  self-service 2FA disable (other sessions), `create-admin` from the command line (all sessions of that account),
  deactivation, admin *End sessions* (all, or one session from «المستخدمون المتصلون الآن», 1.11.0), and after too
  many wrong answers to a re-authentication (that session).
- **Live updates (1.4.0, `GET /api/events`, Server-Sent Events):** signed-in users only (`requireAuth`); the
  events carry no data values — only "something changed" with department / application ids, sent only to users
  whose scope includes them — and every screen reloads through its usual scoped endpoint, so the scope rules
  and the export policy are unchanged. Each stream's session is re-checked on every heartbeat (25 s) and at once
  on sign-out, password change / reset, 2FA reset or disable, *End sessions*, deactivation and scope / role
  changes (PostgreSQL `NOTIFY` to every API process); an ended, expired or idle session closes the stream
  (`session_ended`). Neither the stream nor the reloads it triggers (`X-ETS-Live: 1`) count as activity, so an
  open dashboard does not defeat the idle timeout (1.12.2: only `X-ETS-Activity: 1` counts, see above). At most 5 open streams per user (`LIVE_MAX_STREAMS_PER_USER`,
  per API process); opening a stream counts as one request for the general rate limit and is written to the
  access log once (heartbeats are not). The CSP `connect-src 'self'` already allows the same-origin stream.

## 3a. Online users — a privacy-sensitive view / المستخدمون المتصلون الآن (1.11.0)

«المستخدمون المتصلون الآن» shows, per signed-in session, which screen a person has open, since when, how long they
have been signed in, how long they were active today, their browser / system and IP address. That is monitoring of
people's work, so:

- **Who can see it:** system administrators only — the same guard as the Users screen (`requireAuth` +
  `usr` + role `admin`, ETS-SEC-004); an `usr` override on another role is dropped by the server and never opens it.
  `GET /api/presence` and `/api/presence/count` answer 403 to everyone else; no other screen, export, notification or
  live event tells anyone who is online.
- **Viewing is audited:** opening the list writes `view` / `presence` / `online_users` to the change history, at most
  once per 15 minutes per administrator (same rule as the security logs, ETS-SEC-050). Ending a session from it is
  audited (`revoke_sessions` with `session_ref`, and `sessions_revoked_by_admin` in the sign-in log).
- **What a browser can write:** `POST /api/presence` updates only the row of the session whose cookie it carries
  (nothing in the body names a session or a user). The path is checked (≤ 200 characters of
  `A–Z a–z 0–9 / _ . ~ % -`), the screen must be a known key and the id must exist (department, application, import
  batch, user) — otherwise the screen is stored as `unknown`. Labels and links are built on the server from the key
  and names looked up in the database, never from text the browser sent, so a client cannot inject what an
  administrator reads. One database write per session every 10 s at most (`PRESENCE_MIN_INTERVAL_SECONDS`), the
  rest coalesced; the general per-IP limit still applies. Successful reports are written to the file access log
  only (not `access_log`), refused ones as usual.
- **No effect on session security:** a presence report never counts as activity for the idle timeout (the route
  itself is excluded in `sessionMiddleware` even with `X-ETS-Activity: 1`, and the web app also sends `X-ETS-Live: 1`); a session left open on a
  screen still ends after `SESSION_IDLE_MINUTES` without user action, and its row goes with it.
- **Retention:** a row exists only while its session does: it is deleted when the session is revoked (trigger), and
  by the 5-minute clean-up 15 minutes after the last report or once the session expired. `user_activity_daily`
  (seconds per user and day) is kept 7 days. A backup holds only the rows present when it was taken.
- **IP addresses** are shown here because the readers are administrators — consistent with the logs, where IPs and
  user agents are for administrators only (ETS-SEC-047). The customer should tell staff that sign-ins, the screen
  in use and active time are visible to system administrators (internal policy / notice).

## 4. Authorisation

- Every API route checks the permission key (`pct`, `wgt`, `tst`, `tog`, `ren`, `mov`, `sch`, `rep`, `exp`, `imp`,
  `usr`, `log`, `cfg`, `apv_dept`, `apv_final`) **and**, for tracker data, the data scope (departments/applications) on
  the server. The UI only hides what the
  server would refuse anyway.
- Renaming an item (`name_ar` / `name_en` with its reason) needs `ren` (1.9.2), not `tog`: an administrator can
  let a user add / remove / include items without renaming them, or the reverse. Migration 018 gave `ren` to every
  role and per-user override that had `tog` (same value), so the upgrade changed nobody's rights. When a team
  member's rename is approved, the server re-checks the member's `ren` (ETS-SEC-027); the approving team lead needs
  `apv_dept` and the scope, as for every other field.
- Moving an item to another application (1.10.0) needs `mov` **and both applications in scope** (403 otherwise), so
  a user can never move an item into or out of an application they cannot see. `mov` is a new capability: migration
  019 gives it to admin, pm, tm, mgr and lead and copies it from no override (members, editors, testers, observers do
  not get it). A move is direct only for an approver of both applications (`apv_dept` with both in scope), `cfg` /
  `apv_final` holders, or when approvals are off; otherwise it needs the source application's team lead and then
  the destination's — never its author. Each approval re-checks the author (active, `mov`, both applications in
  scope — ETS-SEC-027) and the items (still in the source, not removed, nothing else pending), and the weight share
  is recomputed then. The two applications are locked in a fixed order (by id) so concurrent moves cannot deadlock.
  Every move writes a strict audit row per item and per application weight; the old department keeps read access
  to the item's audit history up to the move only. Names of an application outside the reader's scope are not shown
  in the «منقول من» badge or the T8 alert.
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
- **Deleting users (1.7.0)** — a soft delete (the row and the history stay): System Administrator role only, never
  your own account, never the last active administrator holding `usr` and `cfg` (counted after overrides, rows
  locked), a reason of 3–500 characters, at most 200 users per request, all or nothing. The deleted account is
  treated as inactive by the session middleware (`loadUserContext`), so a surviving session is useless on every path —
  API, 2FA verify / setup, re-authentication (change password, 2FA disable, recovery codes) and the live stream;
  sign-in by username or e-mail never finds it (same `invalid_credentials` answer as an unknown name). All its
  sessions are revoked, its authenticator and recovery codes removed, its pending requests withdrawn and pending
  import files rejected, in the same transaction as the strict audit rows. There is no separate re-authentication
  for this administrator action (the application has none for administrator actions); the reason and the audit rows
  (`delete`, `bulk_delete`, auth `user_deleted_by_admin`) make it accountable. Restoring sets a new random temporary
  password that must be changed at the next sign-in, and is refused (409) when the username or e-mail now belongs to
  another account.

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

## 4b. Notification policy and phone devices / سياسة الإشعارات والأجهزة (1.9.0)

**Receiving = eligibility ∧ policy ∧ user restrictions ∧ active account**, each layer only narrowing
(`backend/src/services/notify.js`, `notify-catalog.js`):

1. **Eligibility in code** — the type's permission from the *effective* permissions (role + overrides) and its scope
   rule: `canSeeApp` (application), `coversDept` (whole department — an application scope is not enough), full scope
   (project alerts), `apv_dept` + application in scope (approvals, the same rule as the Approvals screen), an
   approval permission + every department of the batch (imports), the user the alert is about (own request / file).
   Security and system alerts: `role = admin` only, never from a setting or override (same rule as the security
   logs, ETS-SEC-047). A scoped role without scope rows receives nothing (ETS-SEC-005).
2. **Policy** `notify.policy` (Settings, `cfg` + full scope): a cell outside eligibility cannot be enabled and a
   mandatory cell cannot be disabled (`SETTING_RULES`, 400 `invalid_value`); audited complete before / after.
3. **Restrictions** — administrator blocks per user (`usr` + admin role; never on oneself; not on a type mandatory in
   code for the user's role on every channel; audited), then the user's own muting of non-mandatory types.

**Checked twice**: when an alert is created and whenever it is read (list, count, phone list, phone stream). Removing a
permission, scope or policy cell hides existing alerts at once. **Content**: counts and names are computed per
recipient within their scope; links are internal paths (`^/[A-Za-z0-9/_?=&.-]*$`, else dropped); the live stream
carries only `{unread, top_severity}`; alerts are not audit data. **Flood control**: one open summary per key, at most
`notify.rate_cap_per_hour` (50) new alerts per user per hour (mandatory ones exempt), retention `notify.retention_days`.

**Phones (Android app).**

| Item | Rule |
|---|---|
| Pairing code | issued by `POST /api/devices/pair-code` from a full session after re-authentication (password, plus a TOTP / recovery code when 2FA is on; failures count towards the account pause); 10 characters (~49 bits), one-time, 10 minutes, HMAC-SHA-256 stored (key from `APP_SECRET`); a new code replaces unused ones; `mobile_pair_code_issued` in `auth_log` |
| Pairing | `POST /api/devices/pair` without a session: `PAIR_RATE_LIMIT` (5) attempts per IP per 15 min in the API, plus the nginx login zone; refused for an account that is inactive, deleted, paused or must change its password; at most 10 active phones per account; `mobile_device_paired` (auth_log, with the certificate fingerprint) and `pair:device` (audit_log) in the same transaction |
| Device token | 32 random bytes (base64url), returned once, stored as HMAC-SHA-256 with a key derived from `APP_SECRET` (previous secrets in `APP_SECRET_OLD` accepted and the hash moved to the current key). `Authorization: Bearer` only, on `/api/m/*` only: the web API reads only the session cookie and `/api/m` never reads it, so a stolen token cannot act in the web application and a session cookie cannot reach `/api/m`. Read-only scope: own alerts, mark read, live stream, own name / language, self-unpair |
| Refusal | 401 `invalid_token` for an unknown / revoked token or an account that is inactive, deleted, paused after failed sign-ins or must change its password; `mobile_token_rejected` in auth_log (once per minute per address and reason); 30 refusals per address per 15 min → 429 |
| Revocation | by the user (profile, or the phone: `DELETE /api/m/device`), an administrator (user page), and **in the same transaction** as deactivation, deletion and an administrator password reset; after `notify.device_idle_days` (90) without use by the daily check. Open phone streams close at once (and on every heartbeat re-check). `mobile_device_revoked` (auth_log) + `revoke:device` (audit_log, readable sentence) |
| Phone content | only types whose policy allows the phone and that the user / an administrator did not take off the phone; a mandatory type kept off the phone appears as «لديك تنبيه جديد» without title or body; security and system alerts reach the phone without their body (no user names or IP addresses); S1, S2, S5, S8 are in-app only by default |
| Transport | HTTPS through nginx; the QR carries `cert_sha256` (`TLS_CERT_SHA256`, the SHA-256 of the server certificate filled by install / update) for the app to pin; outside the organisation network only through the VPN — never expose the port to the internet |

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
| Backup key | `/etc/ets/backup.key` (root, 600) | Encrypts every backup artifact (gpg symmetric AES-256 with MDC: a modified file does not decrypt). **Never** put in a backup; escrowed by hand and attested in the web UI — see [08 §6](08-Backup-and-Recovery.md). Only its id (salted scrypt, 16 hex) is written next to the backups. A passphrase chosen in the UI: ≥ 16 characters of 3 kinds or ≥ 24 characters, never an example value |
| SSH key of the SSH destination | `/etc/ets/backup_ssh_key` (ed25519, root 600), `backup_known_hosts` | On the backup server only as `restrict,command="rrsync <dir>"` for a dedicated user (no shell, no forwarding, rsync inside one directory; `rrsync -no-del` for append-only). Host key accepted once (`accept-new`), its fingerprint shown in the UI to be compared |
| Cloud credentials (S3) | database `backup_config.secrets` (AES-256-GCM, HKDF key from APP_SECRET, AAD `backup:<name>`), rendered by the root agent into `/etc/ets/rclone.conf` (root 600) | Write-only in the API («محفوظ»), never returned or logged; the file is removed when the cloud copy is off. Give the key rights on one bucket / prefix only |
| A restore key typed in the wizard | HTTPS request → `/var/lib/ets/inbox/<random>.sec` (0600) encrypted with a one-time key held only in the job row → the agent's tmpfs `/run/ets-backup-agent` (root 700) | Read and deleted at once, the one-time key wiped from the row, deleted after the restore or after 15 minutes; never in the database or a log |

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

## 6b. Backups and restore from the web UI / النسخ الاحتياطي والاسترجاع (1.12.0)

- **Privilege separation.** The API (user `ets`, `NoNewPrivileges`, read-only system) never runs anything as root. It
  stores the desired backup configuration and queues jobs of seven whitelisted kinds; the root **backup agent**
  (`ets-backup-agent.service`) validates both again with the same strict patterns (users, hosts, paths, remotes,
  endpoints, buckets: whitelisted characters, no `..`, NAS only under `/mnt`, `/media`, `/srv`), writes only a fixed
  list of files, and starts commands with argument arrays (no shell). Someone able to write the database can at
  most choose another valid destination or start a whitelisted job — not run a command or write elsewhere.
  `ets-backend` may additionally write only `/var/lib/ets/inbox` and `/var/lib/ets/upload`.
- **Who.** Only system administrators (role `admin` with `cfg`); the API refuses everyone else (403), the section is
  not shown to them. Changing destinations or credentials, creating the SSH key and setting a passphrase ask for the
  password and the 2FA code again (the profile page's re-authentication, counted towards the account lockout).
- **Restore = three factors every time**: password, 2FA code (or recovery code), and the backup key / passphrase.
  The key is checked by decrypting (a wrong key fails before anything is changed); **3 wrong keys in 15 minutes pause
  restores for 15 minutes**; restore requests are rate-limited (10 per 15 minutes per administrator), job requests
  too (20 per 10 minutes); one restore at a time (database-level unique open job + `flock`); a confirmation phrase
  (the server name or «استرجاع»); every administrator is notified when a restore starts and ends (S11, in-app and
  phone).
- **Uploads** for a restore: administrators only, artifact names only, size limit (`ETS_UPLOAD_MAX_MB`), streamed
  to `/var/lib/ets/upload/<random>/` (0600, deleted after 24 h); the file stays encrypted until the agent decrypts it
  with the typed key. Archive members are checked before extraction (no absolute paths, no `..`, no links outside
  `/etc/letsencrypt`).
- **Integrity.** Every artifact has a SHA-256 checksum (checked before use) and gpg's MDC; the configuration
  bundle's manifest lists each file's SHA-256 (checked after decryption); the database is restored in one
  transaction, then `verify-audit` checks the hash chains, and a failure after the data was replaced rolls back to
  the safety backup automatically. Every session ends after a database or APP_SECRET restore.
- **What is visible without a session.** Only `/api/restore-status.json` (nginx, `X-ETS-Status: 1`) during a restore:
  steps, percentage, counters and times — no names of people, no keys, no data. The `.meta` files next to the
  backups (also on the destinations) are not secret: kind, time, key id, version, host name, APP_SECRET fingerprint
  (an HMAC of a constant), table / row totals.
- **Audit.** Every change of the backup settings (old → new; secrets as «(changed — not shown)»), every job
  request, upload, inspection, restore start and restore (who, which backup, source, items, verify result) is in
  the change history with readable sentences.

## 7. Recommendations for the customer

1. Use a certificate from the organisation's CA or Let's Encrypt instead of the self-signed one.
2. Set the 2FA policy to **Required** after users have been trained. Exempt only service or emergency
   accounts.
3. Keep two administrator accounts, both with 2FA.
4. Escrow the backup key `/etc/ets/backup.key` off the server (password manager **and** sealed envelope), **not**
   together with the backup files, and confirm it in Settings → «النسخ الاحتياطي» (08 §6). `ets.env` is inside the
   encrypted configuration bundles since 1.12.0; an escrowed copy is still useful. Configure at least one offsite
   destination; prefer an append-only one (rrsync `-no-del`, object lock) against ransomware.
5. Review the *Login & security* log weekly (failed attempts, lockouts, access denied), run *Logs → Verify log
   integrity* and keep the chain heads it shows somewhere off the server. Forward the journal (`"alert":true`
   events) to a central syslog / SIEM. Check `sudo ets-log-protect status` after updates and restores; with a
   remote database, have the DBA protect the log tables (see 07-Logging-and-Audit.md §3).
6. Apply Ubuntu security updates monthly (`sudo apt update && sudo apt upgrade`) and enable
   `unattended-upgrades`. Apply ETS updates (with their dependency fixes) with `deploy/scripts/update.sh`.
7. Restrict SSH to key-based login and to administrator IPs.
