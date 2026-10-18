# STRUCTURE — هيكل المشروع

Map of the repository: what each folder and file is for. Update this file whenever a file is added,
moved or removed (and record the change in [HISTORY.md](HISTORY.md)).

```
ets/
├── README.md                      Overview and quick start
├── HISTORY.md                     History of all changes and fixes (changelog)
├── STRUCTURE.md                   This file
├── .gitignore
├── .github/dependabot.yml         Weekly npm (backend, frontend) and GitHub Actions update proposals (7-day cooldown)
│
├── reference/
│   └── erp-tracker-original.html  The original single-file tracker (source of the catalog and legacy data)
│
├── tools/
│   └── extract-catalog.js         Regenerates backend/src/db/seed/catalog.json from the original page
│
├── backend/                       REST API — Node.js 22.12+ / 24+, Express 5, PostgreSQL
│   ├── package.json               Scripts: start, dev, migrate, seed, setup, create-admin, import-legacy, purge-logs, verify-audit,
│   │                              rotate-app-secret, test; engines node ^22.12.0 || >=24
│   ├── .npmrc                     engine-strict=true (refuses an unsupported Node.js)
│   ├── .env.example               All configuration variables, documented (copy to .env / /etc/ets/ets.env)
│   ├── src/
│   │   ├── server.js              Entry point: migrate + seed, start HTTP server, schedule log purge, graceful shutdown
│   │   ├── app.js                 Express app: security headers, JSON, sessions, access log, CSRF, routes, static UI
│   │   ├── config.js              Reads environment variables into one config object
│   │   ├── db/
│   │   │   ├── pool.js            PostgreSQL connection pool + transaction helper
│   │   │   ├── migrate.js         Applies migrations/*.sql in order (tracked in schema_migrations)
│   │   │   ├── seed.js            Roles, default settings, catalog, report rows, schedule row (idempotent)
│   │   │   ├── migrations/
│   │   │   │   ├── 001_init.sql   Complete initial schema (identity, tracker, logs)
│   │   │   │   ├── 002_import_approvals.sql  Import batches / changes, project roles and approval permissions
│   │   │   │   ├── 003_branding.sql  Uploaded logo, favicon and login background
│   │   │   │   ├── 004_edit_requests.sql  Data-entry edits waiting for the team lead
│   │   │   │   ├── 005_project_timeline.sql  Project close date, daily progress snapshots
│   │   │   │   ├── 006_function_lifecycle.sql  Removed / created markers on functions; new request kinds
│   │   │   │   ├── 007_audit_context.sql  Audit row context: via request / import, approvers, items before → after
│   │   │   │   ├── 008_auth_lockout.sql  users.last_failed_at (sign-in pause that expires); recovery-code hash format
│   │   │   │   ├── 009_usr_admin_only.sql  Removes `usr` overrides from non-admins (audited); lists users without scope
│   │   │   │   └── 012_audit_integrity.sql  Append-only, hash-chained audit_log / auth_log; separate audit retention
│   │   │   │                      (010 and 011 are not used)
│   │   │   └── seed/
│   │   │       └── catalog.json   4 departments, 30 applications, 513 functions
│   │   ├── middleware/
│   │   │   ├── auth.js            Session cookie (__Host-ets_sid) → req.user, requireAuth, permissions (usr admin-only),
│   │   │   │                      data scope helpers (fail closed)
│   │   │   ├── body.js            JSON body parsing: 100 kB / 32 levels before auth, 5 MB uploads after auth, bidi stripping
│   │   │   ├── ratelimit.js       Per-IP and per-account limits on password / 2FA checks; general /api limit
│   │   │   └── common.js          Access logging, CSRF guard, 404 and error handlers
│   │   ├── routes/
│   │   │   ├── auth.js            /api/auth — login, 2FA verify/setup/enable/disable, recovery codes, me, logout, password, language
│   │   │   ├── tracker.js         /api/tracker — summary, departments, applications, functions, bulk, weights, reports, schedule, search, export/import
│   │   │   ├── users.js           /api/users — list, create, edit, scopes, overrides, reset password/2FA, unlock, sessions, bulk 2FA, bulk import
│   │   │   ├── settings.js        /api/settings — read/update system settings (2FA policy, calculation, retention…)
│   │   │   ├── logs.js            /api/logs — auth/audit/access/error/system logs, filters, stats, CSV export (log + exp)
│   │   │   ├── imports.js         /api/imports — team result files: preview, submit (department or reports), approve, reject
│   │   │   ├── approvals.js       /api/approvals — data-entry edit requests: list, approve, reject, withdraw
│   │   │   ├── export.js          /api/export/<report>.xlsx — Excel exports of the screens (exp, scope, strict audit)
│   │   │   ├── events.js          /api/events — live updates (Server-Sent Events): auth, per-user cap, heartbeat
│   │   │   ├── branding.js        /api/branding — logo / favicon / login background (public GET, admin upload/reset)
│   │   │   └── system.js          /api/health (public) and /api/system/info
│   │   ├── services/
│   │   │   ├── audit.js           Audit helpers: names of people / items, one before → after row per applied change
│   │   │   ├── calc.js            Progress calculation (function → application → department → project), S-curve
│   │   │   ├── totp.js            TOTP/HOTP (RFC 6238/4226), base32, otpauth URI
│   │   │   ├── crypto.js          AES-256-GCM for 2FA secrets, SHA-256, random tokens
│   │   │   ├── passwords.js       bcrypt hashing (cost 10–14, re-hash), password policy (10 / 12 for admins, 72 bytes,
│   │   │   │                      common-password list), recovery codes (xxxx-xxxx-xxxx, HMAC), temporary passwords
│   │   │   │                      and parallel hashing for the bulk user import
│   │   │   ├── hash-worker.js     Worker thread: bcrypt hashing for hashManyPasswords (bulk user import)
│   │   │   ├── lockout.js         Progressive sign-in pause per account (expires, decays), one check at a time
│   │   │   ├── images.js          Removes metadata / trailing bytes from uploaded branding images
│   │   │   ├── logs.js            Writes every log type to the DB and to files (pino)
│   │   │   ├── settings.js        Cached settings + validation rules
│   │   │   ├── retention.js       Log retention purge (audit trail ≥ 365 days, recorded, chain anchors)
│   │   │   ├── logchain.js        Verification of the audit_log / auth_log hash chains
│   │   │   ├── legacy.js          Import/export in the original page's format
│   │   │   ├── edits.js           Who needs approval, create / apply edit requests
│   │   │   ├── xlsx.js            One-sheet Excel workbooks (title, frozen header, %, RTL, no formulas)
│   │   │   ├── export-labels.js   Arabic / English labels of the Excel exports
│   │   │   ├── snapshots.js       Daily progress snapshots (hourly) for trend, pace and forecast
│   │   │   ├── functions.js       Add / remove (soft) / restore functions
│   │   │   ├── live.js            Live updates hub: pg_notify after commit, one LISTEN connection per process (reconnects),
│   │   │   │                      scope-filtered "tracker_changed" events, session re-check on heartbeat / sign-out
│   │   │   └── imports.js         Diff of one department / reports vs approved data, impact, apply after approval
│   │   └── utils/
│   │       ├── http.js            HttpError and input validation helpers (ids, dates, own keys, JSON depth)
│   │       ├── csv.js             CSV cells with formula neutralisation
│   │       └── importMatch.js     Bulk user import: ids or Arabic / English names → ids (shared with the frontend)
│   ├── scripts/
│   │   ├── create-admin.js        Create / reset an administrator from the command line
│   │   ├── import-legacy.js       Import the original page's data from the command line
│   │   ├── set-setting.js         Change one system setting (used by the installer)
│   │   ├── purge-logs.js          Apply log retention now
│   │   ├── verify-audit.js        Verify the audit trail hash chains (npm run verify-audit)
│   │   └── rotate-app-secret.js   Re-encrypt 2FA secrets after an APP_SECRET rotation (npm run rotate-app-secret)
│   └── test/
│       ├── totp.test.js           RFC test vectors
│       ├── calc.test.js           Calculation rules
│       ├── config.test.js         APP_SECRET checks, database TLS options, 2FA secret encryption / rotation
│       ├── rotate.test.js         rotate-app-secret script (needs TEST_DATABASE_URL)
│       ├── audit-log.test.js      Audit trail integrity, logging events and privacy (needs TEST_DATABASE_URL)
│       ├── auth-security.test.js  Lockout model, rate limits, session rotation, 2FA step-up (needs TEST_DATABASE_URL)
│       ├── passwords.test.js      Password policy, recovery codes, cookie, general /api limit
│       ├── authz.test.js          usr admin-only, scope fail-closed, approvals, import two-person rule, last admin
│       ├── input.test.js          Request limits, validation, CSV neutralisation, branding image cleaning
│       ├── users-import.test.js   Bulk user import: row checks, limits, all-or-nothing, one-time passwords, audit
│       ├── export.test.js         Excel exports: exp required, scope, users admin-only, audit, valid xlsx, no formulas
│       ├── live.test.js           /api/events: auth, tracker_changed after commit without values, scope, sign-out /
│       │                          expiry close the stream, per-user cap, access log (needs TEST_DATABASE_URL)
│       └── api.test.js            API integration tests (needs TEST_DATABASE_URL)
│
├── frontend/                      Web UI — React 19 + Vite
│   ├── package.json               Scripts: dev, build, preview
│   ├── vite.config.js             Dev server on :5173 with /api proxy to :3000
│   ├── index.html
│   ├── public/favicon.svg
│   └── src/
│       ├── main.jsx               Loads Cairo font, styles, providers
│       ├── App.jsx                Routing: login / forced password change / application screens
│       ├── i18n/
│       │   ├── messages.js        All UI strings in Arabic and English
│       │   └── index.jsx          Language context: t(), nm(), RTL/LTR switch, date formats
│       ├── lib/
│       │   ├── audit.js           Audit row → readable sentence, field / previous / new value lines
│       │   ├── api.js             fetch wrapper (CSRF header, error codes), downloads
│       │   ├── auth.jsx           Current user / session context
│       │   ├── live.js            Live updates: one EventSource per tab, debounced reloads, backoff, 30 s polling fallback
│       │   ├── erpModules.js      ERP module wheel: standard modules and the department → module mapping (edit here)
│       │   ├── branding.jsx       Logo, favicon and login background (uploaded or default)
│       │   ├── health.js          Project health indicators and recommendations (status page)
│       │   ├── userImport.js      Bulk user import: template (exceljs, drop-down lists), .xlsx / .csv reading, error report and password files
│       │   ├── importMatch.js     Import values (ids or names) → ids; identical copy of backend/src/utils/importMatch.js
│       │   └── format.js          Number and colour helpers (pctColor, continuous pctTone / pctGradient)
│       ├── components/
│       │   ├── Layout.jsx         Navbar (search, language, user menu) + sidebar
│       │   ├── ErrorBoundary.jsx  Message instead of a blank page if a screen fails
│       │   ├── ExportButton.jsx   «Export to Excel» button (exp only) with the screen's filters
│       │   ├── ErpWheel.jsx       Dashboard ERP module wheel (inline SVG) and its legend
│       │   ├── LiveBadge.jsx      «تحديث مباشر» / "Live" status badge
│       │   ├── Icon.jsx           SVG icon set
│       │   ├── PctEquation.jsx    Application header: functions % + reports % rings = application % ring
│       │   ├── SCurve.jsx         S-curve model, chart and KPI cards (dashboard + curve page)
│       │   └── ui.jsx             Indicator, ProgressBar, Ring, Card, NumberCard, Modal, Field, Toast, useLoad…
│       ├── pages/
│       │   ├── Login.jsx          Login, 2FA verify/enrol, recovery codes, password forms
│       │   ├── ProjectStatus.jsx  Project health: schedule variance, delay, pace, forecast, departments, recommendations
│       │   ├── Dashboard.jsx      Workspace: ERP module wheel, totals, S-curve card, departments, lowest apps, test distribution
│       │   ├── Department.jsx     Applications of one department
│       │   ├── Application.jsx    Functions list with inline editing, bulk set, add requirement
│       │   ├── Weights.jsx        Application weights and calculation parameters
│       │   ├── Reports.jsx        Reports track
│       │   ├── Schedule.jsx       S-curve, planned vs actual, SPI
│       │   ├── Search.jsx         Search results
│       │   ├── Users.jsx          Users list, bulk 2FA, user form (role, permissions, scope, actions)
│       │   ├── UserImport.jsx     Import users dialog: template, preview with per-row errors, one-time passwords
│       │   ├── Logs.jsx           Log viewer with tabs, filters, detail, CSV
│       │   ├── Settings.jsx       2FA policy, general, security, retention, import/export, system info
│       │   ├── Profile.jsx        My account: language, 2FA, password
│       │   ├── Approvals.jsx      Edit approvals: requests with before/after, approve / reject / withdraw
│       │   └── Imports.jsx        Imports & approvals: list, import window, batch page with signatures
│       └── styles/app.css         ERPNext-style design system (RTL/LTR aware)
│
├── deploy/                        Ubuntu Server deployment
│   ├── install.sh                 Interactive installation wizard (asks address, ports, certificate, DB credentials,
│   │                              admin account, options → summary → installs everything); --dry-run, --answers, --yes
│   ├── answers.example            Answers file template for unattended installation
│   ├── db/
│   │   ├── create-database.sql    Creates the `ets` role and database (password set separately)
│   │   ├── harden-log-tables.sql  Log tables owned by a separate role (app role may only read / append); applied by
│   │   │                          ets-log-protect, or by the DBA for a remote database
│   │   ├── scram-verifier.mjs     SCRAM-SHA-256 verifier for the role password (used by install.sh)
│   │   └── schema-reference.sql   Full schema dump for DBAs (reference only)
│   ├── nginx/                     Templates filled in by install.sh
│   │   ├── ets-https.conf.tpl     HTTPS site on the chosen port
│   │   ├── ets-headers.conf       Security headers (CSP, HSTS, X-Frame-Options…) for every location
│   │   ├── ets-redirect.conf.tpl  HTTP → HTTPS redirect + Let's Encrypt challenge
│   │   └── ets-app.conf.tpl       Shared part: static UI, /api proxy to the internal port, login rate limit
│   ├── systemd/ets-backend.service  Hardened service unit
│   ├── logrotate/ets              Rotation for /var/log/ets/*.log and /var/log/ets-backup.log
│   └── scripts/
│       ├── backup.sh              → /usr/local/bin/ets-backup (daily cron; encrypted dumps)
│       ├── restore.sh             → /usr/local/bin/ets-restore (checks, pre-restore backup, one transaction)
│       ├── log-protect.sh         → /usr/local/sbin/ets-log-protect (audit-trail protection; migrations and
│       │                          restores as the PostgreSQL superuser in one transaction)
│       ├── update.sh              Upgrade an installed system (code, deployment files, migrations, protection)
│       └── deploy-lib.sh          Functions shared by install.sh and update.sh
│
└── docs/handover/                 Documents handed over to the customer (see 00-Handover-Index.md)
```

## Server layout after installation

| Path | Content |
|---|---|
| `/opt/ets/` | Application code (backend, built frontend in `frontend/dist`, deploy files), root-owned; no docs, tests or reference data |
| `/etc/ets/ets.env` | Configuration and secrets (APP_SECRET, DB password) — mode 640 |
| `/etc/ets/install.conf` | Last installer answers (no secrets), defaults for the next run |
| `/var/log/ets-install.log` | Installer output (root only, no passwords) |
| `/etc/nginx/snippets/ets-app.conf` | Shared nginx part generated by the installer |
| `/var/log/ets/` | `app.log`, `error.log`, `access.log` |
| `/var/log/ets-backup.log` | Output of the nightly backup (root only) |
| `/var/backups/ets/` | Daily encrypted database dumps `ets-YYYYmmdd-HHMMSS.dump.gpg` + `.sha256` |
| `/etc/ets/backup.key` | Backup encryption key (root only; escrow it away from the backups) |
| `/etc/nginx/sites-available/ets` | Web server site |
| `/etc/systemd/system/ets-backend.service` | Service (`systemctl status ets-backend`) |
| `/etc/cron.d/ets-backup` | Daily backup at 01:30 |
