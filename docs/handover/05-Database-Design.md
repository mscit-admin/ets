# 05 — Database Design

**DBMS:** PostgreSQL 14+ · **Database:** `ets` · **Owner role:** `ets` · **Extension:** `citext`
**Creation script:** `deploy/db/create-database.sql` · **Schema source:** `backend/src/db/migrations/*.sql`
**Full DDL for review:** `deploy/db/schema-reference.sql`

## 1. How the schema is managed

- Every structural change is a new numbered file in `backend/src/db/migrations/` (`001_init.sql`,
  `002_…sql`, …). Applied files are never edited.
- `node src/db/migrate.js` applies pending files in order. Each file runs in its own transaction and is
  recorded in `schema_migrations`. The service also runs pending migrations at start-up.
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
| `roles` | The five roles | `id` (admin, mgr, ed, qa, obs), `name_ar/en`, `full_scope`, `permissions text[]` |
| `users` | Accounts | `username citext unique`, `password_hash` (bcrypt), `role_id`, `language`, `is_active`, `must_change_password`, `totp_secret` (AES-256-GCM encrypted), `totp_enabled`, `totp_exempt`, `totp_last_step`, `failed_attempts`, `locked_until`, `last_login_at/ip` |
| `user_recovery_codes` | One-time 2FA backup codes | `code_hash` (SHA-256), `used_at` |
| `user_permissions` | Per-user override of a role permission | `(user_id, permission)`, `granted bool` |
| `user_scopes` | Data scope | `(user_id, kind, ref_id)`, kind = `department` or `application`. No rows = full scope |
| `sessions` | Server-side sessions | `id` = SHA-256 of the cookie token, `mfa_passed`, `mfa_stage`, `expires_at`, `last_seen_at`, `revoked_at`, `revoke_reason` |
| `settings` | System settings | `key`, `value jsonb`, `updated_by` |

### Tracker
| Table | Purpose | Key columns |
|---|---|---|
| `departments` | 4 departments | `id` (hr, fin, com, inf), names AR/EN, `color`, `emblem`, `is_base` (no reports track) |
| `applications` | 30 applications | `id` (per, pay, acc…), `department_id`, names, `default_weight`, `weight`, `note_ar`, `addendum`, `scope_cut`, `extra_module` |
| `functions` | 513+ functions | `app_id`, `code` (unique per app), `source`, `name_ar`, `reference`, `vendor_status`, `weight`, `progress`, `enabled`, `test_status`, `notif_status`, `review_status`, `note`, `updated_by/at` |
| `app_reports` | Reports track per application | `progress`, `status`, `note` |
| `schedule` | Project schedule (one row, `id = 1`) | `start_date`, `periods`, `unit` (month/fortnight), `plan numeric[]`, `actual numeric[]` |

### Imports & approvals (migration 002)
| Table | Purpose | Key columns |
|---|---|---|
| `import_batches` | One uploaded file for one choice | `target` (`department` / `reports`), `department_id`, `departments text[]`, `status` (`pending`, `applied`, `rejected`, `superseded`, `no_changes`), `summary` (counts and % before/after), `uploaded_by/at`, `lead_by/at/note`, `final_by/at/note`, `rejected_by/at`, `reject_reason`, `apply_result` |
| `import_changes` | One changed value | `kind` (`function`, `report`, `weight`), `app_id`, `function_id`, `code`, `field`, `old_value`, `new_value` (jsonb), `applied` |

### Edit requests (migration 004)
| Table | Purpose | Key columns |
|---|---|---|
| `edit_requests` | One edit by a data-entry user waiting for the team lead | `department_id`, `app_id`, `kind` (`function`, `bulk`, `report`), `status` (`pending`, `applied`, `rejected`, `superseded`, `withdrawn`), `requested_by/at`, `decided_by/at`, `reason`, `apply_result` |
| `edit_request_items` | One changed value | `kind`, `app_id`, `function_id`, `field`, `old_value`, `new_value` (jsonb), `applied` |

### Branding (migration 003)
| Table | Purpose | Key columns |
|---|---|---|
| `branding_assets` | Uploaded images | `key` (`logo`, `favicon`, `login_bg`), `mime`, `data bytea`, `updated_at`, `updated_by` |

### Logs (details in [07-Logging-and-Audit.md](07-Logging-and-Audit.md))
`auth_log`, `audit_log`, `access_log`, `error_log`, `system_log`. All have `ts timestamptz` indexed
descending.

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
| `security.password_min_length` | `10` |
| `logs.retention_days` | `365` |
| `logs.access_retention_days` | `90` |
| `app.org_name_ar` / `app.org_name_en` | System names |
| `app.default_language` | `"ar"` |

## 6. Useful queries

```sql
-- progress per application (functions only, enabled items)
SELECT a.id, a.name_en, round(sum(f.weight*f.progress)/nullif(sum(f.weight),0),1) AS pct
FROM applications a JOIN functions f ON f.app_id=a.id AND f.enabled GROUP BY a.id, a.name_en ORDER BY pct;

-- who changed what today
SELECT ts, username, action, entity, entity_id, summary FROM audit_log WHERE ts::date = current_date ORDER BY ts DESC;

-- failed logins in the last 24h by user / IP
SELECT username, host(ip), count(*) FROM auth_log WHERE NOT success AND ts > now()-interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC;
```
