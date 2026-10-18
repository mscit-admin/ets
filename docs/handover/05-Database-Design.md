# 05 — Database Design

**DBMS:** PostgreSQL 14+ · **Database:** `ets` · **Application role / database owner:** `ets` ·
**Log owner role:** `ets_log_owner` (no login, owns the log tables — §3a) · **Extension:** `citext`
**Creation script:** `deploy/db/create-database.sql` · **Schema source:** `backend/src/db/migrations/*.sql`
(001–009, 012 and 013; the numbers 010 and 011 are not used) · **Full DDL for review:** `deploy/db/schema-reference.sql`
(after migration 013)

## 1. How the schema is managed

- Every structural change is a new numbered file in `backend/src/db/migrations/` (`001_init.sql`,
  `002_…sql`, …). Applied files are never edited.
- `node src/db/migrate.js` applies pending files in order. Each file runs in its own transaction and is
  recorded in `schema_migrations` (and in `system_log`, event `migration`). The service also runs pending
  migrations at start-up.
- On a server with a local database, `install.sh` and `update.sh` apply the migrations **before** the service
  starts, through `ets-log-protect migrate` (as the PostgreSQL superuser, all pending files in one transaction
  in which the migration SQL runs as the application role), and then protect the log tables again (§3a). This is
  what lets a later migration change `audit_log` / `auth_log` although the application role does not own them.
- Database privileges: only the application role may connect (`REVOKE ALL ON DATABASE … FROM PUBLIC`), and
  `PUBLIC` may not create objects in schema `public`.
- `node src/db/seed.js` is idempotent. It creates the roles and default settings, and inserts the catalog
  rows that are missing. It refreshes descriptive fields but **never overwrites progress data**.

## 2. Entity relationships

```
roles 1───* users 1───* sessions
              │ 1───* user_recovery_codes
              │ 1───* user_permissions   (grant/revoke overrides)
              │ 1───* user_scopes        (department / application)
departments 1───* applications 1───* functions
                               1───1 app_reports
schedule (single row)          settings (key/value)
auth_log, audit_log, access_log, error_log, system_log  ──*───1 users (nullable)
```

## 3. Tables

### Identity & access
| Table | Purpose | Key columns |
|---|---|---|
| `roles` | The nine roles | `id` (admin, pm, tm, mgr, lead, member, ed, qa, obs), `name_ar/en`, `full_scope` (true only for admin, pm, tm), `permissions text[]` |
| `users` | Accounts | `username citext unique`, `password_hash` (bcrypt, re-hashed at sign-in when the cost changes), `role_id`, `language`, `is_active`, `must_change_password`, `totp_secret` (AES-256-GCM, format `v2:<key id>:…` with a key derived from `APP_SECRET`; older `v1` values are still read), `totp_enabled`, `totp_exempt`, `totp_last_step` (a code is accepted once), `failed_attempts`, `locked_until` (end of the current sign-in pause), `last_failed_at` (migration 008: the counter restarts after `LOCKOUT_RESET_MINUTES` without failures), `last_login_at/ip` |
| `user_recovery_codes` | One-time 2FA backup codes | `code_hash` (`h1:` + HMAC-SHA-256, migration 008; older plain SHA-256 codes stay valid until used or regenerated), `used_at` |
| `user_permissions` | Per-user override of a role permission | `(user_id, permission)`, `granted bool`. `usr` may be granted to the admin role only (migration 009 removed other grants, each recorded in the audit trail) |
| `user_scopes` | Data scope | `(user_id, kind, ref_id)`, kind = `department` or `application`. Full scope comes from `roles.full_scope` only: a user of another role with **no rows sees nothing** (fail closed; migration 009 lists such users in `system_log`, event `scope_fail_closed`) |
| `sessions` | Server-side sessions | `id` = SHA-256 of the cookie token, `mfa_passed`, `mfa_stage`, `expires_at`, `last_seen_at`, `revoked_at`, `revoke_reason` |
| `settings` | System settings | `key`, `value jsonb`, `updated_by` |

### Tracker
| Table | Purpose | Key columns |
|---|---|---|
| `departments` | 4 departments | `id` (hr, fin, com, inf), names AR/EN, `color`, `emblem`, `is_base` (no reports track) |
| `applications` | 30 applications | `id` (per, pay, acc…), `department_id`, names, `default_weight`, `weight`, `note_ar`, `addendum`, `scope_cut`, `extra_module` |
| `functions` | 513+ functions | `app_id`, `code` (unique per app; added ones `C<n>`), `source`, `name_ar`, `reference`, `vendor_status`, `weight`, `progress`, `enabled`, `test_status`, `notif_status`, `review_status`, `note`, `updated_by/at`, `created_by/at`, `removed_at/by`, `removed_reason` (migration 006: a removed function is kept, `enabled=false`, and excluded from every calculation, list, export and import), `disabled_reason` (`duplicate`, `out_of_scope`, `not_required`, `other`, or `import` set by an import; NULL = excluded before 1.5.0), `disabled_note` (≤ 500), `disabled_by/at` — why an excluded function (`enabled=false`) does not count, cleared when it is included again (migration 013) |
| `function_duplicates` | For a function excluded as a duplicate: the functions it duplicates (any application) | `function_id`, `duplicate_of_id` (PK on both; FKs to `functions` ON DELETE CASCADE — functions are only soft-removed; `CHECK function_id <> duplicate_of_id`; index on `duplicate_of_id`) — migration 013 |
| `app_reports` | Reports track per application | `progress`, `status`, `note` |
| `schedule` | Project schedule (one row, `id = 1`) | `start_date`, `end_date` (planned close, migration 005; when set, `periods` is derived from start → close), `periods`, `unit` (month/fortnight), `plan numeric[]`, `actual numeric[]` |

### Imports & approvals (migration 002)
| Table | Purpose | Key columns |
|---|---|---|
| `import_batches` | One uploaded file for one choice | `target` (`department` / `reports`), `department_id`, `departments text[]`, `status` (`pending`, `applied`, `rejected`, `superseded`, `no_changes`), `summary` (counts and % before/after), `uploaded_by/at`, `lead_by/at/note`, `final_by/at/note`, `rejected_by/at`, `reject_reason`, `apply_result` |
| `import_changes` | One changed value | `kind` (`function`, `report`, `weight`), `app_id`, `function_id`, `code`, `field`, `old_value`, `new_value` (jsonb), `applied` |

### Progress snapshots (migration 005)
| Table | Purpose | Key columns |
|---|---|---|
| `progress_snapshots` | Whole-project progress, one row per day (refreshed hourly by the API; latest value of the day wins) | `day` (PK), `total_pct`, `fn_pct`, `functions`, `done`, `tested_ok`, `notes`, `departments jsonb` (`{dept id: pct}`), `taken_at` |

### Edit requests (migration 004)
| Table | Purpose | Key columns |
|---|---|---|
| `edit_requests` | One edit by a data-entry user waiting for the team lead | `department_id`, `app_id`, `kind` (`function`, `bulk`, `report`), `status` (`pending`, `applied`, `rejected`, `superseded`, `withdrawn`), `requested_by/at`, `decided_by/at`, `reason`, `apply_result` |
| `edit_request_items` | One changed value | `kind`, `app_id`, `function_id`, `field`, `old_value`, `new_value` (jsonb), `applied`, `meta` (jsonb, migration 013: the reason of a pending exclusion — `disabled_reason`, `disabled_note`, `duplicate_of: [{id, app_id, code}]` — applied on approval) |

### Branding (migration 003)
| Table | Purpose | Key columns |
|---|---|---|
| `branding_assets` | Uploaded images | `key` (`logo`, `favicon`, `login_bg`), `mime`, `data bytea`, `updated_at`, `updated_by` |

### Logs (details in [07-Logging-and-Audit.md](07-Logging-and-Audit.md))
`auth_log`, `audit_log`, `access_log`, `error_log`, `system_log`. All have `ts timestamptz` indexed
descending. `audit_log.context jsonb` (migration 007) holds how a change came in (direct, edit request,
import), who asked and approved, and the items of a bulk change.

### 3a. Audit-trail integrity (migration 012)
| Object | Purpose |
|---|---|
| `audit_log`, `auth_log`: `chain_seq bigint` (unique), `prev_hash`, `row_hash` | Hash chain: `row_hash` = SHA-256(`prev_hash` + `|` + canonical row text); `chain_seq` 1, 2, 3 … in writing order. Set by the database on insert (also `ts := now()`); `user_id` is not hashed (it becomes NULL when a user is deleted), the username is |
| `log_chain_head` | One row per chained table: `tbl`, `last_seq`, `last_hash`. Its row lock serialises writers of that table |
| `log_chain_anchor` | One row per retention purge: `tbl`, `next_seq` and `prev_hash` where the remaining chain starts, `deleted`, `cutoff`, `actor`, `ts` (append-only too) |
| `ets_audit_row_text(audit_log)`, `ets_auth_row_text(auth_log)`, `ets_chain_hash(text, text)` | Canonical row content and hash |
| Trigger `ets_chain` → `ets_log_chain_insert()` | BEFORE INSERT: next link of the chain (SECURITY DEFINER) |
| Triggers `ets_append_only`, `ets_no_truncate` → `ets_log_append_only()` / `ets_anchor_append_only()` | Refuse UPDATE, DELETE, TRUNCATE; allowed only: `user_id → NULL` of a deleted user, and DELETE inside the purge function of rows older than 365 days (audit) / 30 days (auth) |
| `ets_purge_log(tbl, days, actor)` | The only way to remove log rows: oldest rows first (a prefix of the chain), never younger than the floors above, records an anchor; SECURITY DEFINER |

**Ownership.** On a local database `ets-log-protect` (`deploy/db/harden-log-tables.sql`) gives the four tables,
the seven functions and schema `public` to `ets_log_owner` (NOLOGIN). The application role `ets` has `SELECT`,
`INSERT` on `audit_log` / `auth_log`, `SELECT` on `log_chain_head` / `log_chain_anchor` and the log sequences,
`EXECUTE` on `ets_purge_log`, and `USAGE, CREATE` on schema `public`; it owns every other table. Remote database:
the DBA applies the same script ([07 §3](07-Logging-and-Audit.md)). Check: `sudo ets-log-protect status`.

## 4. Code values

| Column | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `functions.vendor_status` (vendor's claim) | — | Operational | Works with a note | In progress |
| `functions.test_status` (project team) | Not tested | Passed with note | Passed | Failed |
| `functions.notif_status` | Not set | Working | Working with notes | Not working |
| `functions.review_status` | Not needed | Present | Missing | Present with notes |
| `app_reports.status` | Not needed | Delivered | Missing | With notes |

`functions.source`: `design` (approved detailed design), `vendor_list` (vendor's function list),
`experience` (gap added from experience, disabled by default), `custom` (added in ETS; codes `C0…`).

`functions.code`: `D0…` for design items followed by vendor-list items; `X0…` for experience items. These are
the same keys as the original tracker page, which is what makes import possible.

## 5. Default settings

| Key | Default |
|---|---|
| `mfa.mode` | `"optional"` (`off` / `optional` / `required`) |
| `mfa.issuer` | `"ETS"` |
| `calc.weight_mode` | `"fixed"` (`fixed` / `auto`) |
| `calc.notif_share` | `0.10` |
| `calc.reports_share` | `0.15` |
| `security.password_min_length` | `10` (allowed 10–64; administrators always need at least 12) |
| `logs.retention_days` | `365` — sign-in, error and system logs (allowed 30–3650; the sign-in log never purges rows younger than 30 days) |
| `logs.audit_retention_days` | `365` — change history (`audit_log`), allowed 365–10950; migration 012 kept a longer previous period |
| `logs.access_retention_days` | `90` (allowed 7–3650) |
| `app.org_name_ar` / `app.org_name_en` | System names |
| `app.default_language` | `"ar"` — login screen / new browsers and new users without a chosen language |

## 6. Useful queries

```sql
-- progress per application (functions only, enabled items)
SELECT a.id, a.name_en, round(sum(f.weight*f.progress)/nullif(sum(f.weight),0),1) AS pct
FROM applications a JOIN functions f ON f.app_id=a.id AND f.enabled GROUP BY a.id, a.name_en ORDER BY pct;

-- who changed what today
SELECT ts, username, action, entity, entity_id, summary FROM audit_log WHERE ts::date = current_date ORDER BY ts DESC;

-- accounts whose sign-in is paused now
SELECT username, failed_attempts, locked_until FROM users WHERE locked_until > now();

-- failed logins in the last 24h by user / IP
SELECT username, host(ip), count(*) FROM auth_log WHERE NOT success AND ts > now()-interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC;
```

Do not change log rows by hand: the database refuses it, and the hash chain would report it. Verify the chains
with `node scripts/verify-audit.js` (see [07 §3](07-Logging-and-Audit.md)).
