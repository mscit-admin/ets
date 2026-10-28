# 07 — Logging & Audit

ETS records five kinds of logs. Each is stored **in the database**, where you can search and export it from
*Administration → Logs*. The application, error and request logs are also written **to files** in
`/var/log/ets/`, and the service's console output goes to the systemd journal.

| Log | DB table | File | Content |
|---|---|---|---|
| Login & security | `auth_log` | `app.log` | Every login, logout, 2FA event, lockout, password change, permission refusal |
| Audit trail | `audit_log` | `app.log` | Every data change with **old and new values** |
| Requests | `access_log` | `access.log` | Every API request: method, path, status, duration, user, IP |
| Errors | `error_log` | `error.log` | Unexpected server errors with stack trace and request |
| System | `system_log` | `app.log` | Start-up, shutdown, migrations, seeding, imports, backups, restores, retention purge |

Other logs on the server: `/var/log/nginx/ets.access.log`, `/var/log/nginx/ets.error.log`,
`/var/log/ets-backup.log` (root-only) and `journalctl -u ets-backend`.

**Who can read what (owner decision, 1.0.0).** The login & security, request, error and system logs, the
statistics cards and the integrity check are for **system administrators only** (role *admin*). Other roles
with the *log* permission (project / technical managers, department managers and team leads) see only the
**audit trail**, limited to their scope, and **without IP addresses or user agents** — the API removes them
(also from `context`, e.g. `approver_ip`) before answering, in the screen and in the CSV export alike.

Anonymous `/api` requests answered 404 or 429 are written to `access.log` only, not to `access_log`: nobody can
fill the table without signing in.

## 1. Login & security events (`auth_log.event`)

| Event | Meaning |
|---|---|
| `login` | Successful login (after 2FA when required) |
| `password_ok_mfa_pending` | Password accepted, waiting for 2FA (`detail.stage` = verify / enroll) |
| `login_bad_password` / `login_unknown_user` / `login_inactive_user` | Failed login and the real reason (for an unknown user the typed name is masked, see below) |
| `login_ambiguous_email` | Sign-in by an e-mail address that several accounts share (possible only while the unique e-mail index is missing, [05 §3b](05-Database-Design.md)); `username` holds the address, no `user_id` |
| *(every login row, 1.6.0)* | `detail.via` = `username` or `email` — which name was typed — and, for a known account, `detail.identifier` = the name as typed, trimmed and in lower case; `user_id` / `username` are the resolved account. For an unknown name only `detail.via` is stored next to the masked name |
| `login_while_locked` | Attempt on a paused account |
| `account_locked` | Account paused after too many failures |
| `rate_limited` | Too many attempts from one IP / for one account. Only the **first** refusal of a 15-minute window is written, then one row at 1 000, 10 000 … refusals (`detail.refused_in_window`) |
| `mfa_verify_while_locked` / `reauth_while_locked` | 2FA code, or the password asked again on the profile page, sent while the account is paused |
| `session_expired` | A session ended by inactivity or its maximum age (`detail.reason` = idle / absolute) |
| `session_revoked_reuse` | A request still carried the cookie of an ended session (`detail.revoke_reason`) |
| `logout` | User logged out; `detail.reason = "idle"` when the web app signed out by itself after `SESSION_IDLE_MINUTES` without input (1.12.2, `revoke_reason = 'idle_timeout'`) |
| `mfa_verified` / `mfa_bad_code` / `mfa_code_replay` | 2FA code accepted / wrong / reused |
| `mfa_recovery_code_used` / `mfa_bad_recovery_code` | Recovery code accepted / wrong |
| `mfa_setup_started` / `mfa_enabled` / `mfa_enrolled_at_login` / `mfa_enable_bad_code` | Enrolment |
| `mfa_disabled_by_user` / `mfa_disable_bad_password` | User switched 2FA off |
| `mfa_recovery_codes_regenerated` | New recovery codes issued |
| `mfa_reset_by_admin` / `mfa_exempted_by_admin` / `mfa_exemption_removed` / `mfa_policy_changed` | Admin 2FA actions |
| `password_changed` / `password_change_bad_current` / `password_reset_by_admin` | Passwords |
| `password_change_rejected` | New password refused (`detail.reason` = weak_password with the rules, or password_reused) |
| `account_unlocked_by_admin` / `sessions_revoked_by_admin` | Admin account actions |
| `admin_created_cli` / `mfa_reset_cli` | `create-admin` run on the server (`detail.by` = `cli:<OS user>`); `mfa_policy_changed` with `detail.cli` for `set-setting mfa.mode` |
| `access_denied` | Request refused for lack of permission or scope (`detail` has the path and permission) |
| `csrf_rejected` | State-changing request without the application's header (a forged cross-site request) |
| `password_change_required` | Request refused because the user must first change the password |

Fields: time, user id, username, event, success, IP, browser (user agent, first 300 characters), detail (JSON).

**Unknown usernames are masked.** A name typed at sign-in that is not an account may be a password typed into
the wrong field, so it is never stored as typed (database, files, journal, export). It is stored as
`?` + its first character (only when it looks like a username) + `***#` + 12 hex characters of an HMAC of the
lower-cased name (key derived from `APP_SECRET`), e.g. `?g***#5f2c0e9a71b3`: repeated attempts with the same name
share the same value, so they can still be grouped. Names of real accounts are stored as they are.

**Brute-force / enumeration alerts (periodic check, admins only).** The notification scan (`notify_scan`, every 15 min)
raises two complementary security alerts from these rows: **S2 `failed_logins`** — too many failed sign-ins in 15
minutes **per source IP** and, separately, **all addresses together**, over `notify.failed_logins_threshold` (any
failure type); and **S13 `distributed_logins`** (1.12.23) — the **TOTAL `login_unknown_user` across ALL source IPs**
in `notify.distributed_login_window_min` (default 15 min) over `notify.distributed_login_threshold` (default 20). S13
catches **distributed account enumeration** spread thin over many IPs (a few attempts each, no single IP tripping S2's
per-IP check); its alert names the total count and the number of distinct IPs. Both are admin-only and in-app only
(ETS-SEC-047), critical, and fire at most once per window. Thresholds are editable in Settings → «الإشعارات» → العتبات.

**Account unlocked by an administrator (1.12.29).** When an administrator lifts the sign-in pause on an account
(`POST /users/:id/unlock`), the action always writes the audit row (`unlock`) and the auth event
(`account_unlocked_by_admin`, `detail.by` = the admin's username). In addition, **only when the account was actually
paused at the time** (a no-op unlock of an already-open account is silent), two event notifications are raised: **S14
`account_unlocked`** to administrators (the counterpart of S1 `account_locked` — admin-only, in-app only, info; the
body names the account and the administrator, the title carries neither per ETS-SEC-047), and **S15
`account_reactivated`** — a directed FYI to the unlocked user themselves (scope `self`, every role eligible, info,
phone allowed) telling them they can sign in again.

## 2. Audit trail (`audit_log`)

Every change made through the API is recorded **in the same transaction as the change itself** (or, for an
export, before any data is sent), so a change cannot exist without its audit row: if the row cannot be written,
the request fails with a server error and nothing is changed. The same holds for the security events of a
change (password change, 2FA on/off, recovery codes, unlock, session revocation, 2FA exemptions, 2FA policy) in
`auth_log`, and a sign-in only creates a session after its `login` row is written. Events that must not change
what a request does — failed sign-ins, refusals, logout, reads — are still written, but a failed write there is
counted (*Logs → statistics: «Events not saved to the database»*) and reported in `error.log` with `"alert":true`.

| Field | Example |
|---|---|
| `action` | `create`, `update`, `delete`, `bulk_create`, `bulk_update`, `reset`, `import`, `export`, `reset_password`, `reset_2fa`, `unlock`, `revoke_sessions`, `view`, `verify`, `purge`, `purge_skipped`, `purge_acknowledge`, `restore` |
| `entity` / `entity_id` | `function` / `125`, `application` / `pay`, `report` / `pay`, `user` / `7`, `setting` / `mfa.mode`, `schedule` / `1`, `tracker`, `log`, `database` |
| `summary` | `per/D0 الوظائف والدرجة الوظيفية…` |
| `old_value` / `new_value` | `{"progress": 40}` → `{"progress": 60}` |
| `context` | how the change came in and the items involved (below) |
| `username`, `ip`, `ts` | who, from where, when |

An import stores the complete previous state in `old_value`, so an import can be reviewed or reversed.

Also in the audit trail: an administrator **opening a user record** (`view` / `user`) or a security log (`view` /
`log`, at most once per reader and log every 15 minutes); each **retention purge** (`purge` / `log`, by `system`
or `cli:<OS user>`, with the rows deleted per table; `purge_skipped` when a broken chain stopped it and
`purge_acknowledge` when an administrator acknowledged the break); a **database restore** (`restore` / `database`); an
**integrity check** from the Logs screen (`verify` / `log`); and changes made with the command-line scripts
`set-setting` and `create-admin`, in the name of `cli:<operating-system user>`.

**Who a change is attributed to.** A direct edit is recorded in the name of the person who made it. An edit a
data-entry user sent for approval (edit request) or a team results file (import) is recorded, once applied, in
the name of the **employee who entered it**, one `update` row per function / report / application weight with
its own before → after values; the approvers are in `context` (`via: "edit_request"` with `request_id`,
`requested_by`, `approved_by`; or `via: "import"` with `batch_id`, `filename`, `approved_by`, `final_by`).
Such a row carries the **employee's own IP** (where the request / file was sent from), not the approver's; the
approver's IP is in `context.approver_ip` (administrators only).
The request itself (`edit_request`), its approval / rejection / withdrawal and every step of an import batch
also carry `context.items`: each item with function code and name, field, old and new value, and whether it
was applied. A bulk set (`bulk_update`) lists every function whose value changed with its previous value.

**Reading it in the Logs screen.** Logs → «سجل التعديلات» shows each row as a plain sentence in the user's
language, e.g. «تعديل نسبة الإنجاز للوظيفة «D0 …» في تطبيق المبيعات: من 70% إلى 75%», with the person's full
name, a coloured action type, how the change came in («أدخله أحمد، واعتمده خالد (طلب تعديل رقم 13)») and the
reason of a rejection or removal. Clicking a row opens a table **field — previous value — new value** and, for
requests, bulk sets and imports, the list of items affected; the raw record is under «التفاصيل التقنية».
Statuses, percentages, yes/no and settings are shown by name, not as codes. The search box also matches the
person's full name and function codes / names.

## 3. Integrity of the audit trail (`audit_log`, `auth_log`)

**Append-only.** Rows of `audit_log` and `auth_log` cannot be changed or deleted, and the tables cannot be
emptied (`TRUNCATE`): database triggers refuse it, for the application and for anyone connecting with its
database role. The only exceptions are the retention purge (oldest rows first, never rows younger than
365 days for the audit trail and 30 days for the sign-in log, whatever the setting says) and the
`user_id → NULL` the database applies when a user row is deleted. The time of a row is always the database time.

**Hash chain.** Every row stores `chain_seq` (1, 2, 3 … in writing order), `prev_hash` and `row_hash` =
SHA-256(`prev_hash` + the row's content, user name included). The database computes them on insert. Changing,
removing or inserting a row anywhere breaks the chain. Each purge leaves a row in `log_chain_anchor` (where the
remaining chain starts, how many rows were deleted, who ran it), so a purged start is not reported as a break.

**Checking it.**
- *Logs → «Verify log integrity»* (administrators), or `GET /api/logs/integrity`;
- on the server: `cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets node scripts/verify-audit.js` (exit code 0 = intact,
  2 = broken; add `--json` for details). Break kinds: `hash_mismatch` (row changed), `link_broken` (row replaced
  or inserted), `gap` (rows deleted in the middle), `start` (first rows deleted without a purge), `tail` (last
  rows deleted), `unchained` (rows written with the triggers disabled);
- the daily purge verifies both chains first; a break is written to `system_log` (`log_chain_broken`) and to
  `error.log` with `"alert":true`, and **the purge then deletes nothing** (otherwise the broken old rows would be
  removed and the chain would verify clean again): it records `purge_skipped` / `log` in the audit trail and
  `log_purge_skipped` in `system_log`, both with `"alert":true` and the broken tables, and repeats this every day
  until the break is dealt with (see *Retention* below for the acknowledgement). A successful purge also writes the **chain heads** (last `chain_seq` + `row_hash`) to the
  journal and `app.log` (`log_purge`, `detail.chain_heads`). Keep a copy of a head outside the server from time
  to time (ticket, e-mail): a head that is no longer in the chain shows a chain rebuilt end to end.

**Protection in the database (applied automatically for a local database).** The log tables, their chain
functions and schema `public` belong to a role without login, `ets_log_owner`. The application's database role
keeps only `SELECT` + `INSERT` on `audit_log` / `auth_log`, `SELECT` on `log_chain_head` / `log_chain_anchor`
and their sequences, and `EXECUTE` on the purge function; it still owns (and creates) every other table. So even
someone who can run SQL as the application role (for example after taking over the server account and reading
`ets.env`) cannot `UPDATE`, `DELETE`, `TRUNCATE`, drop or disable the triggers, drop the tables or the schema,
or replace the chain functions — the database answers *permission denied* / *must be owner*.

- **Local database (installer default):** `deploy/install.sh` and `deploy/scripts/update.sh` apply it on every
  install and update, as the PostgreSQL superuser, through `/usr/local/sbin/ets-log-protect`
  (`deploy/scripts/log-protect.sh`, which runs `deploy/db/harden-log-tables.sql`). It is idempotent.
- **Migrations and restores keep working.** Work that needs the owner's rights is done by `ets-log-protect` in
  **one superuser transaction**: the log objects are lent to the application role, the migrations (or the
  `pg_restore` script) run *as the application role* (`SET ROLE`), and the protection is applied again before
  `COMMIT`. Other sessions never see the tables unprotected; any error rolls everything back. `update.sh` stops
  the service, runs `ets-log-protect migrate`, then starts the new version; `ets-restore` uses
  `ets-log-protect restore` automatically when it can reach the superuser.
- **Check it:** `sudo ets-log-protect status` (exit 0 = protected, 3 = not protected). Re-apply:
  `sudo ets-log-protect apply`.
- **Database on another server:** the installer cannot assume superuser rights there. It applies the
  migrations as the application role and prints whether the log tables are protected. Ask the DBA to protect
  them once, as a superuser — either from the ETS server:

  ```bash
  sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full sslrootcert=/etc/ets/db-ca.crt' ets-log-protect apply
  ```

  or with psql from anywhere (`deploy/db/harden-log-tables.sql` from the release):

  ```bash
  psql -v ON_ERROR_STOP=1 -v db_user=ets -v log_owner=ets_log_owner -d ets -f harden-log-tables.sql
  ```

  Fail-safe behaviour afterwards: a migration that would change the log tables fails as the application role
  **without changing anything** (each migration is all-or-nothing); `update.sh` stops with the command for the
  DBA (`ETS_SU_CONNINFO=… ets-log-protect migrate`). `ets-restore` on a protected remote database refuses
  before stopping anything unless `ETS_SU_CONNINFO` is given. Until the DBA has done it, the hash chain still
  detects changes (`npm run verify-audit`), but a full rewrite is only visible against an outside copy of the head.
- **What remains:** the PostgreSQL superuser (and root on a local database server) can still change anything,
  and the owner of the database can drop the whole database (not silent). Keep backups and chain heads off the
  server, and forward the journal to a SIEM.
- **To undo** (not recommended): as `postgres`, `ALTER TABLE audit_log OWNER TO ets;` (same for `auth_log`,
  `log_chain_head`, `log_chain_anchor`, the `ets_*` functions) and `ALTER SCHEMA public OWNER TO ets;` — the next
  update applies the protection again.

**Restore.** `ets-restore` replaces the audit trail with the backup's copy (the safety backup it takes first
keeps the rows written since), protects it again, and records the restore in the restored audit trail
(`restore` / `database`).

## 4. File format

The files are JSON lines (one JSON object per line), for example:

```json
{"level":30,"time":1791841069093,"app":"ets","kind":"auth","event":"login","success":true,"userId":1,"username":"admin","ip":"10.0.0.21","msg":"auth"}
```

You can read them with `tail -f /var/log/ets/app.log | jq .`, or ship them to a central log system (syslog,
ELK, Graylog, Wazuh).

**Alerts.** ETS sends no mail itself. Events worth a look straight away are written at level *warn* or *error*
with `"alert":true`, so a forwarder or SIEM rule can pick them out (`journalctl -u ets-backend -p warning`, or
`jq 'select(.alert)' /var/log/ets/app.log`): `account_locked`, `mfa_policy_changed`, `mfa_exempted_by_admin`,
`mfa_reset_by_admin`, `password_reset_by_admin`, `sessions_revoked_by_admin`, `csrf_rejected`,
`admin_created_cli`, `mfa_reset_cli`, a **shorter log retention** (`log retention reduced`), a **failed log
write** and a **broken hash chain**. Forwarding the journal off the server (e.g. `rsyslog` → central syslog / SIEM)
also keeps a copy the server account cannot change; this is recommended, and is an organisational decision.

## 5. Retention

| What | Kept (default) | Where to change |
|---|---|---|
| audit trail `audit_log` (DB) | 365 days — **at least 365** (owner decision) | Settings → «Keep the audit trail (change history) for» |
| sign-in, error, system logs (DB) | 365 days (30 at least) | Settings → «Keep login, error and system logs for» |
| access log (DB) | 90 days (7 at least) | Settings → «Keep request log for» |
| Files in `/var/log/ets` | 90 rotations (daily, compressed) | `/etc/logrotate.d/ets` |
| systemd journal | journald's limits (size-based by default) | `/etc/systemd/journald.conf` (`MaxRetentionSec=`, `SystemMaxUse=`) |
| nginx logs (full URLs with search terms, client IPs) | the distribution's logrotate (usually 14–52 weeks) | `/etc/logrotate.d/nginx` |
| Expired sessions | 30 days after expiry | fixed |

On an upgrade to 1.0.0 the audit trail keeps the period set before when it was longer than 365 days.
The purge runs daily (and with `npm run purge-logs`, recorded as `cli:<OS user>`). Each run is recorded in the
**audit trail** (`purge` / `log`: who, the retention used and the rows deleted per table), in `system_log`
(`log_purge`) and, for the two chained tables, in `log_chain_anchor`. The database refuses to purge audit rows
younger than 365 days or sign-in rows younger than 30 days even if the settings were changed directly.

**A broken chain stops the purge.** When `audit_log` or `auth_log` does not verify, no table is purged (not even
the plain logs or expired sessions): the daily run records `purge_skipped` (see §3) and `npm run purge-logs`
exits with status 2. After investigating the break as a security incident (keep `verify-audit.js --json` and the
chain heads first — [10](10-Operations-Runbook.md)), an administrator lets the purge continue once with:

`cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets node scripts/purge-logs.js --acknowledge-broken-chain`

This first records `purge_acknowledge` / `log` in the audit trail (who — `cli:<OS user>` — and the broken tables
with their first breaks; kept at least 365 days) and `log_chain_break_acknowledged` in `system_log`, then purges;
the purge's own row carries `chains_intact_before: false` and `break_acknowledged: true`. Breaks in rows younger
than the retention stay visible afterwards; only rows older than the retention are removed.

**Personal data.** IP addresses, user agents, usernames and activity of staff are personal data. Besides the
database they are in the files under `/var/log/ets`, the journal, nginx logs and backups, each with its own
retention (table above): align these with the organisation's data-protection rules. Deactivated users are kept
(with e-mail, last sign-in IP and history) so that the audit trail stays readable; when a departed user's data
must be removed, rename the account in *Users* (e.g. `former-user-17`) and clear the e-mail and full name — the
audit rows keep the old username as recorded (they are append-only).

## 6. Export

*Logs → Export CSV* exports the current tab and filter, up to 100,000 rows. The file is UTF-8 with a BOM, so
Arabic opens correctly in Excel. Each export is itself recorded in the audit trail **before** the file is sent
(no row, no file). Non-administrators can export only the audit trail, without IP addresses.
Since 1.3.0 every export also needs the `exp` permission, and *Logs → Export to Excel* gives the same rows as an
`.xlsx` file (`GET /api/export/log.xlsx?type=…`). The Excel exports of the other screens are recorded the same way
(`action = export`, `entity` = the report key); see *06-Security.md → 4a. Export policy*.

The Logs screen also offers a consolidated **item-changes** export (`GET /api/export/function_changes.xlsx`,
filters `dept`, `app`, `from`, `to`): every change made to function / report items across all departments and
applications, one row per field-change. It is the union of the three channels through which a change reaches the
database — a direct edit (`audit_log`, `entity='function'`), an approved edit request (`edit_request_items`,
`applied`) and an applied import (`import_changes`, `applied`) — which never overlap, so nothing is double-counted.
It obeys the same scope as the audit-trail export: a reader sees only their applications' changes.
