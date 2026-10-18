# HISTORY — سجل التغييرات والإصلاحات

All changes and fixes to ETS are recorded here, newest first.
Every change to the code must add a line under the current version (or start a new version).

Format: `type(area): description` where **type** is one of
`feat` (new feature) · `fix` (bug fix) · `sec` (security) · `perf` · `docs` · `ops` (deployment/infra) · `refactor` · `test`
and **area** is one of `backend`, `frontend`, `db`, `deploy`, `docs`, `tests`.

Database changes always come with a new numbered migration file in `backend/src/db/migrations/`
and must be mentioned here with the migration name.

---

## [1.2.0] — 2026-10-18 — Application progress as an equation of rings

### Features
- feat(frontend): the application page header shows the application % as a **visible weighted equation**
  (owner-approved design "B"): two small input rings — functions % and reports % — whose connectors carry
  «× share = contribution» (e.g. «× 85% = 14.7%», «× 15% = 0.0%»), then «=» and one large result ring with the
  application %. Every number comes from the API (`application.calc` and `settings.reports_share`): reports count
  only when `calc.reportPct != null` and `reports_share > 0` (same rule as `services/calc.js`), the functions
  share is `1 − reports_share`, the result ring shows `calc.pct`. Base (requirements) departments / no reports:
  one connector «× 100%» from the functions ring and the note «قسم متطلبات: التقارير لا تدخل في نسبة التطبيق».
  The formula line (`app_pct_note`) stays, small and muted, beside the pills row (weight, functions, passed in
  green, failed in red). The old horizontal progress bar and stats grid of this header are removed. Phone: the
  equation stacks (inputs, «=», result ring) with no horizontal scroll at 390 px; RTL and LTR
  (`frontend/src/components/PctEquation.jsx`, `frontend/src/pages/Application.jsx`, `frontend/src/styles/app.css`)
- feat(frontend): **continuous criticality colour** for the three rings — `pctTone(v) → {stroke, text, bg}` in
  `frontend/src/lib/format.js`: OKLCH hue interpolated without steps from 25° (red, ≤ 20 %) via 55° (orange, 40 %)
  and 85° (amber, 60 %) to 145° (green, ≥ 80 %), fixed lightness per role (stroke L 0.635, text L 0.47,
  bg L 0.955) and chroma reduced to fit sRGB. Ring strokes ≥ 3:1 on white (non-text contrast), the result number
  uses the darkened `text` tone (≥ 6.4:1 on white, WCAG AA), the input numbers stay in the normal text colour, the
  track uses the pale `bg` tint. `pctHue()` and `pctGradient()` helpers; a small gradient legend under the
  equation (0 % «حرج / Critical» … «متوسط / Fair» … «جيد / Good» 100 %), right-to-left in Arabic. The discrete
  `pctColor()` used elsewhere is unchanged
- feat(frontend): new messages `app_progress`, `eq_no_reports`, `eq_critical`, `eq_fair`, `eq_good` (ar + en)
- feat(frontend): owner request for the application page — the **progress header stays visible** while the
  functions table scrolls: the equation card is `position: sticky` just under the top bar (`--navbar-h`), on a
  page-coloured band so rows never show through; once stuck it gets a shadow and a compact layout (smaller rings,
  legend and formula line hidden, pills kept). The page title, breadcrumb and the «تعيين جماعي» / «إضافة وظيفة»
  buttons scroll away with the page (back at the top). Only on screens ≥ 900 px wide **and** ≥ 700 px high —
  on phones and short windows the page scrolls normally. The compact look switches on only when the page is long
  enough to stay scrolled after shrinking (no flicker on short lists)
- feat(frontend): the **functions table is paginated** — 10 rows per page by default, «صفوف في الصفحة» 5 / 10 / 15
  / 20 / 25 (remembered per browser in `localStorage` `ets.fnPageSize`), first / previous / next / last arrow
  buttons (mirrored in Arabic: «التالي» points left), «صفحة X من Y» and «عرض a–b من N». Pagination applies after
  the filters (search, source, test status, disabled / removed items); any filter change goes back to page 1, the
  «33 / 40» counter is unchanged. Saving a cell, a note or a toggle reloads the data but **keeps the current page**
  (clamped if the list got shorter); changing the page size keeps the first visible row on screen; a page change
  from the bottom pager brings the top of the table back under the sticky header. An empty filter result shows
  «لا توجد وظائف تطابق التصفية». The table has no row-selection / select-all column (the ✓ column is the
  per-function «included in the calculation» toggle with its confirmation) and no column sorting, so nothing else
  changes. Only the application page uses this table (`frontend/src/pages/Application.jsx`,
  `frontend/src/styles/app.css`, new icons `chevron_back`, `chevrons`, `chevrons_back` in
  `frontend/src/components/Icon.jsx`)
- feat(frontend): new messages `rows_per_page`, `showing_range`, `first_page`, `last_page`, `previous_page`,
  `next_page`, `fn_no_matches` (ar + en)
- docs(docs): User Guide (AR) §5 describes the new header, STRUCTURE.md; version 1.2.0

---

## [1.1.1] — 2026-10-16 — Bulk import: dropdown lists and names

### Fixes
- fix(backend): the bulk user import accepts **names as well as ids** — reported on the live server: a template
  filled in Arabic («عضو فريق», «عربي», Arabic department / application names) failed on every row with
  «الدور غير موجود», «لغة غير مدعومة», «نطاق غير صالح». Roles by id, `name_ar` or `name_en`; languages by
  `ar`/`en`, العربية, عربي, Arabic, الإنجليزية, انجليزي, إنجليزي, English; departments by id, name or short name;
  applications by id or name. Matching ignores case, extra spaces, tatweel, diacritics, أ/إ/آ vs ا, ؤ/ئ, ى/ي and
  ة/ه; `,` `،` `;` separate several values, and a name that itself contains a comma is still recognised. An exact
  id wins; a name fitting several items is refused with the new row code `ambiguous_value` (ar + en messages).
  The server stays authoritative; all existing error codes and the all-or-nothing behaviour are unchanged
  (`backend/src/utils/importMatch.js`, same file as `frontend/src/lib/importMatch.js`)
- feat(backend): `POST /api/users/import[/preview]` answers per error row `details: [{code, field, value, matches?}]`
  — the value that was not recognised (the administrator's own text, shortened, and catalog ids only)

### Features
- feat(frontend): the Excel template has **drop-down lists** built from the live roles, departments and
  applications (GET /users/meta): Excel data validation of type *list* on `role`, `language`, `departments`,
  `department_2`, `department_3`, `applications`, `application_2`, `application_3` for rows 2–501, pointing to
  ranges on a hidden `lists` sheet (no 255-character inline-list limit, safe with Arabic and commas); names in the
  interface language («عضو فريق», «العربية», «إدارة الموارد البشرية والخدمات», «شؤون العاملين» / English); an
  input message on every list column and a *warning* (not stop) alert, so several comma-separated values can still
  be typed; frozen header `id / readable name` (e.g. `role / الدور`), column widths, right-to-left sheet in
  Arabic; the `help` sheet is kept. New optional columns `department_2/3`, `application_2/3`; files from 1.1.0
  (ids, seven columns) are read as before
- feat(frontend): the import preview shows what will be created in names (role, language, departments,
  applications) and quotes the unrecognised value in each message, e.g. «الدور غير موجود: مدير قسم»,
  «الإدارة غير موجودة: …»; the error report carries the same messages and the new columns
- ops(frontend): new dependency `exceljs` 4.4.0, used only to write the template and loaded on demand (own chunk,
  not in the main bundle; works under the production CSP — no `eval` / `new Function` on the paths used);
  `overrides.uuid ^11.1.1` for exceljs' `uuid` (GHSA-w5hq-g745-h8pq); `npm audit --omit=dev`: 0 vulnerabilities.
  `read-excel-file` (reading) and `write-excel-file` (error report, passwords file) stay
- test(tests): `users-import.test.js` — roles / languages / departments / applications by Arabic and English
  name with tatweel, hamza, taa-marbuta, diacritic and ؤ/ئ variants, `,` `،` `;` separators and the extra columns;
  unknown values named in `details`; `ambiguous_value` (and its resolution by id or «name (id)»); ids still work;
  the browser and server matching files are identical
- docs(docs): Administrator Guide §1 (drop-down lists, names accepted, several values, matching rules), API
  Reference (`details`, `ambiguous_value`, names), STRUCTURE.md; version 1.1.1

---

## [1.1.0] — 2026-10-15 — Bulk user import

### Features
- feat(backend): bulk user import for System Administrators — `POST /api/users/import/preview` checks every row
  (up to 500) without writing and answers per row `ok` or error codes (`username_taken` case-insensitive,
  `duplicate_in_file`, `invalid_username`, `full_name_required`, `invalid_email`, `invalid_role`,
  `invalid_language`, `invalid_scope`, `scope_required`, `usr_admin_only` …); `POST /api/users/import` checks
  again and creates every row in one transaction or nothing (`400 import_has_errors`, also on a username taken
  meanwhile); more than 500 rows → `400 too_many_rows`
- feat(backend): each imported account gets a random temporary password (`crypto.randomBytes`, 16+ letters and
  digits without look-alikes, passes the password policy incl. 12+ for administrators) and must change it at first
  sign-in; the passwords are returned once in the import answer only — never stored in clear, never logged; the
  bcrypt hashes are computed in short-lived worker threads before the transaction opens
- feat(backend): audit — one `create` / `user` row per imported user (same values as a single create, no
  password, `context.via = "bulk_import"`) and one `bulk_create` / `user` summary row `{count, usernames}`, all in
  the import transaction
- feat(backend): the two import routes accept up to 1 MB of JSON, parsed only after the administrator check
  (`middleware/body.js`); every other request keeps the 100 kB limit
- feat(frontend): Users → «استيراد مستخدمين / Import users»: template download (.xlsx with a «help» sheet listing
  the columns and every role / department / application id in Arabic and English, or .csv), file read in the
  browser (.xlsx via `read-excel-file`, .csv parsed in-house: UTF-8 BOM, quotes, commas and line breaks in quotes,
  CRLF, `;` separator), preview with per-row status and messages, error report (.xlsx / .csv, formula-safe),
  "Create N users" only when no row has an error, result screen with the one-time passwords (copy, download
  .xlsx / .csv, warning before closing without saving them)
- feat(frontend): readable change-history sentences for `bulk_create` and for users created by an import (ar + en)
- ops(deploy): nginx accepts up to 1 MB and waits up to 300 s on `/api/users/import[/preview]` (run
  `update.sh` to re-render the snippet)
- ops(frontend): new dependencies `read-excel-file` 9.3.10 and `write-excel-file` 4.1.1 (loaded on demand, not
  in the main bundle); `npm audit --omit=dev`: 0 vulnerabilities
- test(tests): `backend/test/users-import.test.js` — every row error code, size limits, admin-only, all-or-nothing
  (also on a unique-key failure inside the transaction), passwords returned once / policy / forced change /
  sign-in, audit rows without passwords, no password in any log
- docs(docs): Administrator Guide §1 «Import users from a file», API Reference (two endpoints, 1 MB limit), STRUCTURE.md,
  Logging and Audit (`bulk_create`); version 1.1.0

---

## [1.0.0] — 2026-10-15 — Security remediation

### Security
- sec(backend): request bodies are limited to 100 kB and 32 levels of nesting before the session is known; only the
  file uploads (`POST /api/imports`, `/api/imports/preview`, `/api/tracker/import`, `PUT /api/branding/:key`) accept
  up to 5 MB, parsed only after login, CSRF and permission checks; non-JSON bodies get `415`; imported files are
  also refused when nested too deeply (ETS-SEC-008)
- sec(deploy): nginx `client_max_body_size` 128k, 6m only on the upload routes (ETS-SEC-008)
- sec(backend): allow-lists (settings, report/function fields, log types, `set-setting.js`) use own keys only, so
  `toString`, `constructor`, `__proto__` … are refused with 400 instead of creating rows or failing (ETS-SEC-028)
- sec(frontend): icon lookup uses own keys only (ETS-SEC-028)
- sec(backend): ids (int4), dates (real calendar days), log page/user/status filters, scope/override/id lists,
  `PUT /tracker/weights` without a body and malformed tracker import payloads give 400 instead of 500 and no longer
  fill the error log (ETS-SEC-029)
- sec(backend): CSV export neutralises formulas also after leading whitespace/invisible characters, for `|` and
  the full-width `＝ ＋ － ＠`, and cells starting with tab/CR/LF (ETS-SEC-059)
- sec(frontend): API paths are built with encoded segments, address-bar ids are checked before calling the API,
  and pages show "not found" instead of crashing on an unexpected response (ETS-SEC-060)
- sec(backend): bidirectional control characters (U+202A–202E, U+2066–2069, U+200E/200F) are removed from every
  text value of a request body except passwords (ETS-SEC-061)
- sec(tools): `extract-catalog.js` only runs the catalog block of the reviewed reference file (pinned SHA-256,
  `--trust-source` to override) and runs it in an empty `vm` context with a timeout (ETS-SEC-062)
- sec(backend): branding uploads are stored without metadata (EXIF/GPS, XMP, comments, PNG text chunks, WebP
  EXIF/XMP) and without bytes after the end of the image; broken images are refused (ETS-SEC-070)
- test(tests): `backend/test/input.test.js` covers the above
- sec(backend): user management (`usr`) is for the System Administrator role only — a `usr` override on any other
  role is ignored and refused by the API (`usr_admin_only`); all `/api/users` routes need the admin role. Nobody can
  widen their own permissions, scope or 2FA exemption (`cannot_change_own_permissions`); only administrators
  create/promote administrators, reset an administrator's password/2FA or bulk-exempt 2FA (ETS-SEC-004).
- sec(db): migration `009_usr_admin_only.sql` — removes `usr` overrides held by non-administrators (each removal
  recorded in the audit trail) and lists in the system log (`scope_fail_closed`, warning) the active users of a
  scoped role without any scope (ETS-SEC-004, ETS-SEC-005).
- sec(backend): scope fails closed — full scope comes from the role only (admin, PM, TM); a user of another role
  with no scope rows sees no data anywhere (tracker, export, logs, approvals, imports, `/auth/me` `fullScope:false`)
  (ETS-SEC-005). **Upgrade note for administrators:** such users saw everything before 1.0.0 and now see nothing
  until a department/application is ticked for them in *Users* (shown as «بلا نطاق / No scope»); nothing is
  granted automatically — see 03-Administrator-Guide §1.
- sec(backend): last-administrator protection counts permission overrides (an active admin holding `usr` and `cfg`
  must remain) and locks the administrator rows, so concurrent demotions cannot remove every admin
  (ETS-SEC-023, race part of ETS-SEC-021).
- sec(backend): `GET /api/tracker/export` returns only the applications in the user's scope; the project schedule
  only for full-scope users (ETS-SEC-006).
- sec(backend): application-level scope is no longer treated as department scope — edit-request visibility and
  approval, import preview/upload (only the uploader's applications are compared), import lead/final approval and
  rejection (every changed application must be in scope) and batch details (only in-scope changes and figures)
  (ETS-SEC-007).
- sec(backend): `PUT /api/tracker/schedule` needs a full-scope user (`can.sch` follows) (ETS-SEC-024).
- sec(backend): import two-person rule — the uploader may sign neither approval stage; the final approver also needs
  every changed application in scope (ETS-SEC-025).
- sec(backend): a new import file supersedes only waiting batches nobody has signed yet (own, or entirely within
  the uploader's scope) and never when it has no changes (ETS-SEC-026).
- sec(backend): approving an edit request or the second signature of an import re-checks that the author is still
  active, in scope and holds the needed permissions (409 `requester_not_allowed`; *Approve all* leaves such requests
  pending and reports `blocked_requests`); deactivating a user withdraws their pending edit requests (ETS-SEC-027).
- sec(backend): the "note with a noted status" exception only applies when the status really changes to it (or the
  function has no note), so a user without `tst` cannot overwrite notes (ETS-SEC-056).
- sec(backend): `GET /api/settings` needs full scope; the impact preview ignores functions of other applications
  (ETS-SEC-058).
- sec(frontend): Users screen — *Manage users* cannot be granted to non-administrator roles, own permissions /
  scope / 2FA exemption cannot be widened, warning and «بلا نطاق» badge for users without scope, new error texts in
  Arabic and English (ETS-SEC-004, ETS-SEC-005).
- docs(docs): Administrator guide, Security and API reference updated for the rules above; review notes for imports
  (weights, full import) (ETS-SEC-057).
- test(tests): `backend/test/authz.test.js` — regression tests for P3-AUTHZ-01…10 and ETS-SEC-058.
- sec(db): migration `008_auth_lockout.sql` — `users.last_failed_at` (time of the last failed check, for the
  lockout decay); comment on the recovery-code hash formats. No data is changed.
- sec(backend): a correct password no longer resets the failure counter while 2FA is pending; it is cleared only
  by a complete sign-in, so wrong 2FA codes add up across logins (ETS-SEC-001).
- sec(backend): lockout is now a progressive pause per account (1, 2, 4 … minutes from `MAX_FAILED_LOGINS`,
  at most `LOCK_MINUTES`) that ends by itself; the counter restarts after `LOCKOUT_RESET_MINUTES` (60) without
  failures, so one wrong attempt after a lock no longer locks again for the full time (ETS-SEC-002).
- sec(backend): a paused account answers exactly like a wrong password or an unknown username (`401
  invalid_credentials`, same bcrypt cost); no more `423 account_locked` with the lock time (ETS-SEC-014).
- sec(backend): every endpoint that checks a password, 2FA code or recovery code (login, 2FA verify / setup /
  enable / disable, recovery codes, change password) is limited per IP and per account (`429
  too_many_attempts` with `retry_after`); wrong answers on the profile re-authentication count towards the
  pause and, at the limit, end the session; a general per-IP limit applies to every `/api` request
  (`API_RATE_LIMIT`, `429 too_many_requests`). Concurrent checks on one account run one after another
  (ETS-SEC-003, ETS-SEC-021).
- sec(deploy): nginx login limit covers all those endpoints, in any letter case and with a trailing slash, and
  answers 429 (ETS-SEC-003).
- sec(backend): completing 2FA issues a new session token and revokes the pre-2FA one; signing in again revokes
  the browser's previous session (ETS-SEC-015).
- sec(backend,frontend): turning 2FA on from the profile needs the password; turning it off and generating new
  recovery codes need the password and an authenticator / recovery code (ETS-SEC-016).
- sec(backend): `/auth/me` before 2FA returns only username, language and stage (ETS-SEC-017).
- sec(backend): sessions are revoked on admin 2FA reset, self-service 2FA disable (other sessions) and
  `create-admin` from the command line (ETS-SEC-018).
- sec(backend): password policy — never below 10 characters, 12 for administrators (also in `create-admin`,
  which now uses the Settings minimum), at most 72 bytes, built-in list of common passwords; `BCRYPT_ROUNDS`
  kept within 10–14; hashes with another cost are re-hashed at the next sign-in (ETS-SEC-019, ETS-SEC-020).
  Settings → minimum password length now accepts 10–64.
- sec(backend): TOTP replay check is a conditional update and a recovery code can only be used once, also
  under parallel requests (ETS-SEC-021).
- sec(backend): recovery codes have 12 characters (about 59 bits, no modulo bias) and are stored as
  HMAC-SHA-256 with an HKDF key from `APP_SECRET`; older codes keep working, the profile page suggests
  generating new ones (ETS-SEC-030).
- sec(backend): with `COOKIE_SECURE=true` the session cookie is named `__Host-ets_sid` (everyone signs in again
  once after the upgrade); cookies are cleared with the same options everywhere; a production server refuses
  to start with insecure cookies unless `ALLOW_INSECURE_COOKIES=true` (ETS-SEC-053).
- sec(backend): the forced-password-change gate is an explicit middleware on the allowed endpoints instead of a
  URL prefix test (ETS-SEC-054).
- sec(backend): `/2fa/verify` answers `400 mfa_not_pending` instead of 500 when 2FA was reset meanwhile
  (ETS-SEC-055).
- test(tests): `auth-security.test.js` (lockout, decay, enumeration, rate limits, session rotation, step-up,
  replay races, recovery codes, CLI) and `passwords.test.js` (policy, recovery codes, cookie name, API limiter).

---
### Security — deployment hardening and supply chain (WP5, WP8)
- sec(deploy): backups are encrypted with gpg (AES-256, tamper-evident) using a separate root-only key
  `/etc/ets/backup.key` created by the installer/update, get a `.sha256` checksum, are never overwritten, and no
  longer have `ets.env` (APP_SECRET, DB password) copied next to them; an old `ets.env.backup` is deleted and old
  plain dumps are encrypted at the next run. Key escrow and restore documented in doc 08 (ETS-SEC-009).
- sec(backend,deploy): remote PostgreSQL always over TLS — `PGSSLMODE` / `PGSSLROOTCERT` (libpq semantics:
  require / verify-ca / verify-full) in `config.js` + `db/pool.js` and for psql / pg_dump / pg_restore; default
  `require` for a non-local host and the app refuses to start with an unencrypted remote connection; the
  installer asks for the DB server's CA (→ verify-full) and checks the connection is encrypted; update.sh adds
  `PGSSLMODE=require` to an existing remote install (ETS-SEC-010).
- sec(deploy): plain-HTTP installation mode removed (`ETS_TLS=none` refused, previous plain-HTTP answers fall back
  to self-signed, update.sh refuses a plain-HTTP install with a clear message); `COOKIE_SECURE=true` always;
  `ets-http.conf.tpl` deleted (ETS-SEC-011).
- sec(deploy): self-signed certificate is an end-entity certificate (`basicConstraints=critical,CA:FALSE`,
  keyUsage digitalSignature/keyEncipherment, extendedKeyUsage serverAuth, SAN, RSA-3072, 825 days); an existing
  CA:TRUE certificate is replaced by install/update; docs no longer say to import it as a trusted root (ETS-SEC-012).
- sec(backend): `APP_SECRET` placeholders (e.g. the old `.env.example` value), values under 32 characters or with
  fewer than 12 different characters are refused at start; `.env.example` ships empty secrets (ETS-SEC-031).
- sec(backend): 2FA secret envelope `v2:<key id>:iv:tag:ct` with an HKDF-SHA-256 key, 16-byte GCM tag enforced,
  optional AAD; `v1` still read; `APP_SECRET_OLD` + `npm run rotate-app-secret` (scripts/rotate-app-secret.js)
  rotate the secret without losing 2FA enrolments (ETS-SEC-032, ETS-SEC-063 except AAD binding by callers).
- sec(deploy,db): the DB role password is never on a command line or in the server log: the installer sends a
  SCRAM-SHA-256 verifier (`deploy/db/scram-verifier.mjs`) on stdin; `create-database.sql` no longer takes a
  password (DBAs use `\password`); psql gets `PGPASSWORD` only per call; `create-admin --password` warns that
  it is deprecated (ETS-SEC-033, ETS-SEC-065).
- sec(deploy): answers.example ships no usable passwords (admin `CHANGE-ME` is refused); example / common words
  refused for DB and admin passwords; admin password 12+ characters, max 72 bytes; an admin password taken from
  an answers file / environment variable gets `must_change_password` (`create-admin --must-change-password`)
  (ETS-SEC-034).
- sec(deploy): nginx sends CSP (mirrors helmet), X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS,
  Permissions-Policy, COOP/CORP on the SPA and assets via `snippets/ets-headers.conf`, included in every location
  that has its own `add_header` (fixes the add_header inheritance gap) (ETS-SEC-035).
- sec(deploy): systemd sandboxing extended (CapabilityBoundingSet=, PrivateDevices, ProtectKernelLogs/Clock/
  Hostname, ProtectProc=invisible, RestrictNamespaces/Realtime/AddressFamilies, SystemCallFilter=@system-service,
  SystemCallArchitectures=native, UMask=0027, RemoveIPC, IPAddressAllow=localhost [+ remote DB IP] /
  IPAddressDeny=any); offline `systemd-analyze security` exposure 7.4 → 1.4 (ETS-SEC-036).
- sec(deploy): legacy-import temp copy in a `mktemp -d` directory, mode 640 root:ets, removed afterwards (ETS-SEC-037).
- sec(deploy,backend): `server_tokens off`; public `/api/health` no longer returns the version (ETS-SEC-038).
- sec(deploy): TLS: Mozilla intermediate ECDHE+AEAD ciphers, `ssl_prefer_server_ciphers off`, session tickets off,
  shared session cache 1 d (ETS-SEC-039).
- sec(deploy,db): `REVOKE ALL ON DATABASE … FROM PUBLIC`, `GRANT CONNECT, TEMPORARY` to the app role,
  `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (create-database.sql and every local install run) (ETS-SEC-040).
- sec(deploy): restore.sh verifies checksum + decryption + archive before touching anything, takes a
  pre-restore backup, restores with `--single-transaction --exit-on-error` (extensions left to the DBA), fails
  hard and restarts the service on error, passes the file name to SQL as a psql variable (ETS-SEC-041).
- sec(deploy): only runtime files are copied to /opt/ets (allow-list: backend src/scripts/package files,
  frontend sources for the build, deploy runtime files — no docs, tests, reference data, examples); code root-owned,
  backend `root:ets 750`, only `frontend/dist` world-readable (ETS-SEC-042).
- sec(deploy): nightly backup logs to root-only `/var/log/ets-backup.log` (outside the ets-writable /var/log/ets),
  with its own logrotate entry (ETS-SEC-043).
- sec(deploy): no `curl | bash`: NodeSource apt repo with a fingerprint-pinned signing key and `signed-by`;
  npm ci and the Vite build run as the unprivileged `ets-build` user with `--ignore-scripts`, in a staging copy;
  answers files and install.conf are parsed as KEY=value data, never sourced (nothing exported); PGPASSWORD is
  scoped to individual psql calls (ETS-SEC-044, ETS-SEC-067).
- sec(backend,frontend,deploy): Node.js `engines` `^22.12.0 || >=24` with `engine-strict`; the installer
  upgrades any other version, update.sh refuses one (ETS-SEC-045).
- sec(deploy): `.github/dependabot.yml` (npm backend + frontend, GitHub Actions; weekly, 7-day cooldown);
  `npm audit --omit=dev` runs at every install/update (ETS-SEC-046, ETS-SEC-071).
- sec(deploy): `ets.env.bak-*` are root:root 600, only the 5 newest kept; ets.env written atomically; a warning
  before nginx's default site is disabled (ETS-SEC-064).
- sec(deploy): existing-certificate mode warns when the private key is readable by others (ETS-SEC-066).
- sec(deploy): update.sh re-deploys the systemd unit, nginx site/snippets, logrotate, backup/restore commands and
  cron from install.conf, reads `PORT` from ets.env, and prints rollback instructions on failure (ETS-SEC-068).
- sec(deploy): local PostgreSQL: warning when `listen_addresses` is not local-only or pg_hba has trust/password/md5
  network rules (ETS-SEC-069).
- test(tests): `config.test.js` (APP_SECRET placeholders, DB TLS options per sslmode, remote-without-TLS refused,
  v2 envelope, tag length, AAD, v1 compatibility, rotation) and `rotate.test.js` (rotate-app-secret on a database).
- docs(docs): 02, 06 (new §6a secrets and APP_SECRET rotation), 07, 08 (encrypted backups, key escrow, restore),
  09, 10, README, STRUCTURE updated for the above.

### Security — audit trail, logging and privacy (WP6)
- sec(db): migration `012_audit_integrity.sql` — `audit_log` and `auth_log` are append-only (triggers refuse UPDATE,
  DELETE, TRUNCATE except the retention purge and the user_id → NULL of a deleted user) and hash-chained
  (`chain_seq`, `prev_hash`, `row_hash`, computed by the database; existing rows chained in id order);
  `log_chain_head`, `log_chain_anchor`; purge only through `ets_purge_log()` (oldest rows first, never younger than
  365 / 30 days); new setting `logs.audit_retention_days` (kept at the previous period when longer) (ETS-SEC-013, ETS-SEC-048)
- sec(backend): `npm run verify-audit` and `GET /api/logs/integrity` (admins) verify the chains; the daily purge
  verifies first and writes the chain heads to the journal; `deploy/db/harden-log-tables.sql` (optional, run once by
  the DBA) gives the log tables to a separate owner role so the application role can only read and append (ETS-SEC-013)
- sec(deploy): ets-restore records the restore in the audit trail (ETS-SEC-013)
- sec(backend): audit trail retention is its own setting, at least 365 days; every purge is recorded in the audit
  trail with its actor (`system` / `cli:<OS user>`) and row counts; a shorter retention is flagged (ETS-SEC-048)
- sec(backend): audit rows are strict (a failed write fails the request); unlock, bulk 2FA exemption, branding,
  language, password change, 2FA setup/enable/disable, recovery codes, session revocation, admin resets and the
  2FA policy change write their audit / auth_log rows in the same transaction; tracker and log exports are refused
  without their audit row; a sign-in creates no session without its `login` row; soft writes (failed sign-ins,
  denials, logout, reads) are counted and reported with `alert:true` (ETS-SEC-049)
- sec(backend): new events `password_change_rejected`, `mfa_verify_while_locked`, `reauth_while_locked`,
  `session_expired`, `session_revoked_reuse`, `csrf_rejected`, `password_change_required`, `admin_created_cli`,
  `mfa_reset_cli`; audit rows for viewing a user record / security log, CLI `set-setting` and `create-admin`
  (as `cli:<OS user>`), session revocation (ETS-SEC-050)
- sec(backend): an unknown username (and the name sent with a rate-limited request) is stored masked
  (`?x***#<HMAC>`), never as typed — DB, files, journal, export (ETS-SEC-051)
- sec(backend): changes applied on approval carry the requester's own IP; the approver's IP is in
  `context.approver_ip` (ETS-SEC-052)
- sec(backend): security logs (auth, access, error, system), log statistics and IPs / user agents for
  administrators only; others with `log` get the audit trail with IPs removed server-side, also in CSV (ETS-SEC-047)
- sec(backend): only the first rate-limited sign-in of a window (then every 10^n) is written to auth_log; anonymous
  404 / 429 are not stored in access_log; user agent and paths capped at 300 characters (ETS-SEC-077)
- sec(backend): high-value events are written with `alert:true` for forwarding / SIEM rules (ETS-SEC-075)
- sec(frontend): Logs shows the security tabs and statistics to administrators only, «Verify log integrity»
  button, failed-log-write counter; Settings has the separate audit retention field (min 365); ar + en texts
  (ETS-SEC-047, ETS-SEC-048, ETS-SEC-013)
- test(tests): `audit-log.test.js` (append-only, chain verification and tamper detection, purge floors and anchors,
  injected log-write failures, new events incl. CLI, masking, requester IP, admin-only logs, flood limits);
  `input.test.js` adapted to masked unknown usernames.
- docs(docs): 07 (who sees what, new events, masking, transactional audit, integrity §3, alerts, retention and
  personal data), 06 (authorisation, audit trail, recommendations) (ETS-SEC-013, 047–052, 074, 075, 077).

### Security — audit-trail protection applied automatically (WP6 follow-up)
- sec(deploy): the audit-trail protection (`deploy/db/harden-log-tables.sql`: log tables, chain functions and
  schema `public` owned by the NOLOGIN role `ets_log_owner`; the application role may only read and append) is
  applied automatically on every install and update of a local database, as the PostgreSQL superuser, by the new
  `/usr/local/sbin/ets-log-protect` (`deploy/scripts/log-protect.sh`: `apply`, `migrate`, `restore`, `status`).
  Migrations and restores run as the application role inside one superuser transaction in which the log objects
  are lent to it and protected again before COMMIT, so later migrations that change the log tables and restores
  keep working; `update.sh` stops the service and migrates before starting the new version; `ets-restore` uses it
  automatically and refuses (before changing anything) a protected database it cannot restore. Remote database:
  migrations as the application role (all-or-nothing, clear DBA instructions on failure) and a note telling the
  DBA how to apply the protection (`ETS_SU_CONNINFO=… ets-log-protect apply` or psql). The script is idempotent,
  checks inside its transaction that the application role can no longer change the logs, grants SELECT on the log
  sequences (needed by `ets-backup`), and is a no-op before migration 012. Restores use `--no-acl` (ETS-SEC-013)
- docs(docs): 07 §3 (protection, migrations, restores, remote DBA, undo), 08 §3 (restore of a protected
  database), 06, STRUCTURE (ETS-SEC-013)

### Documentation accuracy (WP7)
- docs(docs): client IP behind a load balancer / reverse proxy / NAT: nginx `real_ip` for the balancer's addresses
  only, in `/etc/nginx/conf.d/ets-realip.conf` (survives updates), never `TRUST_PROXY=true`; the shared-IP effect
  on the rate limits and what to do; in-memory API counters reset on restart (02 §9, 06, 10, 12, `.env.example`;
  a pointer comment in `deploy/nginx/ets-https.conf.tpl`) (ETS-SEC-022)
- docs(docs): consistency pass of the handover pack, README, STRUCTURE, `.env.example` and `answers.example` with
  the 1.0.0 code: sign-in pause model (no "account locked" / 423), rate limits, cookie `__Host-ets_sid`, HTTPS
  only, database TLS, encrypted backups and key escrow, nine roles and 13 permissions, scope fail-closed, `usr`
  for administrators only, import two-person rule, security logs for administrators only, audit retention ≥ 365,
  hash chain and `verify-audit`, audit-trail protection, new settings / env variables (`LOCKOUT_RESET_MINUTES`,
  `API_RATE_LIMIT`, `ALLOW_INSECURE_COOKIES`, `APP_SECRET_OLD`, `PGSSL*`, `TRUST_PROXY`), new npm scripts,
  `/api/health` without version, Node.js 22.12+ / 24+; example passwords removed from the docs (ETS-SEC-076)
- docs(docs): 05 Database Design describes migrations 007–009 and 012 (`last_failed_at`, recovery-code hash
  format, `usr` cleanup, hash-chain columns, `log_chain_head` / `log_chain_anchor`, chain functions and triggers,
  `ets_purge_log`, ownership by `ets_log_owner`, new retention setting); `deploy/db/schema-reference.sql`
  regenerated after migration 012 (ETS-SEC-076)
- docs(docs): 09 Test plan: 90 automated tests; new UAT cases for the sign-in pause, password rules, rate limits,
  cookie, health, 2FA step-up and recovery-code format, `usr` admin-only, self-grant, scope fail-closed,
  application scope, last admin, admin-only logs, integrity check, audit retention, audit-trail protection,
  two-person import rule, restore, update and key escrow (ETS-SEC-076)
- docs(docs): 10 Runbook: security operations (verify-audit, broken chain, ets-log-protect, purge, backup key,
  APP_SECRET rotation, create-admin) and sign-in pauses / unlocking; 12 Checklist: backup key escrow, audit-trail
  protection, user scopes, network path, and the NodeSource key fingerprint that **must be verified against
  NodeSource's published key before the first install**; 04 User guide (AR): https only, sign-in pause message,
  password rules (10 / 12 characters), 2FA changes need password + code, recovery code format `xxxx-xxxx-xxxx`,
  no-scope users, uploader cannot sign (ETS-SEC-076)
- ops(backend, frontend): version 1.0.0 in `package.json` and `package-lock.json`

### Security — Phase 7 verification leftovers (R8)
- sec(users): `POST /users/bulk-2fa` no longer exempts the caller: a list naming the caller is refused with
  `cannot_change_own_permissions`, `all: true` leaves the caller out; removing exemptions is unchanged. UI label
  «Exempt everyone else from 2FA» (ar+en) (ETS-SEC-004, V2-N1)
- sec(config): the DB TLS guard also reads `DATABASE_URL` — its host (`?host=`, empty host → PGHOST, sockets) and
  its `sslmode` / `ssl` parameters (URL wins over PGSSLMODE; `ssl=true` = verify-full); a weaker mode to another
  machine is refused at start, and the pool gets the TLS parameters stripped from the URL and the checked `ssl`
  options instead, so an embedded `sslmode=disable` can no longer win (ETS-SEC-010, V4-N1)
- sec(tracker): without `tst`, a note may accompany a «with notes» status only while the function has no note;
  the two-step overwrite (status away and back with a new note) is refused, and an approved request re-checks
  that the note is still empty (ETS-SEC-056)
- sec(logging): a broken audit/auth hash chain stops the retention purge — nothing is deleted, `purge_skipped`
  (alert) is recorded in the audit trail and system log, `npm run purge-logs` exits 2; an administrator continues
  with `npm run purge-logs -- --acknowledge-broken-chain`, recorded as `purge_acknowledge` with who and which
  tables; docs 07 §3/§5 and 10 (ETS-SEC-013, ETS-SEC-048, V5-O1)
- fix(users): a duplicate permission in `overrides` is a 400 `invalid_permission` instead of a 500 (V2-N4)
- fix(migrations): 009 records the full override list before/after in its audit rows and does not repeat the
  `scope_fail_closed` warning when re-run; already-migrated databases are unaffected (applied by file name) (V2-N6)
- sec(imports, tracker): a reader who sees part of an import batch gets change count, counts, apply result and
  department figures from the visible changes only and no project figure; project-status pending counts include
  only requests / batches of applications in the reader's scope (ETS-SEC-007, V2-N2, V2-N3)
- sec(users): an administrator cannot reset their own password with `POST /users/<self>/reset-password` (400
  `use_change_password`, ar+en message; the button is hidden on their own account) — `/auth/change-password`
  asks for the current password (V2-N5)

- sec(backend): a note written through the "with notes" exception is stored only if the function still has no note when the row is updated (409 `note_changed` otherwise), so a tester's note saved at the same moment cannot be overwritten (V6-N1, ETS-SEC-056); regression test repeats the race 10 times

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
- feat(frontend,backend): Settings → default language now takes effect: it is the language of the login screen
  and interface for a browser with no stored choice (from `GET /api/auth/public-info`; the language button,
  profile and the account's language after sign-in still win), and of new users created without a language
  (`POST /api/users`, the new-user form's «default language» option, and `npm run create-admin` for a new account).
- test(tests): default language applies to `public-info` and to a new user created without a language.

### Fixed
- fix(backend): changes applied from an approved edit request were logged without a username.
- fix(backend): saving weights no longer logs an unchanged application weight.
- fix(frontend): a pending removal / restore of a function no longer shows «removed [object Object]» in the
  function's "awaiting approval" chip; those requests are listed only in the lifecycle box above the table.
- fix(frontend): 21 API error codes had no message and showed the generic error (`csrf_rejected`,
  `not_authenticated`, `mfa_*`, `full_name_required`, `invalid_email` / `_language` / `_permission` / `_role` /
  `_scope` / `_date` / `_json`, `unknown_setting` / `_field` / `_application` / `_log`, `no_reports_track`,
  `payload_too_large`); Arabic and English texts added.
- fix(frontend): the dialog close button's accessible name is translated (was the English word "close").
- docs(deploy): `deploy/db/schema-reference.sql` regenerated after migrations 001–007 (adds `audit_log.context`).

### Security
- sec(backend): the dummy hash checked for unknown usernames at login used bcrypt cost 4 while real hashes use
  `BCRYPT_ROUNDS` (12), so unknown usernames answered faster (username enumeration). It now uses the configured
  cost, built once at startup.

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
