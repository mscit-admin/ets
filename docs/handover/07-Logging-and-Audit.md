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
| `login_while_locked` | Attempt on a paused account |
| `account_locked` | Account paused after too many failures |
| `rate_limited` | Too many attempts from one IP / for one account. Only the **first** refusal of a 15-minute window is written, then one row at 1 000, 10 000 … refusals (`detail.refused_in_window`) |
| `mfa_verify_while_locked` / `reauth_while_locked` | 2FA code, or the password asked again on the profile page, sent while the account is paused |
| `session_expired` | A session ended by inactivity or its maximum age (`detail.reason` = idle / absolute) |
| `session_revoked_reuse` | A request still carried the cookie of an ended session (`detail.revoke_reason`) |
| `logout` | User logged out |
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
| `action` | `create`, `update`, `delete`, `bulk_update`, `reset`, `import`, `export`, `reset_password`, `reset_2fa`, `unlock`, `revoke_sessions`, `view`, `verify`, `purge`, `restore` |
| `entity` / `entity_id` | `function` / `125`, `application` / `pay`, `report` / `pay`, `user` / `7`, `setting` / `mfa.mode`, `schedule` / `1`, `tracker`, `log`, `database` |
| `summary` | `per/D0 الوظائف والدرجة الوظيفية…` |
| `old_value` / `new_value` | `{"progress": 40}` → `{"progress": 60}` |
| `context` | how the change came in and the items involved (below) |
| `username`, `ip`, `ts` | who, from where, when |

An import stores the complete previous state in `old_value`, so an import can be reviewed or reversed.

Also in the audit trail: an administrator **opening a user record** (`view` / `user`) or a security log (`view` /
`log`, at most once per reader and log every 15 minutes); each **retention purge** (`purge` / `log`, by `system`
or `cli:<OS user>`, with the rows deleted per table); a **database restore** (`restore` / `database`); an
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
- on the server: `cd /opt/ets/app/backend && sudo -u ets npm run verify-audit` (exit code 0 = intact,
  2 = broken; `-- --json` for details). Break kinds: `hash_mismatch` (row changed), `link_broken` (row replaced
  or inserted), `gap` (rows deleted in the middle), `start` (first rows deleted without a purge), `tail` (last
  rows deleted), `unchained` (rows written with the triggers disabled);
- the daily purge verifies both chains first; a break is written to `system_log` (`log_chain_broken`) and to
  `error.log` with `"alert":true`. It also writes the **chain heads** (last `chain_seq` + `row_hash`) to the
  journal and `app.log` (`log_purge`, `detail.chain_heads`). Keep a copy of a head outside the server from time
  to time (ticket, e-mail): a head that is no longer in the chain shows a chain rebuilt end to end.

**Residual risk and the optional hardening.** Out of the box the application's database role still owns these
tables, so someone who can run SQL as that role (e.g. after taking over the server account) could drop the
triggers and even recompute the chain; only the comparison with an outside copy of the head would show it.
To take that away, the DBA runs once, as `postgres`, after the first start of 1.0.0:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_user=ets -v log_owner=ets_log_owner -d ets \
     -f /opt/ets/app/deploy/db/harden-log-tables.sql
```

It gives the log tables, their functions and schema `public` to a role without login (`ets_log_owner`); the
application keeps SELECT + INSERT on them and the purge function, and still owns (and migrates) every other
table. Afterwards: a future migration that changes these two tables must be applied by the DBA, and a restore
must run as `postgres` (`PGUSER=postgres ets-restore …`, then run the script again). To undo it:
`ALTER TABLE audit_log OWNER TO ets;` (same for `auth_log`, `log_chain_head`, `log_chain_anchor`, the `ets_*`
functions and `ALTER SCHEMA public OWNER TO ets`).

**Restore.** `ets-restore` replaces the audit trail with the backup's copy (the safety backup it takes first
keeps the rows written since), and records the restore in the restored audit trail (`restore` / `database`).

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
