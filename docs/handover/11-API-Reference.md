# 11 — API Reference

Base URL: `https://<server>/api`. All responses are JSON. Authentication uses the `__Host-ets_sid` session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`; HTTPS only), which is set by `/auth/login`. Only a lab system with
`COOKIE_SECURE=false` uses the plain name `ets_sid`.

**Every POST/PUT/PATCH/DELETE must send** `X-Requested-With: ets` and `Content-Type: application/json`.
A body in another format is refused with `415 unsupported_media_type`. Bodies are limited to 100 kB and 32 levels of
nesting (`413 payload_too_large`, `400 invalid_json`); the file uploads `POST /imports`, `POST /imports/preview`,
`POST /tracker/import` and `PUT /branding/:key` accept up to 5 MB. Numeric ids in paths must be whole numbers in
the int4 range (`400 invalid_id`). Bidirectional control characters are removed from text values.

Errors: HTTP status + `{"error": "<code>", ...}`. Codes include `invalid_credentials` (401 — wrong or unknown
username, wrong password, disabled **or paused** account: the answer is the same), `too_many_attempts` (429, with
`retry_after` seconds: per-IP / per-account limit on password and 2FA checks, or a paused account at the 2FA step
or a re-authentication), `too_many_requests` (429, general `/api` limit, with `retry_after`), `invalid_code`,
`mfa_required`, `mfa_not_pending`, `not_authenticated`, `forbidden` (with `permission`), `out_of_scope`,
`admin_only`, `csrf_rejected`, `password_change_required`, `weak_password` (with `reasons`), `invalid_value`
(with `field`), `invalid_id`, `invalid_date`, `invalid_json`, `invalid_request`, `payload_too_large`,
`unsupported_media_type`, `requester_not_allowed`, `cannot_approve`, `not_found`, `server_error`. There is no
`423` / `account_locked` answer.

Rate limits: password / 2FA / recovery-code checks (`/auth/login`, `/auth/2fa/*`, `/auth/change-password`)
`LOGIN_RATE_LIMIT` (30) per IP per 15 min and 30 failures per typed username per 15 min; every `/api` request
`API_RATE_LIMIT` (600) per IP per minute; nginx adds 10 / min per IP on the sign-in endpoints.

## Public
| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{"status":"ok"}` (no version), or 503 `{"status":"db_unavailable"}` if the DB is down |
| GET | `/auth/public-info` | System names and default language for the login screen |

## Authentication — `/auth`
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/login` | `{username, password}` | → `{stage: "done" \| "verify" \| "enroll"}`; sets the cookie (a new token; the browser's previous session is revoked). The failure counter is cleared only when the sign-in is complete (after 2FA) |
| POST | `/2fa/verify` | `{code}` or `{recovery_code}` | Partial session, stage `verify`; on success a new session token replaces the partial one. `400 mfa_not_pending` when no 2FA step is pending |
| POST | `/2fa/setup` | `{password}` (not needed at the login enrol step) | → `{secret, uri, qr}` (QR as a data URL) |
| POST | `/2fa/enable` | `{code}` | → `{recovery_codes:[10]}` |
| POST | `/2fa/disable` | `{password, code}` or `{password, recovery_code}` | Not allowed when the policy is *required* (unless exempt); signs out other sessions |
| POST | `/2fa/recovery-codes` | `{password, code}` or `{password, recovery_code}` | New codes |
| GET | `/me` | — | `{authenticated, stage, user{…permissions, scope, recovery_codes_left, recovery_codes_outdated}, mfa_mode, org names}`; before 2FA only `user{username, language}` |
| POST | `/logout` | — | |
| POST | `/change-password` | `{current_password, new_password}` | Signs out other sessions; a wrong current password counts towards the account pause. Policy: ≥ 10 characters (12 for administrators, or the Settings minimum if higher), ≤ 72 bytes, letters and digits, not common, not containing the username |
| PUT | `/language` | `{language: "ar" \| "en"}` | |

## Tracker — `/tracker` (signed in)
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/summary` | — | Totals, departments, applications with computed %, counters |
| GET | `/departments/:id` | scope | Department + its applications |
| GET | `/applications/:id` | scope | Application, functions, report, `can` flags |
| PATCH | `/functions/:id` | per field | `progress` (pct), `notif_status` (pct), `weight` (wgt), `enabled` (tog), `test_status`/`review_status`/`note` (tst), `name_en` (tog). Without `tst`, a note may only accompany a «with notes» status the user may set while the function has no note yet |
| POST | `/applications/:id/bulk` | pct / tst | `{field: "progress" \| "test_status", value}` |
| POST | `/applications/:id/functions` | tog | `{name_ar, name_en?, reference?, weight?, progress?, enabled?}` — add a function (code `C<n>`, never reused). 201 `{function, impact}`, or 202 `{pending, request_id, impact}` for a data-entry user |
| POST | `/functions/:id/remove` | tog | `{reason}` (required) — soft removal of any function (scope or added); 200 / 202 as above. `function_removed` if already removed |
| POST | `/functions/:id/restore` | tog | Restore a removed function (included again); 200 / 202 |
| POST | `/applications/:id/impact` | tog | Preview `{add}` / `{set: [{function_id, enabled}]}` / `{drop: [id]}` → `{app, dept, total: {before, after}, included, count, app_weight}` |
| GET | `/weights` | — | Application weights, function-weight sums, calculation settings |
| PUT | `/weights` | wgt | `{weights:{appId:number}, weight_mode?, notif_share?, reports_share?}` |
| POST | `/weights/reset` | wgt + full scope | Restore default weights |
| GET | `/reports` | — | Reports track |
| PATCH | `/reports/:appId` | rep | `{progress?, status?, note?}` |
| GET | `/schedule` | — | Schedule (`start_date`, `end_date`, periods, plan, actual) + current computed % |
| PUT | `/schedule` | sch + full scope | `{start_date, periods, unit, plan \| null, actual[]}` — when a close date is set, the dates and the number of periods are kept from Settings |
| PUT | `/timeline` | cfg (full scope) | `{start_date, end_date}` — project start and planned close; errors `end_before_start`, `start_required`, `timeline_too_long` |
| GET | `/project-status` | — | Schedule, total and department progress, function/test/quality counts, pending approvals (scoped users: only requests / batches of applications in scope) and daily progress trend, for the user's scope |
| GET | `/search?q=` | — | Up to 200 functions within scope |
| GET | `/export` | exp | Data in the original tracker's JSON format (v3), limited to the applications in the user's scope; `sch` only for full-scope users |
| POST | `/import` | imp + full scope | `{content: "<html or json text>"}` or `{payload: {...}}` |

## Imports & approvals — `/imports` (signed in)
| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/preview` | imp | `{content}` → `{file_ts, options:[{target, department_id, changes, summary}]}` (options within scope) |
| POST | `/` | imp | `{content, filename, target: 'department' \| 'reports', department_id}` → pending batch |
| GET | `/?status=` | — | Batches within scope, with `can` flags |
| GET | `/pending-count` | — | `{awaiting_me, pending}` |
| GET | `/:id` | scope | Batch, changes (before/after) of the applications in the reader's scope, signatures. A reader who sees only part of the batch gets `change_count`, `summary.counts`, `apply_result` of the visible changes, department figures only for departments fully in scope and `summary.project: null` (same in the list) |
| POST | `/:id/approve` | apv_dept / apv_final | `{stage: 'lead' \| 'final', note}`; every changed application in scope; never the uploader; both signed → applied → `{applied, applied_changes, skipped_changes}`. 409 `requester_not_allowed` when the uploader is no longer active / allowed |
| POST | `/:id/reject` | apv_dept / apv_final | `{reason}`; every changed application in scope |

## Edit approvals — `/approvals` (signed in)
Function, bulk and report edits by data-entry users answer **202** `{pending: true, request_id}` instead of applying.

| Method | Path | Description |
|---|---|---|
| GET | `/?status=&mine=1` | Requests visible to the user, with items (before/after) and `can` flags |
| GET | `/pending-count` | `{awaiting_me, mine}` |
| POST | `/:id/approve` | Team lead with the request's application in scope → applied `{applied_changes, skipped_changes}`. 409 `requester_not_allowed` when the author is no longer active / in scope / permitted |
| POST | `/:id/reject` | `{reason}` (required) |
| POST | `/:id/withdraw` | Requester only |
| POST | `/approve-all` | All pending requests the user can approve (or `{ids:[…]}`) → `{requests, applied_changes, skipped_changes, blocked_requests}` (blocked = author no longer allowed, left pending) |

## Branding — `/branding`
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/:key` | public | `logo`, `favicon` or `login_bg` image (404 = default) |
| PUT | `/:key` | cfg | `{data: "data:image/png;base64,…"}` — PNG/JPEG/WebP/ICO only |
| DELETE | `/:key` | cfg | Back to default |

## Users — `/users` (permission `usr`, System Administrator role only)
Errors: `usr_admin_only` (granting `usr` to another role), `cannot_change_own_permissions` (widening your own
permissions / scope / 2FA exemption), `last_admin` (would leave no active administrator holding `usr` and `cfg`),
`invalid_permission` (unknown or duplicate permission in `overrides`), `use_change_password` (resetting your own
password — use `POST /auth/change-password`).
| Method | Path | Description |
|---|---|---|
| GET | `/meta` | Roles, permission keys, departments, applications, 2FA policy |
| GET | `/` | All users with 2FA status, lock state, sessions, role names |
| GET | `/:id` | User with scopes, overrides, active sessions, recovery codes left (recorded as `view` / `user` in the audit trail) |
| POST | `/` | Create: `{username, full_name, email?, role_id, language?, password, must_change_password?, totp_exempt?, is_active?, scopes?:[{kind, ref_id}], overrides?:[{permission, granted}]}` |
| PATCH | `/:id` | Update any of the above (except password) |
| POST | `/:id/reset-password` | `{password, must_change?}` — also clears the sign-in pause; signs the user out. Not for your own account (400 `use_change_password`) |
| POST | `/:id/reset-2fa` | Remove the authenticator; signs the user out |
| POST | `/:id/unlock` | Clears the failure count and the sign-in pause |
| POST | `/:id/revoke-sessions` | |
| POST | `/bulk-2fa` | `{all: true, exempt}` or `{user_ids: [..], exempt}` → `{updated}`. With `exempt: true`, `all` leaves the caller out and a list naming the caller is refused (400 `cannot_change_own_permissions`); removing exemptions includes the caller |

## Settings — `/settings` (permission `cfg`, full scope)
| Method | Path | Description |
|---|---|---|
| GET | `/` | Editable settings |
| PUT | `/` | `{"mfa.mode": "required", "logs.retention_days": 365, "logs.audit_retention_days": 365, ...}` (validated; audit retention ≥ 365) |

## Logs — `/logs` (permission `log`)
| Method | Path | Description |
|---|---|---|
| GET | `/stats` | 24 h counters and `log_write_failures` (administrators) |
| GET | `/integrity` | Hash-chain verification of `audit_log` and `auth_log` → `{ok, tables:[{table, rows, first_seq, last_seq, head, purges, breaks}]}` (administrators) |
| GET | `/:type` | `type` = auth, audit, access, error, system. Query: `q, from, to (YYYY-MM-DD), user_id, event, success, status, page, limit (≤500)` → `{rows, total, page, limit, events}` |
| GET | `/:type/export` | CSV with the same filters |

`auth`, `access`, `error` and `system` are for administrators only (`403 admin_only` otherwise). Other users read
`audit` only — non-full-scope users limited to their applications — with IP addresses and user agents removed
(also inside `context`, and in the CSV).

## System — `/system` (permission `cfg`, full scope)
| Method | Path | Description |
|---|---|---|
| GET | `/info` | Version, Node, PostgreSQL version, DB size, last migration, row counts, uptime |
