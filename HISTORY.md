# HISTORY — سجل التغييرات والإصلاحات

All changes and fixes to ETS are recorded here, newest first.
Every change to the code must add a line under the current version (or start a new version).

Format: `type(area): description` where **type** is one of
`feat` (new feature) · `fix` (bug fix) · `sec` (security) · `perf` · `docs` · `ops` (deployment/infra) · `refactor` · `test`
and **area** is one of `backend`, `frontend`, `db`, `deploy`, `docs`, `tests`.

Database changes always come with a new numbered migration file in `backend/src/db/migrations/`
and must be mentioned here with the migration name.

---

## [0.4.0] — 2026-10-13 — Team result files: per-department import with two approvals; project roles

### Added
- feat(db): migration `002_import_approvals.sql` — tables `import_batches` and `import_changes`; roles
  `pm` (مدير المشروع), `tm` (المدير الفني للمشروع), `lead` (رئيس فريق إدارة), `member` (عضو فريق);
  permissions `apv_dept` (team lead approval) and `apv_final` (project / technical manager approval).
- feat(backend): `/api/imports` — a team's JSON (or HTML) file from the original tracker is read and the
  uploader **must choose** what to import: one department (its functions and application weights) or
  **التقارير** (the reports of the departments in the uploader's scope). Everything else in the file is ignored.
  The differences with the approved data are stored as a pending batch with their effect on the department and
  project percentages; nothing changes in the approved results until the batch is approved by the department
  team lead **and** the project or technical manager — two different people, any order. Then the changes are
  applied in one transaction (a value changed meanwhile is skipped and reported). Either approver can reject
  with a reason. A newer file for the same choice replaces the batch still waiting. Every step is audited.
- feat(frontend): «الاستيراد والاعتماد» page (list, import window with mandatory department/reports choice
  showing the number of changes and the effect of each option, batch page with before/after values per
  function, impact, signatures, approve/reject); red badge in the sidebar with batches awaiting the user's
  signature; notice on the dashboard while batches are pending.
- test: API test of the full cycle (25 tests).

### Changed
- feat(backend): the full import without approval (Settings → Data) now also requires the `cfg` permission and
  is labelled "initial migration only".

---

## [0.3.0] — 2026-10-13 — Mandatory note for "with notes" statuses

### Added
- feat(backend): choosing a "with notes" status — test status *Passed with note* (1), notifications *Working with
  notes* (2), review *Present with notes* (3) — requires a non-empty note. The API refuses with `note_required`
  when the status would be saved without a note, when the note is cleared while such a status is set, and for
  a bulk *Passed with note* while some enabled items have no note. A user allowed to set such a status may
  write its note in the same request.
- feat(frontend): selecting one of these statuses on an item without a note opens the note window first
  ("Note required", with the reason); Save stays disabled until a note is typed; Cancel keeps the previous
  status; "Clear" is disabled while the note is required; items with such a status but no note (older data)
  show a red note icon.
- test: API test for the rule (24 tests).

### Changed
- ops(backend): login/2FA rate limit is configurable (`LOGIN_RATE_LIMIT`, default 30 per 15 min per IP).

---

## [0.2.2] — 2026-10-13 — Fix blank page after creating a user

### Fixed
- fix(frontend): after saving a new user the page `/users/<id>` went blank (`Cannot read properties of null
  (reading 'full_name')`): the form briefly treated the empty "new user" data as the saved user. The form is
  now re-created for each user id. The user was always saved correctly; only the screen failed.

### Added
- feat(frontend): error boundary — if a screen fails to render, a message with "reload" and "dashboard"
  buttons is shown instead of a blank page; it clears when you navigate elsewhere.

---

## [0.2.1] — 2026-10-13 — Reports in the department menus

### Changed
- feat(frontend): sidebar — «التقارير» moved from «المتابعة» to the top of «الإدارات». Each department now has an
  expandable sub-list whose first item is that department's reports, followed by its applications. The
  department of the current page opens automatically.
- feat(frontend): new page `/reports/:dept` showing one department's reports, with a breadcrumb to the department.

### Fixed
- fix(frontend): "%15" shown instead of "15%" in the reports share card in Arabic.

---

## [0.2.0] — 2026-10-12 — Installation wizard

### Added
- ops(deploy): `deploy/install.sh` rewritten as an interactive wizard. It asks for the domain or IP address
  (auto-detected), the certificate type (self-signed / Let's Encrypt / own files / plain HTTP), the HTTPS port,
  the HTTP redirect port, the internal application port, the database location (local or remote) with host,
  port, name, user and password (or a generated one), the administrator username, name, e-mail and password,
  the 2FA policy, the system names, the time zone, the backup retention, an optional data import and the
  firewall. Every answer is validated; passwords are typed twice and never echoed. A summary must be
  confirmed before anything changes.
- ops(deploy): `--dry-run` (writes the would-be config files to `./ets-dry-run/` with secrets masked),
  `--answers FILE` and `--yes` for unattended installs; template `deploy/answers.example`.
- ops(deploy): re-running the wizard keeps the data and `APP_SECRET`, offers the previous answers
  (`/etc/ets/install.conf`) as defaults, backs up `ets.env`, and resets the admin password.
- ops(deploy): nginx split into templates (`deploy/nginx/*.tpl`) for any HTTPS/HTTP/internal port; HTTP
  redirect server with a Let's Encrypt webroot for automatic renewal; plain-HTTP mode.
- ops(deploy): local PostgreSQL on a custom port (cluster port changed with `pg_conftool`); remote
  PostgreSQL with connection and `citext` checks.
- ops(deploy): firewall opens the real SSH port (read from `sshd -T`) plus only the chosen web ports; time zone
  and NTP set; first backup taken; health checks of the service and the web server.
- feat(backend): `scripts/set-setting.js` to change a validated setting from the command line;
  `create-admin.js --email`, password from `ETS_ADMIN_PASSWORD` (never on the command line).
- docs: Installation Guide rewritten for the wizard (all questions, what to prepare, remote DB, re-running,
  troubleshooting).

### Changed
- ops(db): `deploy/db/create-database.sql` takes the database name, user and password as variables
  (`-v db_name= -v db_user= -v db_password=`).
- ops(deploy): `ets-backup` / `ets-restore` read the DB connection from `/etc/ets/ets.env`, so they work with
  any DB name, user, port or remote server.

### Fixed
- fix(deploy): installation stopped at step 8 with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a
  string` — `/etc/ets` was `root:root 750`, so the `ets` user could not read `ets.env` and connected with an empty
  password. The folder is now `root:ets 750`, and the installer checks the file is readable. The app now stops
  with a clear message when its configuration file cannot be read (`ETS_ENV_FILE=none` skips it in tests).
- fix(deploy): nginx refused `http2 on;` on Ubuntu's nginx 1.18/1.24 — now `listen … ssl http2`.
- fix(deploy): nginx failed to start on servers with IPv6 disabled — `[::]` listeners are dropped there.
- fix(backend): in plain-HTTP mode the API's security headers asked browsers to upgrade to HTTPS
  (`upgrade-insecure-requests`) — now only sent with HTTPS; HSTS is sent once, by nginx.

## [0.1.0] — 2026-10-12 — First version (backend + frontend + PostgreSQL)

### Added
- feat(db): migration `001_init.sql` — users, roles, per-user permission overrides and scopes, sessions,
  2FA recovery codes, settings, departments, applications, functions, reports track, schedule, and five log
  tables (`auth_log`, `audit_log`, `access_log`, `error_log`, `system_log`).
- feat(db): catalog extracted from `reference/erp-tracker-original.html` by `tools/extract-catalog.js`:
  4 departments, 30 applications, 513 functions (232 design, 125 vendor-list, 156 experience). Function codes
  (`D0…`, `X0…`) are identical to the original page so its saved data imports without remapping.
- feat(backend): Express 5 REST API — auth, tracker (summary, departments, applications, functions, bulk edit,
  custom requirements, weights, reports, schedule, search, export/import), users, settings, logs, system info.
- feat(backend): progress calculation ported from the original page (notification blending, reports share,
  fixed/auto weights, department and project roll-up), with unit tests.
- feat(backend): import of the original page's data (standalone HTML with `window.__SAVED`, or its JSON
  export) from the UI (Settings → Data) or CLI (`npm run import-legacy`); export in the same format.
- sec(backend): login with username/password (bcrypt), account lockout after N failures, generic error
  messages, equal timing for unknown users, rate limiting on login and 2FA.
- sec(backend): two-factor authentication (TOTP, RFC 6238), compatible with Google/Microsoft Authenticator;
  QR enrolment; 10 one-time recovery codes; replay protection; secrets encrypted with AES-256-GCM.
- sec(backend): 2FA policy `off` / `optional` / `required`; per-user exemption; bulk exempt / un-exempt
  (all users or selected); admin reset of a user's authenticator.
- sec(backend): server-side sessions in PostgreSQL (httpOnly, SameSite=strict cookie, absolute and idle
  timeout, revocation), CSRF header check, helmet security headers and CSP, forced password change.
- feat(backend): five roles (admin, department manager, application editor, tester, observer), 11 permission
  keys, per-user grant/revoke overrides, department/application data scope; last-admin protection.
- feat(backend): logging of every event to the database and to JSON-lines files (`app.log`, `error.log`,
  `access.log`); log viewer API with filters, paging and CSV export; daily retention purge.
- feat(frontend): React UI in the ERPNext visual style — top navbar with search, workspace sidebar, number
  cards, indicator pills, list views and forms; Arabic (RTL) and English (LTR) with per-user language;
  Cairo font bundled locally; responsive down to phone width.
- feat(frontend): screens — login, 2FA verify (code or recovery code), 2FA enrolment, forced password change,
  dashboard, department, application (inline editing of progress, weight, test/notification/review status,
  notes, enable/disable, bulk set, add requirement), weights, reports, S-curve & schedule, search, users &
  permissions, logs, settings, my account.
- ops(deploy): `deploy/install.sh` for Ubuntu 22.04/24.04 (Node 22, PostgreSQL, nginx + HTTPS
  self-signed/certbot/existing, systemd hardened unit, logrotate, daily `pg_dump` backups, ufw),
  `ets-backup`, `ets-restore`, `update.sh`, `create-database.sql`, `schema-reference.sql`.
- docs: README, STRUCTURE, HISTORY and the customer handover pack in `docs/handover/`.
- test(tests): 23 automated tests — TOTP against RFC 6238/4226 vectors, calculation rules, and API
  integration tests (login, lockout, CSRF, 2FA modes, permissions, scope, audit, users, settings, import, logs).

### Fixed (during development, before release)
- fix(backend): file logger crashed on early process exit (`sonic boom is not ready`) — file log streams are
  now synchronous.
- fix(frontend): percentages showed as `%49.2` inside Arabic text — numbers are now bidi-isolated (LTR).
- fix(frontend): application function table overflowed horizontally at 1360 px — status selects narrowed.
- fix(backend): users list returned role ids only — now includes role names in both languages.
