# STRUCTURE — هيكل المشروع

Map of the repository: what each folder and file is for. Update this file whenever a file is added,
moved or removed (and record the change in [HISTORY.md](HISTORY.md)).

```
ets/
├── README.md                      Overview and quick start
├── HISTORY.md                     History of all changes and fixes (changelog)
├── STRUCTURE.md                   This file
├── .gitignore
│
├── reference/
│   └── erp-tracker-original.html  The original single-file tracker (source of the catalog and legacy data)
│
├── tools/
│   └── extract-catalog.js         Regenerates backend/src/db/seed/catalog.json from the original page
│
├── backend/                       REST API — Node.js 22, Express 5, PostgreSQL
│   ├── package.json               Scripts: start, dev, migrate, seed, setup, create-admin, import-legacy, purge-logs, verify-audit, test
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
│   │   │   │   └── 012_audit_integrity.sql  Append-only, hash-chained audit_log / auth_log; separate audit retention
│   │   │   └── seed/
│   │   │       └── catalog.json   4 departments, 30 applications, 513 functions
│   │   ├── middleware/
│   │   │   ├── auth.js            Session cookie → req.user, requireAuth, permissions, data scope helpers
│   │   │   └── common.js          Access logging, CSRF guard, 404 and error handlers
│   │   ├── routes/
│   │   │   ├── auth.js            /api/auth — login, 2FA verify/setup/enable/disable, recovery codes, me, logout, password, language
│   │   │   ├── tracker.js         /api/tracker — summary, departments, applications, functions, bulk, weights, reports, schedule, search, export/import
│   │   │   ├── users.js           /api/users — list, create, edit, scopes, overrides, reset password/2FA, unlock, sessions, bulk 2FA
│   │   │   ├── settings.js        /api/settings — read/update system settings (2FA policy, calculation, retention…)
│   │   │   ├── logs.js            /api/logs — auth/audit/access/error/system logs, filters, stats, CSV export
│   │   │   ├── imports.js         /api/imports — team result files: preview, submit (department or reports), approve, reject
│   │   │   ├── approvals.js       /api/approvals — data-entry edit requests: list, approve, reject, withdraw
│   │   │   ├── branding.js        /api/branding — logo / favicon / login background (public GET, admin upload/reset)
│   │   │   └── system.js          /api/health (public) and /api/system/info
│   │   ├── services/
│   │   │   ├── audit.js           Audit helpers: names of people / items, one before → after row per applied change
│   │   │   ├── calc.js            Progress calculation (function → application → department → project), S-curve
│   │   │   ├── totp.js            TOTP/HOTP (RFC 6238/4226), base32, otpauth URI
│   │   │   ├── crypto.js          AES-256-GCM for 2FA secrets, SHA-256, random tokens
│   │   │   ├── passwords.js       bcrypt hashing, password policy, recovery code generation
│   │   │   ├── logs.js            Writes every log type to the DB and to files (pino)
│   │   │   ├── settings.js        Cached settings + validation rules
│   │   │   ├── retention.js       Log retention purge (audit trail ≥ 365 days, recorded, chain anchors)
│   │   │   ├── logchain.js        Verification of the audit_log / auth_log hash chains
│   │   │   ├── legacy.js          Import/export in the original page's format
│   │   │   ├── edits.js           Who needs approval, create / apply edit requests
│   │   │   ├── snapshots.js       Daily progress snapshots (hourly) for trend, pace and forecast
│   │   │   ├── functions.js       Add / remove (soft) / restore functions
│   │   │   └── imports.js         Diff of one department / reports vs approved data, impact, apply after approval
│   │   └── utils/http.js          HttpError and input validation helpers
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
│       │   ├── branding.jsx       Logo, favicon and login background (uploaded or default)
│       │   ├── health.js          Project health indicators and recommendations (status page)
│       │   └── format.js          Number and colour helpers
│       ├── components/
│       │   ├── Layout.jsx         Navbar (search, language, user menu) + sidebar
│       │   ├── ErrorBoundary.jsx  Message instead of a blank page if a screen fails
│       │   ├── Icon.jsx           SVG icon set
│       │   ├── SCurve.jsx         S-curve model, chart and KPI cards (dashboard + curve page)
│       │   └── ui.jsx             Indicator, ProgressBar, Ring, Card, NumberCard, Modal, Field, Toast, useLoad…
│       ├── pages/
│       │   ├── Login.jsx          Login, 2FA verify/enrol, recovery codes, password forms
│       │   ├── ProjectStatus.jsx  Project health: schedule variance, delay, pace, forecast, departments, recommendations
│       │   ├── Dashboard.jsx      Workspace: totals, S-curve card, departments, lowest apps, test distribution
│       │   ├── Department.jsx     Applications of one department
│       │   ├── Application.jsx    Functions list with inline editing, bulk set, add requirement
│       │   ├── Weights.jsx        Application weights and calculation parameters
│       │   ├── Reports.jsx        Reports track
│       │   ├── Schedule.jsx       S-curve, planned vs actual, SPI
│       │   ├── Search.jsx         Search results
│       │   ├── Users.jsx          Users list, bulk 2FA, user form (role, permissions, scope, actions)
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
│   │   ├── harden-log-tables.sql  Optional: log tables owned by a separate role (app role may only read / append)
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
│       ├── update.sh              Upgrade an installed system (code and deployment files)
│       └── deploy-lib.sh          Functions shared by install.sh and update.sh
│
└── docs/handover/                 Documents handed over to the customer (see 00-Handover-Index.md)
```

## Server layout after installation

| Path | Content |
|---|---|
| `/opt/ets/` | Application code (backend, built frontend in `frontend/dist`, deploy, docs) |
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
