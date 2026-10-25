# 05 — Database Design

**DBMS:** PostgreSQL 14+ · **Database:** `ets` · **Application role / database owner:** `ets` ·
**Log owner role:** `ets_log_owner` (no login, owns the log tables — §3a) · **Extension:** `citext`
**Creation script:** `deploy/db/create-database.sql` · **Schema source:** `backend/src/db/migrations/*.sql`
(001–009 and 012–020; the numbers 010 and 011 are not used) · **Full DDL for review:** `deploy/db/schema-reference.sql`
(after migration 020)

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
roles 1───* users 1───* sessions 1───0..1 user_presence   (1.11.0)
              │ 1───* user_activity_daily                  (1.11.0)
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
| `users` | Accounts | `username citext`, unique among accounts not deleted (3–60 of `A–Z a–z 0–9 . _ -`, never `@`, enforced by the API), `email citext` (optional; stored trimmed in lower case; **one account per address** — unique index `users_email_lower_uniq` on `lower(email)` where set, migration 014; sign-in accepts the username or the address), `password_hash` (bcrypt, re-hashed at sign-in when the cost changes), `role_id`, `language`, `is_active`, `must_change_password`, `totp_secret` (AES-256-GCM, format `v2:<key id>:…` with a key derived from `APP_SECRET`; older `v1` values are still read), `totp_enabled`, `totp_exempt`, `totp_last_step` (a code is accepted once), `failed_attempts`, `locked_until` (end of the current sign-in pause), `last_failed_at` (migration 008: the counter restarts after `LOCKOUT_RESET_MINUTES` without failures), `last_login_at/ip`, `deleted_at` / `deleted_by` / `delete_reason` (migration 015: soft delete, see 3c) |
| `user_recovery_codes` | One-time 2FA backup codes | `code_hash` (`h1:` + HMAC-SHA-256, migration 008; older plain SHA-256 codes stay valid until used or regenerated), `used_at` |
| `user_permissions` | Per-user override of a role permission | `(user_id, permission)`, `granted bool`. `usr` may be granted to the admin role only (migration 009 removed other grants, each recorded in the audit trail) |
| `user_scopes` | Data scope | `(user_id, kind, ref_id)`, kind = `department` or `application`. Full scope comes from `roles.full_scope` only: a user of another role with **no rows sees nothing** (fail closed; migration 009 lists such users in `system_log`, event `scope_fail_closed`) |
| `sessions` | Server-side sessions | `id` = SHA-256 of the cookie token, `mfa_passed`, `mfa_stage`, `expires_at`, `last_seen_at`, `revoked_at`, `revoke_reason`, `login_at` (migration 020: start of the sign-in, kept when 2FA replaces the session; NULL on older rows → `created_at`) |
| `user_presence`, `user_activity_daily` | Online users (migration 020, see 3h) | one row per signed-in session that reported its screen; active seconds per user and day |
| `settings` | System settings | `key`, `value jsonb`, `updated_by` |

### Tracker
| Table | Purpose | Key columns |
|---|---|---|
| `departments` | 4 departments | `id` (hr, fin, com, inf), names AR/EN, `color`, `emblem`, `is_base` (no reports track) |
| `applications` | 30 applications | `id` (per, pay, acc…), `department_id`, names, `default_weight`, `weight`, `note_ar`, `addendum`, `scope_cut`, `extra_module` |
| `functions` | 513+ functions | `app_id`, `code` (unique per app; added ones `C<n>`), `source`, `name_ar`, `reference`, `vendor_status`, `weight`, `progress`, `enabled`, `test_status`, `notif_status`, `review_status`, `note`, `updated_by/at`, `created_by/at`, `removed_at/by`, `removed_reason` (migration 006: a removed function is kept, `enabled=false`, and excluded from every calculation, list, export and import), `disabled_reason` (`duplicate`, `out_of_scope`, `not_required`, `other`, or `import` set by an import; NULL = excluded before 1.5.0), `disabled_note` (≤ 500; required by the API for every reason a user chooses since 1.5.1, ≥ 3 characters — older rows and `import` keep theirs), `disabled_by/at` — why an excluded function (`enabled=false`) does not count, cleared when it is included again (migration 013), `item_type` (`function` default / `report`: which part of the application % the item counts in — migration 016, see 3d) |
| `function_duplicates` | For a function excluded as a duplicate: the functions it duplicates (any application) | `function_id`, `duplicate_of_id` (PK on both; FKs to `functions` ON DELETE CASCADE — functions are only soft-removed; `CHECK function_id <> duplicate_of_id`; index on `duplicate_of_id`) — migration 013 |
| `app_reports` | Reports track per application (non-base departments; counted with the application's report items, weight 1 — 3d) | `progress`, `status`, `note` |
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
| `edit_requests` | One edit by a data-entry user waiting for the team lead | `department_id`, `app_id`, `kind` (`function`, `bulk`, `report`, `add_function`, `remove_function`, `restore_function`, `move_function` — 1.10.0, `move_application` — 1.12.16), `status` (`pending`, `applied`, `rejected`, `superseded`, `withdrawn`), `requested_by/at`, `decided_by/at`, `reason`, `apply_result`; a move (1.10.0 / 1.12.16): `target_app_id`, `target_department_id`, `source_approved_by/at`, `target_approved_by/at`, `meta` (see 3g, 3i) |
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

### 3b. Migration 014 — unique e-mail addresses (sign-in by e-mail, 1.6.0)

`users_email_lower_uniq` = `UNIQUE (lower(email::text)) WHERE email IS NOT NULL AND email <> ''`, created by the
function `ets_ensure_email_unique_index()` (returns `true` when the index exists afterwards). On a database where
several accounts already share an address (any case) the migration does **not** fail: the index is skipped, the
function raises a `NOTICE` (`ETS: … e-mail address(es) are used by more than one account …`) and writes a
`system_log` row `level='warn', event='email_index_skipped'` whose `detail` lists the addresses
(`duplicates: [{email, accounts}]`) and any usernames containing `@` (`usernames_with_at`). While the index is
missing, signing in by such an address is refused (generic error; by username it works) and the Users screen /
import refuse new duplicates. `migrate.js` — run at every service start and by `npm run migrate` — calls the function
again, so the index is created by itself once an administrator has given each account its own address. To check or
do it by hand:

```sql
SELECT to_regclass('users_email_lower_uniq');            -- NULL = not created yet
SELECT lower(email::text), array_agg(username) FROM users
 WHERE email IS NOT NULL AND email <> '' GROUP BY 1 HAVING count(*) > 1;   -- the addresses to fix
SELECT ets_ensure_email_unique_index();                  -- true once created
```

Note: on a local install `ets-log-protect migrate` runs the SQL with `client_min_messages = warning`, so the NOTICE is
not printed by `update.sh`; the `system_log` row (Logs → System) and the service start-up log (`notice: ETS: …` in
`app.log`, repeated at every start while duplicates remain) carry it.

### 3c. Migration 015 — deleted users (1.7.0)

A deleted user keeps their `users` row: `deleted_at`, `deleted_by` (→ `users`, `ON DELETE SET NULL`) and
`delete_reason` (≤ 500 characters) are set; nothing else references change. Uniqueness only applies to accounts that
are not deleted:

- `users_username_live_key` = `UNIQUE (username) WHERE deleted_at IS NULL` (replaces the `users_username_key`
  constraint; `create-admin` uses `ON CONFLICT (username) WHERE deleted_at IS NULL`);
- `users_email_lower_uniq` = `UNIQUE (lower(email::text)) WHERE email IS NOT NULL AND email <> '' AND deleted_at IS NULL`.
  Migration 015 replaces `ets_ensure_email_unique_index()` (014): it rebuilds an index of the 1.6.0 shape, counts
  duplicates among accounts not deleted, and builds the index with the `deleted_at` condition — also when
  `migrate.js` calls it later.

References to users and what a deletion does to them (rows are never removed, so no `ON DELETE` rule fires):

| Reference | `ON DELETE` | On deletion |
|---|---|---|
| `audit_log.user_id`, `auth_log.user_id` (hash-chained, append-only, migration 012) | SET NULL | untouched; new rows `delete` / `bulk_delete` and `user_deleted_by_admin` are appended |
| `access_log.user_id`, `error_log.user_id` | SET NULL | untouched |
| `functions.updated_by / removed_by / disabled_by / created_by`, `applications.updated_by`, `app_reports.updated_by`, `schedule.updated_by`, `settings.updated_by`, `branding_assets.updated_by`, `users.created_by` | SET NULL | untouched — the names still resolve |
| `edit_requests.requested_by / decided_by` | SET NULL | the user's `pending` requests → `withdrawn` (decided by the administrator, reason `user deleted: …`, audit `edit_withdraw`) |
| `import_batches.uploaded_by / lead_by / final_by / rejected_by` | SET NULL | the user's `pending` uploads → `rejected` (audit `import_reject`); a signature they already gave stays |
| `sessions.user_id` | CASCADE | every session revoked (`revoke_reason = 'user_deleted'`) |
| `user_recovery_codes.user_id` | CASCADE | deleted (with the authenticator) |
| `user_permissions.user_id`, `user_scopes.user_id` | CASCADE | **kept but inert** (no session can use them); restored with the account |

```sql
SELECT id, username, full_name, deleted_at, delete_reason FROM users WHERE deleted_at IS NOT NULL;  -- deleted accounts
```

### 3d. Migration 016 — item type: function or report (1.8.0)

`functions.item_type text NOT NULL DEFAULT 'function'`, `CHECK (item_type IN ('function','report'))`
(`functions_item_type_check`). Every existing row becomes `'function'`, so the upgrade changes no figure. The seed
(`npm run seed`) never touches the column: a type set by the users survives a re-seed.

How the type enters the calculation (`backend/src/services/calc.js`, the only place the formula lives):

| Part | Made of |
|---|---|
| functions % | enabled, not removed items with `item_type='function'`, weighted by `weight` (notification blending as before) |
| reports % | enabled, not removed items with `item_type='report'` (same rules) **plus** the `app_reports` row of the application (non-base departments only) as one more item of weight 1; NULL when there is neither |
| application % | functions % × (1 − `calc.reports_share`) + reports % × `calc.reports_share`; functions % alone when reports % is NULL (1.7.0 behaviour); reports % alone when every counted item is a report |
| application weight (`auto` mode) | sum of the weights of all enabled items, both types (unchanged by a type change) |

A type change is an ordinary edit: `edit_request_items.field = 'item_type'` (`old_value` / `new_value` `"function"` /
`"report"`) while it waits for the team lead, and an `audit_log` row `update` / `function` with
`old_value {item_type}` → `new_value {item_type}`. The legacy JSON import / export format has no type: imports leave
`item_type` as it is.

```sql
SELECT app_id, code, name_ar FROM functions WHERE item_type = 'report' AND removed_at IS NULL ORDER BY app_id, sort;
```

### 3e. Migration 017 — notifications and phones (1.9.0)

| Table | Purpose |
|---|---|
| `notifications` | one row per alert and recipient: `type`, `category` (approvals / tracking / plan / security / system), `severity` (info / warning / critical), `params` (ids, names in both languages, numbers — computed for that recipient's scope), `link` (internal path only, CHECK), `app_id` / `dept_id` (re-checked when read), `dedupe_key`, `count`, `created_at`, `updated_at`, `read_at`, `resolved_at` (a summary whose condition is gone). Unique open row per `(user_id, dedupe_key) WHERE read_at IS NULL` (`notifications_open_dedupe`). Not audit data |
| `notification_prefs` | `user_id` → `prefs` `{muted:[type], mobile_muted:[type], digest:bool}` (personal choice, not audited) |
| `notification_user_blocks` | `(user_id, type \| '*', channel 'all' \| 'mobile')` — administrator restrictions, block only |
| `notify_state` | last run of each periodic job (`job:daily`, `job:digest`, `job:weekly`), last department / project status, close-date alert |
| `mobile_devices` | phones: `name`, `platform` ('android'), `app_version`, `token_hash` (HMAC, unique), `created_at` / `created_ip`, `last_seen_at` / `last_ip` (every 5 minutes), `revoked_at` / `revoked_by` / `revoke_reason` (user, unpaired, admin, user_disabled, user_deleted, password_reset, inactive) |
| `device_pair_codes` | one-time pairing codes: `code_hash` (HMAC), `user_id`, `expires_at` (10 minutes), `used_at`, `device_id` |

`functions.progress_changed_at` / `test_changed_at`: when the progress / test status last changed (the trigger
`ets_function_change_times` sets them on INSERT and when the value changes; a note or notification-status edit does
not touch them). The migration filled them once from the change history — the newest `audit_log` row of the
function carrying `progress` / `test_status` (direct edits, approved requests, imports) or a bulk-set row listing it
— otherwise from `updated_at`.

Settings added (seed, `ON CONFLICT DO NOTHING`): every `notify.*` key of §5; `notify.policy` is stored complete
(the matrix in force) once an administrator saves it, `{}` (= defaults) until then.

```sql
-- functions without progress for 14 days, per application
SELECT app_id, count(*) FROM functions WHERE enabled AND removed_at IS NULL AND progress > 0 AND progress < 100
  AND progress_changed_at < now() - interval '14 days' GROUP BY 1 ORDER BY 2 DESC;
-- active phones per user
SELECT u.username, d.name, d.last_seen_at FROM mobile_devices d JOIN users u ON u.id = d.user_id WHERE d.revoked_at IS NULL;
```

### 3f. Migration 018 — permission `ren`, rename items (1.9.2)

Data only, no schema change. Renaming an item gets its own permission key `ren` (until 1.9.1 it used `tog`):
`roles.permissions` gains `ren` wherever it has `tog`, and every `user_permissions` row for `tog` is copied to a
`ren` row with the same `granted` value (one `audit_log` row per user concerned, `username = 'system'`, overrides
before / after). Effective rights are therefore unchanged after the upgrade. Re-runnable without side effects.

```sql
-- users whose rename right differs from their role (overrides of 'ren')
SELECT u.username, u.role_id, p.granted FROM user_permissions p JOIN users u ON u.id = p.user_id WHERE p.permission = 'ren';
```

### 3g. Migration 019 — moving items to another application (1.10.0)

- `roles.permissions` gains `mov` («نقل البنود») for `admin`, `mgr`, `pm`, `tm`, `lead` (data; the seed lists the same
  roles). No `user_permissions` row is created: a new capability, nothing to carry over.
- **`function_moves`** — one row per item moved, kept with the item (`function_id` → `functions`, CASCADE):

| Column | Meaning |
|---|---|
| `from_app_id`, `from_code`, `from_dept_id` | where the item was (application, code, department) |
| `to_app_id`, `to_code`, `to_dept_id` | where it went and the new `C<n>` code it got there |
| `weight_mode` | `fixed` \| `auto` at the time of the move |
| `weight_share` | `numeric(6,2)`, ≥ 0: application weight moved with the item (fixed mode; 0 for an excluded item, in auto mode, or a zero sum) |
| `reason` | 1–500 characters |
| `moved_by`, `moved_at`, `request_id` | who moved it (the requester when it was approved), when, and the `move_function` request if any |

  `CHECK (from_app_id <> to_app_id)`. Indexes: `(function_id, moved_at)` (history, logs), `(from_app_id, from_code)`
  (seed guard, code numbering), `(to_app_id)`. Uses: the seed never re-creates a catalog item in the application it
  was moved out of; `C<n>` numbering of an application continues after the codes that left it; the Logs keep the
  history of a moved item visible to its old department up to the move and show the application / code it had then.
- **`edit_requests`**: `kind` may be `move_function`; `target_app_id` / `target_department_id` (the destination,
  required exactly for a move: `edit_requests_move_target_check`), `source_approved_by/at` (first approval, a team
  lead of the source), `target_approved_by/at` (second, of the destination; both set by one lead of both), `meta`
  (jsonb: `{reason, weight_mode, weight_share, impact}` when requested). Partial index on `target_app_id` of pending
  requests. Items: one per function, `kind 'function'`, `field 'move'`, `meta: {reason, weight_share}`.

Weight share (fixed mode), computed when the move is applied: `weight(src) × weight(item) ÷ Σ weight of the
source's counted items` (the denominator is the source's weight in auto mode), rounded to 0.01 and never above
`weight(src)`; the source loses exactly what the destination gains, so `weight(src) + weight(dst)` is unchanged.
For several items, each is measured against the source before the move and the rounding remainder goes to the last
one.

```sql
-- items moved, newest first
SELECT m.moved_at, m.from_app_id || '/' || m.from_code AS was, m.to_app_id || '/' || m.to_code AS now, m.weight_share, m.reason
FROM function_moves m ORDER BY m.moved_at DESC;
-- move requests still waiting, and for whom
SELECT id, app_id, target_app_id, CASE WHEN source_approved_by IS NULL THEN 'source lead' ELSE 'destination lead' END AS waits_for
FROM edit_requests WHERE kind = 'move_function' AND status = 'pending';
```

### 3h. Migration 020 — online users (1.11.0)

- **`sessions.login_at`** (`timestamptz`, NULL on rows from before 1.11.0): when the sign-in started. Completing 2FA
  replaces the password-step session by a new one (new token, ETS-SEC-015); the new row copies the first row's time,
  so the session duration of «المستخدمون المتصلون الآن» starts at the password step. The API reads
  `COALESCE(login_at, created_at)`.
- **`user_presence`** — one row per signed-in session that reported where it is (`POST /api/presence`):

| Column | Meaning |
|---|---|
| `session_id` | PK, → `sessions(id)` ON DELETE CASCADE |
| `user_id` | → `users(id)` ON DELETE CASCADE |
| `client` | `web` \| `mobile` (request header `X-ETS-Client: mobile`) |
| `current_path` | the path the browser reported, 1–200 characters of `A–Z a–z 0–9 / _ . ~ % -` (kept for support; never shown as a link) |
| `current_screen` | whitelisted screen key (`^[a-z_]{1,30}$`; see `SCREENS` in `backend/src/services/presence.js`), `unknown` otherwise |
| `screen_ref` | id of what the screen shows (department, application, import batch, user), `^[A-Za-z0-9_-]{1,40}$`, checked to exist when written — else the screen is stored as `unknown` |
| `screen_since` | when this screen (key + id) was opened; unchanged by reports of the same screen |
| `first_seen`, `last_seen` | first and latest report of the session |
| `user_agent` (≤ 160), `ip` | of the latest report |

  Indexes on `user_id` and `last_seen`. Trigger **`sessions_presence_end`** (function `ets_presence_session_ended()`):
  `AFTER UPDATE OF revoked_at ON sessions` — the row is deleted as soon as its session is revoked, whatever revoked it
  (sign-out, expiry noticed, administrator, password / 2FA reset, deactivation, deletion). The clean-up
  (`services/presence.js`, every 5 minutes, advisory lock `ets_presence_cleanup`) deletes rows older than 15 minutes
  and rows whose session is no longer valid (expired or idle without a request having noticed it).
- **`user_activity_daily`** — `(user_id, day)` PK, `seconds` (≥ 0), `last_at`: the local day (setting
  `notify.timezone`) and the seconds between two reports of any of the user's sessions when at most 90 s apart, so
  parallel sessions are counted once. Rows older than 7 days are deleted by the clean-up.

```sql
-- who is online now (≤ 2 minutes) and where
SELECT u.username, p.current_screen, p.screen_ref, now() - p.screen_since AS on_screen,
       now() - COALESCE(s.login_at, s.created_at) AS session_age
FROM user_presence p JOIN sessions s ON s.id = p.session_id JOIN users u ON u.id = p.user_id
WHERE p.last_seen > now() - interval '2 minutes' AND s.revoked_at IS NULL AND s.expires_at > now();
```

### 3i. Migration 022 — moving a whole application to another department (1.12.16)

Moves an entire application (with all its functions / report items) from one department ("module", الإدارة) to
another. The application keeps its id, weight and functions (they belong to it through `application_id`, which is
untouched); only `applications.department_id` changes. The existing `mov` permission is reused — no new permission.

- **`application_moves`** — one row per application moved, kept with the application (`app_id` → `applications`,
  CASCADE); mirrors `function_moves`:

| Column | Meaning |
|---|---|
| `from_department_id`, `to_department_id` | where the application was and where it went (`CHECK (from <> to)`) |
| `weight_mode` | `fixed` \| `auto` at the time of the move |
| `weight` | `numeric(6,2)`, ≥ 0: the application's weight when it moved (for the badge / history) |
| `reason` | 1–500 characters |
| `moved_by`, `moved_at`, `request_id` | who moved it (the requester when it was approved), when, and the `move_application` request if any |

  Indexes: `(app_id, moved_at)` (the header badge, history), `(from_department_id)`, `(to_department_id)`.
- **`edit_requests`**: `kind` may be `move_application`; it carries a destination **department** but **no** destination
  application — `target_department_id` is set, `target_app_id` is NULL. The move-target check becomes a `CASE` over
  `kind`: `move_function` → both `target_app_id` and `target_department_id` set; `move_application` → only
  `target_department_id` set; every other kind → neither. Two-stage approval reuses `source_approved_by/at` (the source
  department's lead) then `target_approved_by/at` (the destination's). `meta` (jsonb): `{reason, weight_mode, weight,
  impact}` when requested. Partial index on `target_department_id` of pending requests. Its single item:
  `kind 'application'`, `field 'move'`, `meta: {reason}` — so `edit_request_items` kind check now allows `application`.

**Weight.** A department's weight is **derived** — the sum of its applications' weights (fixed mode), or the sum of
their counted item weights (auto mode); there is no stored department weight and no department weight cap. Moving the
application therefore transfers its weight with **no mutation**: the source department's total loses exactly the
application's weight and the destination gains it, so the overall weight sum (independent of how applications are
grouped into departments) is unchanged by construction — nothing can overflow or need clamping. One `move` audit row
on `application`, plus — in fixed mode — the two departments' derived weight changes as `update` rows on `department`.

**Re-seed.** The seed (`npm run seed`, run on every deploy via `npm run setup`) treats an application's
`department_id` as **initial-placement-only**: the catalog department is applied on the first `INSERT`, but
`department_id` is intentionally left out of the applications `ON CONFLICT (id) DO UPDATE SET …`, so re-seeding does
**not** reset a moved application back to its catalog department — a move owns the column thereafter. This mirrors the
`function_moves` guard for moved items and the way user-owned `weight` is never refreshed. Catalog-owned display
fields (names, `sub_ar`, `icon`, `default_weight`, `note_ar`, `addendum`, `scope_cut`, `extra_module`, `sort`) are
still refreshed from the catalog on every re-seed; a brand-new catalog application is still placed by its
`department_id` because that is an `INSERT`, not a conflict.

```sql
-- applications moved, newest first
SELECT m.moved_at, m.app_id, m.from_department_id AS was, m.to_department_id AS now, m.weight, m.reason
FROM application_moves m ORDER BY m.moved_at DESC;
-- application-move requests still waiting, and for whom
SELECT id, app_id, department_id AS from_dept, target_department_id AS to_dept,
       CASE WHEN source_approved_by IS NULL THEN 'source dept lead' ELSE 'destination dept lead' END AS waits_for
FROM edit_requests WHERE kind = 'move_application' AND status = 'pending';
```

## 4. Code values

| Column | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| `functions.vendor_status` (vendor's claim) | — | Operational | Works with a note | In progress | — | — |
| `functions.test_status` (project team) | Not tested | Passed with note | Passed | Failed | Needs re-testing | — |
| `functions.notif_status` | Not set | Working | Working with notes | Not working | — | — |
| `functions.review_status` | No review needed | Present | Missing | Notes | Acknowledged | Approved |
| `app_reports.status` | Not needed | Delivered | Missing | With notes | — | — |

`functions.review_status` has **six** states since 1.12.17 (migration 023 widened the `CHECK` from `0..3` to
`0..5`; the existing four kept their values, states 0 and 3 were relabelled — Arabic «لا توجد حاجة للمراجعة» and
«ملاحظات», and «إطلاع» / «اعتماد» added). States 4 (إطلاع / Acknowledged) and 5 (اعتماد / Approved) are completed
reviews: like Present (1) and Notes (3) they are **not** counted as «المراجعة غير موجودة» / review-missing — only
state 2 (Missing) is. Choosing state 3 (Notes) still makes the item's note mandatory.

`functions.test_status` has **five** states since 1.12.25 (migration 025 widened the `CHECK` from `0..3` to
`0..4`; the existing four kept their values). State 4 (إعادة الاختبار / Needs re-testing) is a **not-passed,
needs-testing** state: like Not tested (0) it does **not** count as tested or passed (so the «نجح» = 100 % rule
and `tested_ok` are unaffected, and it is not a pass conflict), it **requires a note** like Passed with note (1),
and it drives the new tester alert **T10 `retest`** when an item stays in it longer than `notify.retest_days`.

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
| `notify.enabled` / `notify.timezone` / `notify.digest_hour` / `notify.work_days` | `true` / `"Africa/Tripoli"` / `8` / `[0,1,2,3,4]` (Sun–Thu) |
| `notify.stuck_days` / `untested_days` / `failed_retest_days` / `retest_days` / `not_started_days` | `14` / `7` / `7` / `3` (T10, 1.12.25) / `30` |
| `notify.approval_remind_hours` / `approval_escalate_days` / `import_overdue_days` | `48` / `5` / `3` |
| `notify.dept_risk_gap` / `dept_delay_gap` / `dept_stalled_points` / `close_warning_days` | `5` / `15` / `0.5` / `30` |
| `notify.failed_logins_threshold` / `access_denied_threshold` / `server_errors_threshold` / `backup_max_age_hours` | `20` / `30` / `10` / `26` |
| `notify.distributed_login_threshold` / `distributed_login_window_min` (S13, 1.12.23) | `20` / `15` — total `login_unknown_user` across ALL IPs in the window |
| `notify.rate_cap_per_hour` / `retention_days` / `device_idle_days` | `50` / `180` / `90` |
| `notify.policy` | `{}` = the default matrix (03 §3a); validated: no ineligible cell on, no mandatory cell off |

## 6. Useful queries

```sql
-- functions % per application (function items only, enabled; without notification blending)
SELECT a.id, a.name_en, round(sum(f.weight*f.progress)/nullif(sum(f.weight),0),1) AS pct
FROM applications a JOIN functions f ON f.app_id=a.id AND f.enabled AND f.removed_at IS NULL AND f.item_type='function'
GROUP BY a.id, a.name_en ORDER BY pct;

-- who changed what today
SELECT ts, username, action, entity, entity_id, summary FROM audit_log WHERE ts::date = current_date ORDER BY ts DESC;

-- accounts whose sign-in is paused now
SELECT username, failed_attempts, locked_until FROM users WHERE locked_until > now();

-- failed logins in the last 24h by user / IP
SELECT username, host(ip), count(*) FROM auth_log WHERE NOT success AND ts > now()-interval '1 day' GROUP BY 1,2 ORDER BY 3 DESC;
```

Do not change log rows by hand: the database refuses it, and the hash chain would report it. Verify the chains
with `node scripts/verify-audit.js` (see [07 §3](07-Logging-and-Audit.md)).
