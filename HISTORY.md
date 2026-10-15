# HISTORY — سجل التغييرات والإصلاحات

All changes and fixes to ETS are recorded here, newest first.
Every change to the code must add a line under the current version (or start a new version).

Format: `type(area): description` where **type** is one of
`feat` (new feature) · `fix` (bug fix) · `sec` (security) · `perf` · `docs` · `ops` (deployment/infra) · `refactor` · `test`
and **area** is one of `backend`, `frontend`, `db`, `deploy`, `docs`, `tests`.

Database changes always come with a new numbered migration file in `backend/src/db/migrations/`
and must be mentioned here with the migration name.

---

## [0.9.0] — 2026-10-15 — Readable audit trail: clear sentences with previous and new values

### Added
- feat(db): migration `007_audit_context.sql` — `audit_log.context` (jsonb): how a change came in (direct, edit
  request, import), who requested and who approved it, and the items involved with their before → after values.
- feat(backend): an approved edit request or import now writes one `update` audit row per function / report /
  application weight with its old and new values, in the name of the employee who entered it, with the approvers
  in `context` (before, only "N applied" was recorded and the item history did not show the change).
- feat(backend): edit request, approval, rejection, withdrawal and every import step record their items (code,
  name, field, old → new, applied); a bulk set records each changed function's previous value.
- feat(backend): `GET /api/logs/audit` returns the person's full name, function code / name and application name;
  search also matches them. Department-scoped users also see the edit requests of their applications.
- feat(frontend): Logs → audit trail shows each row as a plain sentence (Arabic / English), e.g.
  «تعديل نسبة الإنجاز للوظيفة «D0 …» في تطبيق المبيعات: من 70% إلى 75%», with action type, the approver and
  request number, and reasons; the details window has a field / previous value / new value table and the list
  of items affected. Statuses, percentages and settings are shown by name.

### Fixed
- fix(backend): changes applied from an approved edit request were logged without a username.
- fix(backend): saving weights no longer logs an unchanged application weight.

### Removed
- refactor(backend): dead code — unused imports (`query` in settings routes, `HttpError` in users routes), unread
  `config.isProd` / `config.appName`, the identity `publicUser` mapper, a redundant `'weight'` in the import field
  allow-list, and `export` on symbols used only in their own module.
- refactor(frontend): dead code — unused `NOTIF_COLORS` / `REVIEW_COLORS`, `chart` / `key` icons, unused props
  (`ProgressBar` `color`, `Icon` `stroke`, `PasswordForm` `onDone`), unused parameters in `paceFrom` and the audit
  `diff`, unread `scheduleModel` fields, 23 unused translation keys, and duplicate / unused CSS rules
  (`.text-green` / `.text-red` → `.green-text` / `.red-text`, `.indicator-pill.yellow`, `--green`).

## [0.8.1] — 2026-10-14 — Functions catalog document

### Added
- docs(docs): `docs/handover/13-Functions-Catalog.xlsx` — all 513 catalog functions by module (department) and
  application (code, name, source, reference, declared vendor status, counted by default) with a summary sheet
  (formulas). Review: the catalog re-extracted from `reference/erp-tracker-original.html` is identical to
  `catalog.json`; no duplicate codes, no empty names, every function linked to a valid application.

## [0.8.0] — 2026-10-14 — Add, remove and restore functions in any application

### Added
- feat(db): migration `006_function_lifecycle.sql` — `functions.removed_at / removed_by / removed_reason /
  created_at / created_by`; edit request kinds `add_function`, `remove_function`, `restore_function`.
- feat(backend): `POST /api/tracker/applications/:id/functions` (name AR/EN, reference, weight, progress,
  included or not), `POST /api/tracker/functions/:id/remove` (reason required, any source incl. scope functions),
  `POST /api/tracker/functions/:id/restore`, and `POST /api/tracker/applications/:id/impact` (application,
  department and project % before → after for a proposed addition / removal / include / exclude).
- feat(backend): additions, removals and restores by data-entry users wait for the department team lead
  (same rule as their other edits); approval creates / removes / restores with the requester as author.
- feat(frontend): «إضافة وظيفة» dialog with live impact; «إزالة» on every function with reason and impact;
  include / exclude (✓) now asks for confirmation with the impact; «عرض المُزالة» lists removed functions with who /
  when / why and «استعادة»; pending additions / removals shown on the application; approvals page shows them.

### Changed
- feat(backend): team members get permission `tog` (include / exclude, add, remove) — all of it through the team
  lead's approval.
- refactor(backend): removal is now a soft removal for every function (the old hard delete of added
  requirements is replaced). Removed functions are excluded from calculations, summaries, project status,
  snapshots, search, the JSON export, full imports and team result files.

### Fixed
- fix(backend): a new added function could get the code of an earlier one after a deletion (codes were
  `C` + count → unique-key error); codes are now `C` + (highest + 1) and never reused.
- fix(backend): adding / deleting requirements bypassed the team lead's approval for data-entry users.

### Tests
- test(tests): add (included / excluded), impact preview, member request → lead approval, remove a scope function
  (reason, exclusion from counts, PATCH refused, seed / export / import do not bring it back), restore,
  code numbering, scope.

## [0.7.0] — 2026-10-13 — Project timeline and project status page

### Added
- feat(db): migration `005_project_timeline.sql` — `schedule.end_date` (planned close date) and table
  `progress_snapshots` (one row per day: project %, functions, completed, tested, notes, % per department).
- feat(backend): `PUT /api/tracker/timeline` (permission `cfg`, full scope) — project start and close date.
  With a close date the number of curve periods is derived from start → close (the last period ends on the close
  date); close before start, a missing start or more than 60 periods are refused. The curve page keeps the
  dates and period count from Settings.
- feat(backend): hourly progress snapshot (`services/snapshots.js`), latest value of the day kept.
- feat(backend): `GET /api/tracker/project-status` — schedule, total and department progress, function states,
  test / notification / review / reports counts, pending approvals and the daily trend, for the user's scope
  (a scoped user's trend is the weighted average of their departments).
- feat(frontend): Settings → «الجدول الزمني للمشروع» card (start, close date, duration and derived periods).
- feat(frontend): new page «حالة المشروع» (sidebar → Tracking): status badge (on track / at risk / delayed /
  past close date / completed), time elapsed vs work done, planned-to-date, deviation, **schedule delay in
  days** (earned schedule), SPI and SPI(t), current and required pace per month, **forecast close date** and its
  variance, forecast by SPI(t), days remaining, S-curve with the daily trend, departments vs plan (gap and
  30-day change), quality & readiness, and automatic recommendations (delay, forecast, required pace, stalled
  progress, lagging departments, functions not started, failed / untested functions, notifications, reviews,
  open notes, pending approvals). Calculations in `lib/health.js`.
- feat(frontend): dashboard curve card shows the project status and its headline, forecast and close date.

### Fixed
- fix(backend): PostgreSQL `date` values are now returned as stored (`YYYY-MM-DD`); before, on a server east
  of UTC the schedule start date could come back one day earlier.
- fix(frontend): two-column and card grids no longer overflow on phones.

### Docs
- docs(db): `deploy/db/schema-reference.sql` regenerated with all migrations (001–005); handover docs updated
  (administrator guide, user guide, database design, API reference, test plan C-13d…f).

### Tests
- test(tests): timeline validation, derived periods (months and fortnights), schedule screen cannot move the
  dates, permissions, snapshot and project-status payload, scoped user.

## [0.6.1] — 2026-10-13 — S-curve verified, redesigned and added to the dashboard

### Fixed
- fix(frontend): the curve did not start at the origin (0 % at the start date); it now does for both planned and
  actual.
- fix(frontend): the current computed progress was not plotted; it now appears as the «اليوم / Today» point at
  the exact position of today's date between periods.
- fix(frontend): deviation and SPI compared the plan with the last manually recorded actual value (and showed «—»
  when none was recorded). They now compare the current computed progress with the plan interpolated at today's
  date: deviation = actual − planned (percentage points), SPI = actual ÷ planned.
- fix(frontend): month periods overflowed on short months (31 Jan + 1 month gave 3 Mar); the day is now clamped
  to the month's length.
- fix(frontend): on phones the top bar (large logo + search) was wider than the screen and the page could be
  shifted sideways; the logo and search now shrink and horizontal overflow is hidden.

### Changed
- feat(frontend): new shared component `components/SCurve.jsx` (model + chart + KPI cards) used by the schedule
  page and the dashboard. Redesign: planned = dashed orange line, actual = solid blue line with a light area,
  period markers, a «today» line with planned-now and actual-now points and the current value labelled, legend
  above the chart, date labels on the time axis, crosshair + tooltip on hover (planned, actual, deviation per
  period), solid hairline gridlines, drawn at the container's real width so text stays readable on phones.
  Colour pair (#2a78d6 / #eb6834) validated for colour-blind separation and contrast.
- feat(frontend): dashboard shows a «منحنى الإنجاز التراكمي» card (4 KPIs + chart) with a link to the curve page.

## [0.6.0] — 2026-10-13 — Data-entry edits approved by the department team lead

### Added
- feat(db): migration `004_edit_requests.sql` — tables `edit_requests`, `edit_request_items`; setting
  `approval.edits_need_lead` (default on).
- feat(backend): when a user who is not an approver of the department (team member, editor, tester…) changes a
  function, runs a bulk set or edits a report, the change is stored as an edit request (HTTP 202 `pending`) and
  the approved value stays unchanged. Only a team lead of that department (`apv_dept`, scope covering it) can
  approve or reject — the project / technical manager is not required at this stage. Team leads, project /
  technical managers and system administrators apply their own edits directly. Editing the same value again
  replaces the earlier pending value. On approval the change is applied with the requester as author; a value
  changed meanwhile by someone else is skipped. Every step is audited (`edit_request`, `edit_approve`,
  `edit_reject`, `edit_withdraw`).
- feat(backend): `/api/approvals` — list (approvers: their departments; everyone: own requests), pending count,
  approve, reject (reason required), withdraw (requester), approve all.
- feat(frontend): «اعتماد التعديلات» page with before/after values per request, approve / reject / withdraw /
  approve all; red badge in the sidebar and a dashboard notice for the team lead; on the application and
  reports pages a «بانتظار الاعتماد» chip shows the proposed value and a notice tells data-entry users their
  edits go for approval; Settings → «الاعتمادات» switch to turn the rule on/off.
- test: API test of the whole cycle (27 tests).

---

## [0.5.2] — 2026-10-13 — Logo inside the login box

### Changed
- feat(frontend): the logo and system name now sit at the top of the sign-in box, above «تسجيل الدخول» and the
  username/password fields, separated by a thin line (also on the 2FA and password-change screens). The logo
  size slider for the login screen still applies.

---

## [0.5.1] — 2026-10-13 — Adjustable logo size

### Added
- feat(frontend/backend): Settings → «الهوية البصرية» — two sliders: logo height in the top bar (20–80 px,
  default 28) and on the login screen (40–200 px, default 64). The change is shown live while dragging and saved
  when released (settings `app.logo_height`, `app.login_logo_height`). The top bar grows with the logo.

### Fixed
- fix(frontend): the logo was forced into a square, so wide logos looked tiny — it now keeps its proportions
  (height set, width automatic).
- fix(frontend): the main Save button of the Settings page no longer overwrites the logo sizes set by the sliders.

---

## [0.5.0] — 2026-10-13 — Branding: system logo, favicon, login background

### Added
- feat(db): migration `003_branding.sql` — table `branding_assets` (images stored in the database, so they are
  included in backups and survive updates).
- feat(backend): `/api/branding/:key` (`logo`, `favicon`, `login_bg`) — public GET with caching; upload (PUT,
  data URL) and reset (DELETE) need the `cfg` permission. Only PNG, JPEG, WebP and ICO are accepted, recognised
  by their content; SVG is refused (it can carry scripts). Limits: logo 1 MB, favicon 512 KB, background 3 MB.
  Uploads and resets are audited. `public-info` and `me` return the branding versions.
- feat(frontend): Settings → «الهوية البصرية» with preview, upload and "restore default" for each image. The
  logo replaces the icon in the top bar and on the login screen; the favicon (or the logo if no favicon) is the
  browser tab icon; the login screen shows the background picture with a dark overlay so the form stays readable.
- test: branding API test (26 tests).

### Fixed
- fix(frontend): error messages with values (e.g. maximum size) now show the value.

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
