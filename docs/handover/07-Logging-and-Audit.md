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

## 1. Login & security events (`auth_log.event`)

| Event | Meaning |
|---|---|
| `login` | Successful login (after 2FA when required) |
| `password_ok_mfa_pending` | Password accepted, waiting for 2FA (`detail.stage` = verify / enroll) |
| `login_bad_password` / `login_unknown_user` / `login_inactive_user` | Failed login and the real reason |
| `login_while_locked` | Attempt on a locked account |
| `account_locked` | Account locked after too many failures |
| `rate_limited` | Too many attempts from one IP |
| `logout` | User logged out |
| `mfa_verified` / `mfa_bad_code` / `mfa_code_replay` | 2FA code accepted / wrong / reused |
| `mfa_recovery_code_used` / `mfa_bad_recovery_code` | Recovery code accepted / wrong |
| `mfa_setup_started` / `mfa_enabled` / `mfa_enrolled_at_login` / `mfa_enable_bad_code` | Enrolment |
| `mfa_disabled_by_user` / `mfa_disable_bad_password` | User switched 2FA off |
| `mfa_recovery_codes_regenerated` | New recovery codes issued |
| `mfa_reset_by_admin` / `mfa_exempted_by_admin` / `mfa_exemption_removed` / `mfa_policy_changed` | Admin 2FA actions |
| `password_changed` / `password_change_bad_current` / `password_reset_by_admin` | Passwords |
| `account_unlocked_by_admin` / `sessions_revoked_by_admin` | Admin account actions |
| `access_denied` | Request refused for lack of permission or scope (`detail` has the path and permission) |

Fields: time, user id, username, event, success, IP, browser (user agent), detail (JSON).

## 2. Audit trail (`audit_log`)

Every change made through the API is recorded **in the same transaction as the change itself**, so a change
cannot exist without its audit row.

| Field | Example |
|---|---|
| `action` | `create`, `update`, `delete`, `bulk_update`, `reset`, `import`, `export`, `reset_password`, `reset_2fa`, `unlock` |
| `entity` / `entity_id` | `function` / `125`, `application` / `pay`, `report` / `pay`, `user` / `7`, `setting` / `mfa.mode`, `schedule` / `1`, `tracker`, `log` |
| `summary` | `per/D0 الوظائف والدرجة الوظيفية…` |
| `old_value` / `new_value` | `{"progress": 40}` → `{"progress": 60}` |
| `context` | how the change came in and the items involved (below) |
| `username`, `ip`, `ts` | who, from where, when |

An import stores the complete previous state in `old_value`, so an import can be reviewed or reversed.

**Who a change is attributed to.** A direct edit is recorded in the name of the person who made it. An edit a
data-entry user sent for approval (edit request) or a team results file (import) is recorded, once applied, in
the name of the **employee who entered it**, one `update` row per function / report / application weight with
its own before → after values; the approvers are in `context` (`via: "edit_request"` with `request_id`,
`requested_by`, `approved_by`; or `via: "import"` with `batch_id`, `filename`, `approved_by`, `final_by`).
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

## 3. File format

The files are JSON lines (one JSON object per line), for example:

```json
{"level":30,"time":1791841069093,"app":"ets","kind":"auth","event":"login","success":true,"userId":1,"username":"admin","ip":"10.0.0.21","msg":"auth"}
```

You can read them with `tail -f /var/log/ets/app.log | jq .`, or ship them to a central log system (syslog,
ELK, Graylog, Wazuh).

## 4. Retention

| What | Kept | Where to change |
|---|---|---|
| auth, audit, error, system logs (DB) | 365 days | Settings → Log retention |
| access log (DB) | 90 days | Settings → Log retention |
| Files in `/var/log/ets` | 90 rotations (daily, compressed) | `/etc/logrotate.d/ets` |
| Expired sessions | 30 days after expiry | fixed |

The purge runs daily and is itself logged (`system_log.event = 'log_purge'`, with counts). To run it now:
`node scripts/purge-logs.js`.

## 5. Export

*Logs → Export CSV* exports the current tab and filter, up to 100,000 rows. The file is UTF-8 with a BOM, so
Arabic opens correctly in Excel. Each export is itself recorded in the audit trail.
