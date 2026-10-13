# 11 — API Reference

Base URL: `https://<server>/api`. All responses are JSON. Authentication uses the `ets_sid` session cookie,
which is set by `/auth/login`.

**Every POST/PUT/PATCH/DELETE must send** `X-Requested-With: ets` and `Content-Type: application/json`.

Errors: HTTP status + `{"error": "<code>", ...}`. Codes include `invalid_credentials`, `account_locked`,
`too_many_attempts`, `invalid_code`, `mfa_required`, `not_authenticated`, `forbidden` (with `permission`),
`out_of_scope`, `password_change_required`, `weak_password` (with `reasons`), `invalid_value` (with `field`),
`not_found`, `server_error`.

## Public
| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{"status":"ok","version":"0.1.0"}`, or 503 if the DB is down |
| GET | `/auth/public-info` | System names and default language for the login screen |

## Authentication — `/auth`
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/login` | `{username, password}` | → `{stage: "done" \| "verify" \| "enroll"}`; sets the cookie |
| POST | `/2fa/verify` | `{code}` or `{recovery_code}` | Partial session, stage `verify` |
| POST | `/2fa/setup` | — | → `{secret, uri, qr}` (QR as a data URL) |
| POST | `/2fa/enable` | `{code}` | → `{recovery_codes:[10]}` |
| POST | `/2fa/disable` | `{password}` | Not allowed when the policy is *required* (unless exempt) |
| POST | `/2fa/recovery-codes` | `{password}` | New codes |
| GET | `/me` | — | `{authenticated, stage, user{…permissions, scope}, mfa_mode, org names}` |
| POST | `/logout` | — | |
| POST | `/change-password` | `{current_password, new_password}` | Signs out other sessions |
| PUT | `/language` | `{language: "ar" \| "en"}` | |

## Tracker — `/tracker` (signed in)
| Method | Path | Permission | Description |
|---|---|---|---|
| GET | `/summary` | — | Totals, departments, applications with computed %, counters |
| GET | `/departments/:id` | scope | Department + its applications |
| GET | `/applications/:id` | scope | Application, functions, report, `can` flags |
| PATCH | `/functions/:id` | per field | `progress` (pct), `notif_status` (pct), `weight` (wgt), `enabled` (tog), `test_status`/`review_status`/`note` (tst), `name_en` (tog) |
| POST | `/applications/:id/bulk` | pct / tst | `{field: "progress" \| "test_status", value}` |
| POST | `/applications/:id/functions` | tog | `{name_ar, reference}`: add a custom requirement |
| DELETE | `/functions/:id` | tog | Custom requirements only |
| GET | `/weights` | — | Application weights, function-weight sums, calculation settings |
| PUT | `/weights` | wgt | `{weights:{appId:number}, weight_mode?, notif_share?, reports_share?}` |
| POST | `/weights/reset` | wgt + full scope | Restore default weights |
| GET | `/reports` | — | Reports track |
| PATCH | `/reports/:appId` | rep | `{progress?, status?, note?}` |
| GET | `/schedule` | — | Schedule + current computed % |
| PUT | `/schedule` | sch | `{start_date, periods, unit, plan \| null, actual[]}` |
| GET | `/search?q=` | — | Up to 200 functions within scope |
| GET | `/export` | exp | Data in the original tracker's JSON format (v3) |
| POST | `/import` | imp + full scope | `{content: "<html or json text>"}` or `{payload: {...}}` |

## Imports & approvals — `/imports` (signed in)
| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/preview` | imp | `{content}` → `{file_ts, options:[{target, department_id, changes, summary}]}` (options within scope) |
| POST | `/` | imp | `{content, filename, target: 'department' \| 'reports', department_id}` → pending batch |
| GET | `/?status=` | — | Batches within scope, with `can` flags |
| GET | `/pending-count` | — | `{awaiting_me, pending}` |
| GET | `/:id` | scope | Batch, changes (before/after), signatures |
| POST | `/:id/approve` | apv_dept / apv_final | `{stage: 'lead' \| 'final', note}`; both signed → applied → `{applied, applied_changes, skipped_changes}` |
| POST | `/:id/reject` | apv_dept / apv_final | `{reason}` |

## Users — `/users` (permission `usr`)
| Method | Path | Description |
|---|---|---|
| GET | `/meta` | Roles, permission keys, departments, applications, 2FA policy |
| GET | `/` | All users with 2FA status, lock state, sessions, role names |
| GET | `/:id` | User with scopes, overrides, active sessions, recovery codes left |
| POST | `/` | Create: `{username, full_name, email?, role_id, language?, password, must_change_password?, totp_exempt?, is_active?, scopes?:[{kind, ref_id}], overrides?:[{permission, granted}]}` |
| PATCH | `/:id` | Update any of the above (except password) |
| POST | `/:id/reset-password` | `{password, must_change?}` |
| POST | `/:id/reset-2fa` | Remove the authenticator |
| POST | `/:id/unlock` | |
| POST | `/:id/revoke-sessions` | |
| POST | `/bulk-2fa` | `{all: true, exempt}` or `{user_ids: [..], exempt}` |

## Settings — `/settings` (permission `cfg`, full scope)
| Method | Path | Description |
|---|---|---|
| GET | `/` | Editable settings |
| PUT | `/` | `{"mfa.mode": "required", "logs.retention_days": 365, ...}` (validated) |

## Logs — `/logs` (permission `log`)
| Method | Path | Description |
|---|---|---|
| GET | `/stats` | 24 h counters (full scope) |
| GET | `/:type` | `type` = auth, audit, access, error, system. Query: `q, from, to (YYYY-MM-DD), user_id, event, success, status, page, limit (≤500)` → `{rows, total, page, limit, events}` |
| GET | `/:type/export` | CSV with the same filters |

Non-full-scope users can only read `audit`, limited to their applications.

## System — `/system` (permission `cfg`, full scope)
| Method | Path | Description |
|---|---|---|
| GET | `/info` | Version, Node, PostgreSQL version, DB size, last migration, row counts, uptime |
