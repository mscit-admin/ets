# 11 — API Reference

Base URL: `https://<server>/api`. All responses are JSON. Authentication uses the `__Host-ets_sid` session cookie
(`HttpOnly`, `Secure`, `SameSite=Strict`; HTTPS only), which is set by `/auth/login`. Only a lab system with
`COOKIE_SECURE=false` uses the plain name `ets_sid`.

**Every POST/PUT/PATCH/DELETE must send** `X-Requested-With: ets` and `Content-Type: application/json`.
A body in another format is refused with `415 unsupported_media_type`. Bodies are limited to 100 kB and 32 levels of
nesting (`413 payload_too_large`, `400 invalid_json`); the file uploads `POST /imports`, `POST /imports/preview`,
`POST /tracker/import` and `PUT /branding/:key` accept up to 5 MB, and `POST /users/import[/preview]` up to 1 MB
(read only after the administrator check). Numeric ids in paths must be whole numbers in
the int4 range (`400 invalid_id`). Bidirectional control characters are removed from text values.

Errors: HTTP status + `{"error": "<code>", ...}`. Codes include `invalid_credentials` (401 — wrong or unknown
username or e-mail address, wrong password, disabled **or paused** account, an address shared by several accounts:
the answer is the same), `too_many_attempts` (429, with
`retry_after` seconds: per-IP / per-account limit on password and 2FA checks, or a paused account at the 2FA step
or a re-authentication), `too_many_requests` (429, general `/api` limit, with `retry_after`), `invalid_code`,
`mfa_required`, `mfa_not_pending`, `not_authenticated`, `forbidden` (with `permission`), `out_of_scope`,
`admin_only`, `csrf_rejected`, `password_change_required`, `weak_password` (with `reasons`), `invalid_value`
(with `field`), `invalid_id`, `invalid_date`, `invalid_json`, `invalid_request`, `payload_too_large`,
`unsupported_media_type`, `requester_not_allowed`, `cannot_approve`, `not_found`, `server_error`,
`pass_requires_100`, `progress_below_100_while_passed`, `import_has_row_errors` (1.8.1, see below), `mandatory_type`,
`invalid_token` (401, `/m/*`), `too_many_devices` (409) (1.9.0), `rename_reason_required`, `rename_must_be_separate`,
`name_unchanged` (400), `name_changed` (409) (1.9.1, see the rename below). There is no
`423` / `account_locked` answer.

**«نجح» needs 100 % (1.8.1).** The test status «نجح» (`test_status: 2`, plain pass) is accepted only with progress
100, and the progress of a passed item cannot go below 100. «نجح مع ملاحظة» (`test_status: 1`, pass with note) has no
progress rule. Only a change of `test_status` or `progress` is checked, so an item already passed below 100 % before
1.8.1 is left as it is, keeps every other edit, and is fixed by either field (progress 100, or a status other than
«نجح»). Report items (`item_type: "report"`) follow the same rule. Errors:

| Code | Status | When | Extra fields |
|---|---|---|---|
| `pass_requires_100` | 400 | The change sets «نجح» while the progress (after the change) is below 100 — unless the same request sets `progress: 100` | single edit: `progress`, `test_status`, `code`; bulk: `bulk`, `count`, `items`, `list` |
| `progress_below_100_while_passed` | 400 | The change sets a progress below 100 on an item that stays «نجح» — unless the same request moves `test_status` away from 2 | as above |
| `pass_requires_100` / `progress_below_100_while_passed` | 409 | On approval of an edit request (`/approvals/:id/approve`), or when the saved row of a direct edit would break the rule because of another change at the same moment (rolled back) | `function_id`, `code`, `progress`, `test_status` |
| `import_has_row_errors` | 400 | `POST /imports` (the chosen part of the file) or `POST /tracker/import`: rows of the file would set «نجح» below 100 % or lower a passed item below 100 %. Nothing is written | `count`, `errors: [{app_id, function_id, code, name_ar, name_en, item_type, error, progress, test_status}]` (up to 200), `list` (`"per/D3, per/D7, … (+n)"`) |

Bulk `items`: `[{function_id, app_id, code, name_ar, name_en, item_type, progress, current_progress, test_status, error}]`
(up to 200) — every counted item that blocks the bulk set; nothing is changed (all or nothing).

Rate limits: password / 2FA / recovery-code checks (`/auth/login`, `/auth/2fa/*`, `/auth/change-password`)
`LOGIN_RATE_LIMIT` (30) per IP per 15 min and 30 failures per typed sign-in name (username or e-mail, trimmed, lower case) per 15 min; every `/api` request
`API_RATE_LIMIT` (600) per IP per minute; nginx adds 10 / min per IP on the sign-in endpoints.

## Public
| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{"status":"ok"}` (no version), or 503 `{"status":"db_unavailable"}` if the DB is down |
| GET | `/auth/public-info` | System names and default language for the login screen |

## Authentication — `/auth`
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/login` | `{username, password}` | `username` is the sign-in name: **the username or the e-mail address** (1.6.0; trimmed; a value with `@` is matched to `lower(email)`, otherwise to the username, both case-insensitive; with `@` and no e-mail match, an older username containing `@`). → `{stage: "done" \| "verify" \| "enroll"}`; sets the cookie (a new token; the browser's previous session is revoked). The failure counter belongs to the account, whichever name was typed, and is cleared only when the sign-in is complete (after 2FA). `400 missing_credentials` when a field is empty |
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
| GET | `/summary` | — | Totals, departments, applications with computed %, counters. **1.8.0:** `counts.functions` / `done` count function items only, `counts.report_items` the items marked as reports; each `application.calc` carries `fnPct`, `reportPct` (null without reports), `fnShare` / `reportShare` (the shares used for `pct`: 1/0, 0.85/0.15, or 0/1 when every counted item is a report), `items: {function, report}`, `typeWeight: {function, report}`, `reportItems`, `reportTrack`, `reportWeight` (report items' weight + 1 for the track) |
| GET | `/departments/:id` | scope | Department + its applications |
| GET | `/applications/:id` | scope | Application, functions (each with `item_type`: `function` \| `report`, 1.8.0), report, `can` flags (`pct`, `wgt`, `tst`, `tog`, `ren` — 1.9.2 —, `rep`). Each function carries `disabled_reason`, `disabled_note`, `disabled_by`, `disabled_by_name`, `disabled_at` and `duplicate_of: [{id, app_id, code, removed, visible, name_ar?, name_en?}]` (names only for functions in the reader's scope); `pending` items carry `meta` (the reason of a pending exclusion, or `{rename_reason}` of a pending rename — 1.9.1) |
| PATCH | `/functions/:id` | per field | `progress` (pct), `notif_status` (pct), `weight` (wgt), `enabled` (tog), `test_status`/`review_status`/`note` (tst), **`item_type` (tog, 1.8.0): `"function"` \| `"report"`** — anything else 400 `invalid_value`; audited `{item_type}` old → new, sent to the team lead like the other fields. Without `tst`, a note may only accompany a «with notes» status the user may set while the function has no note yet. **Exclusion (1.5.0):** `enabled: false` needs `disabled_reason` (`duplicate` \| `out_of_scope` \| `not_required` \| `other`), `disabled_note` (trimmed, ≤ 500 characters; **required for every reason since 1.5.1**: at least 3 non-whitespace characters — missing, empty, whitespace-only or shorter → 400 `disable_note_required` with `min: 3`) and, for `duplicate`, `duplicate_of: [function ids]` (1–50; in the user's scope, not the function itself, not removed). Errors 400 `disable_reason_required`, `disable_note_required`, `duplicate_of_required`, `invalid_duplicate` (`problem`: `self` \| `unavailable` \| `removed`), `invalid_value` (`field`). The reason fields are refused without `enabled: false`. `enabled: true` needs no reason and clears the stored one (the audit row keeps it as the old value). **(1.8.1)** 400 `pass_requires_100` / `progress_below_100_while_passed` (see «نجح» needs 100 % above), checked before a data-entry edit is sent for approval too; `{test_status: 2, progress: 100}` in one request is accepted. **Rename (1.9.1):** `name_ar` and / or `name_en` (`ren` since 1.9.2, `tog` before) only with a reason — see the next row |
| PATCH | `/functions/:id` (rename, 1.9.1) | ren (1.9.2; tog in 1.9.1) | `{name_ar?, name_en?, rename_reason}` — at least one name; **nothing else in the request** (400 `rename_must_be_separate` with `fields`), so the reason belongs to the rename; the `code` never changes. `rename_reason`: trimmed, 3–500 characters, whitespace not counted (missing / shorter → 400 `rename_reason_required` with `min: 3`; not a string or longer → `invalid_value`). `name_ar`: trimmed, not empty, ≤ 500 characters (else 400 `invalid_value`, `field: "name_ar"`). `name_en`: trimmed, ≤ 500; `null` or empty clears it. Neither name different from the current one → 400 `name_unchanged`. Removed item → 409 `function_removed`; without `ren` → 403 `forbidden` (`permission: "ren"`, since 1.9.2 — `tog` alone no longer allows it, and `ren` alone does not allow adding / removing / including); application out of scope → 403 `out_of_scope`. 200 `{function}` — audit row `update` with `old_value: {name_ar?, name_en?}` and `new_value: {name_ar?, name_en?, rename_reason}` (only the changed names) — or, for a data-entry user, 202 `{pending, request_id, function}`: one request item per changed name with `meta: {rename_reason}`. Either answer adds `warning: "duplicate_name"` when another item of the same application (not removed) already has that Arabic name (case and surrounding spaces ignored); the rename is not blocked. 409 `name_changed` if the name was changed by someone else at the same moment. Live update `tracker_changed` after commit |
| POST | `/applications/:id/bulk` | pct / tst / tog | `{field: "progress" \| "test_status", value}` (every counted function), or **(1.5.0)** `{field: "enabled", value: false, function_ids: [..], disabled_reason, disabled_note, duplicate_of?}` — exclude the chosen functions of the application (1–500, not removed) with one reason and its required note (same rules as the PATCH, 1.5.1; the duplicated functions may not be among the chosen ones); `value: true` includes them again. **(1.8.0)** `{field: "item_type", value: "function" \| "report", function_ids: [..]}` (tog) — set the type of the chosen items (1–500, of this application, not removed; excluded ones allowed). One audit row per function (`context.bulk`). 200 `{updated}` or 202 `{pending, request_id, requested}`. **(1.8.1)** `test_status: 2` when a counted item is below 100 %, or `progress` < 100 when a counted item is «نجح» (and its progress would change) → 400 `pass_requires_100` / `progress_below_100_while_passed` with `count`, `items`, `list`; nothing is changed or sent for approval |
| GET | `/function-options?app_id=&all=1&q=&exclude=` | scope | **(1.5.0)** Functions a duplicate can point at: counted (not excluded, not removed), in the user's scope, not in `exclude` (comma-separated ids). Default: the application `app_id` (403 out of scope); `all=1`: every application in scope. `q` searches code, names and application. → `{options: [{id, app_id, code, name_ar, name_en, app_name_ar, app_name_en}], more}` (up to 200) |
| POST | `/applications/:id/functions` | tog | `{name_ar, name_en?, reference?, weight?, progress?, enabled?, item_type?}` (`item_type` 1.8.0, default `function`; other values 400 `invalid_value`) — add a function (code `C<n>`, never reused). 201 `{function, impact}`, or 202 `{pending, request_id, impact}` for a data-entry user |
| POST | `/functions/:id/remove` | tog | `{reason}` (required) — soft removal of any function (scope or added); 200 / 202 as above. `function_removed` if already removed |
| POST | `/functions/:id/restore` | tog | Restore a removed function (included again, any exclusion reason cleared); 200 / 202 |
| POST | `/applications/:id/impact` | tog | Preview `{add}` (with `item_type`, 1.8.0) / `{set: [{function_id, enabled}]}` / `{drop: [id]}` → `{app, dept, total: {before, after}, included, count, app_weight}` |
| GET | `/weights` | — | Application weights, function-weight sums, calculation settings |
| PUT | `/weights` | wgt | `{weights:{appId:number}, weight_mode?, notif_share?, reports_share?}` |
| POST | `/weights/reset` | wgt + full scope | Restore default weights |
| GET | `/reports` | — | Reports track; each application also carries `report_pct` (its reports %: the track with its report items, 1.8.0) and `report_items` |
| PATCH | `/reports/:appId` | rep | `{progress?, status?, note?}` |
| GET | `/schedule` | — | Schedule (`start_date`, `end_date`, periods, plan, actual) + current computed % |
| PUT | `/schedule` | sch + full scope | `{start_date, periods, unit, plan \| null, actual[]}` — when a close date is set, the dates and the number of periods are kept from Settings |
| PUT | `/timeline` | cfg (full scope) | `{start_date, end_date}` — project start and planned close; errors `end_before_start`, `start_required`, `timeline_too_long` |
| GET | `/project-status` | — | Schedule, total and department progress, function/test/quality counts (1.8.0: `functions` / `done` / `in_progress` / `not_started` count function items; `reports` = report items + reports tracks, `reports_done`, `reports_pct` pooled like an application's reports %, `report_items`, `report_tracks`), pending approvals (scoped users: only requests / batches of applications in scope) and daily progress trend, for the user's scope |
| GET | `/search?q=` | — | Up to 200 functions within scope (with `item_type`) |
| GET | `/export` | exp | Data in the original tracker's JSON format (v3), limited to the applications in the user's scope; `sch` only for full-scope users |
| POST | `/import` | imp + full scope | `{content: "<html or json text>"}` or `{payload: {...}}`. Functions the file turns off get the exclusion reason `import`; functions it turns on lose their reason. The original format has no item type: `item_type` is left as it is (also for `/imports`). **(1.8.1)** 400 `import_has_row_errors` (nothing imported) when a row sets «نجح» below 100 % or lowers a passed item below 100 %; an item already passed below 100 % that the file leaves as it is, is not an error. The CLI `npm run import-legacy` refuses such a file the same way |

## Imports & approvals — `/imports` (signed in)
| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/preview` | imp | `{content}` → `{file_ts, options:[{target, department_id, changes, summary, errors}]}` (options within scope). **(1.8.1)** `errors`: the option's row errors — items whose changes in the file would set «نجح» below 100 % or lower a passed item below 100 % (`[{app_id, function_id, code, name_ar, name_en, item_type, error, progress, test_status}]`; always `[]` for `reports`) |
| POST | `/` | imp | `{content, filename, target: 'department' \| 'reports', department_id}` → pending batch. **(1.8.1)** 400 `import_has_row_errors` (`count`, `errors`, `list`) when the chosen part has row errors; no batch is created |
| GET | `/?status=` | — | Batches within scope, with `can` flags |
| GET | `/pending-count` | — | `{awaiting_me, pending}` |
| GET | `/:id` | scope | Batch, changes (before/after) of the applications in the reader's scope, signatures. A reader who sees only part of the batch gets `change_count`, `summary.counts`, `apply_result` of the visible changes, department figures only for departments fully in scope and `summary.project: null` (same in the list) |
| POST | `/:id/approve` | apv_dept / apv_final | `{stage: 'lead' \| 'final', note}`; every changed application in scope; never the uploader; both signed → applied → `{applied, applied_changes, skipped_changes}`. 409 `requester_not_allowed` when the uploader is no longer active / allowed. A file has no reason column: functions it turns off get the reason `import` with the note `#<batch id> <file name>` (1.5.0). **(1.8.1)** When the batch is applied, an item it would now leave «نجح» below 100 % (changed since the upload) keeps its values: its `test_status` / `progress` changes are put back and listed as skipped with the note `pass_requires_100` / `progress_below_100_while_passed` |
| POST | `/:id/reject` | apv_dept / apv_final | `{reason}`; every changed application in scope |

## Edit approvals — `/approvals` (signed in)
Function, bulk and report edits by data-entry users answer **202** `{pending: true, request_id}` instead of applying.

| Method | Path | Description |
|---|---|---|
| GET | `/?status=&mine=1` | Requests visible to the user, with items (before/after) and `can` flags. An exclusion item (`field: "enabled"`, `new_value: false`) carries `meta: {disabled_reason, disabled_note, duplicate_of: [{id, app_id, code}]}` (1.5.0). The note is checked when the request is submitted (1.5.1), not on approval: a request submitted before 1.5.1 without a note is still approved and applied as it is |
| GET | `/pending-count` | `{awaiting_me, mine}` |
| POST | `/:id/approve` | Team lead with the request's application in scope → applied `{applied_changes, skipped_changes}`. 409 `requester_not_allowed` when the author is no longer active / in scope / permitted (also when a function named as duplicated is no longer in the author's scope). An exclusion is applied with its reason and links in the author's name; it is skipped when a duplicated function has been removed since the request. **(1.8.1)** 409 `pass_requires_100` / `progress_below_100_while_passed` (`function_id`, `code`, `progress`, `test_status`) when, with the values of the moment, the request would leave an item «نجح» below 100 % (e.g. the progress was lowered since a «نجح» request); nothing is applied and the request stays pending. **(1.9.1)** A rename (items `name_ar` / `name_en`, reason in `meta.rename_reason`) whose current name is no longer the name it was requested against → 409 `name_changed` (`function_id`, `field`, `expected`, `current`); nothing is applied and the request stays pending (reject it to have it sent again). An applied rename is audited in the author's name with `rename_reason` in `new_value`. **(1.9.2)** The author must still hold `ren` for a rename item (else 409 `requester_not_allowed`, `reason: "requester_lacks_permission"`) |
| POST | `/:id/reject` | `{reason}` (required) |
| POST | `/:id/withdraw` | Requester only |
| POST | `/approve-all` | All pending requests the user can approve (or `{ids:[…]}`) → `{requests, applied_changes, skipped_changes, blocked_requests}` (blocked = author no longer allowed, or — 1.8.1 — refused by the «نجح» = 100 % rule, or — 1.9.1 — a rename whose name changed since the request; left pending) |

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
password — use `POST /auth/change-password`), `invalid_username` (not 3–60 of `A–Z a–z 0–9 . _ -`; `@` is never
allowed — an older username sent back unchanged by `PATCH` is accepted), `username_taken`, `invalid_email`,
`email_taken` (1.6.0: the address, compared without regard to case, belongs to another account or equals an older
username with `@`; on `PATCH` only a changed address is checked). `email` is stored trimmed and in lower case.
| Method | Path | Description |
|---|---|---|
| GET | `/meta` | Roles, permission keys (`pct`, `wgt`, `tst`, `tog`, `ren` — 1.9.2 —, `sch`, `rep`, `exp`, `imp`, `usr`, `log`, `cfg`, `apv_dept`, `apv_final`), departments, applications, 2FA policy |
| GET | `/` | All users (not deleted) with 2FA status, lock state, sessions, role names. `?deleted=1` (1.7.0): the deleted accounts instead → `{users: [{id, username, full_name, email, role_id, deleted_at, delete_reason, deleted_by_name, username_taken, email_taken, …}], deleted: true}` |
| GET | `/:id` | User with scopes, overrides, active sessions, recovery codes left (recorded as `view` / `user` in the audit trail). A deleted user → 404 (also for `PATCH` and the actions below) |
| POST | `/` | Create: `{username, full_name, email?, role_id, language?, password, must_change_password?, totp_exempt?, is_active?, scopes?:[{kind, ref_id}], overrides?:[{permission, granted}]}` |
| PATCH | `/:id` | Update any of the above (except password) |
| POST | `/:id/reset-password` | `{password, must_change?}` — also clears the sign-in pause; signs the user out. Not for your own account (400 `use_change_password`) |
| POST | `/:id/reset-2fa` | Remove the authenticator; signs the user out |
| POST | `/:id/unlock` | Clears the failure count and the sign-in pause |
| POST | `/:id/revoke-sessions` | |
| POST | `/import/preview` | Bulk import check, writes nothing: `{rows: [{username, full_name, email?, role, language?, departments?, applications?, overrides?}]}` (1–500 rows; `role_id` is accepted for `role`; `role`, `language`, `departments`, `applications` take ids **or names** (1.1.1: Arabic / English name, department short name; languages `ar`/`en`/العربية/عربي/Arabic/الإنجليزية/انجليزي/English; Arabic spelling variants are normalised, see `backend/src/utils/importMatch.js`); `departments` / `applications` are an array of cells or one string, values separated by `,` `،` `;`; `overrides` is API-only, same rules as `POST /`) → `{results: [{index, username, status: "ok"\|"error", errors: [codes], details?: [{code, field, value, matches?}]}], ok, errors}` — `details` names the value that was not recognised (`field`: `role`, `language`, `departments`, `applications`; `matches`: the candidate ids of an ambiguous name). Row codes: `username_taken` (case-insensitive), `duplicate_in_file`, `invalid_username`, `full_name_required`, `full_name_too_long`, `invalid_email`, `email_taken` (1.6.0, with `details` `field: "email"`), `duplicate_email_in_file` (the same address, any case, on two rows; with `details`), `invalid_role`, `invalid_language`, `invalid_scope`, `ambiguous_value` (a name matching more than one item), `scope_required` (department-limited role without department/application), `usr_admin_only`, `invalid_permission`, `invalid_row`. Request errors: 400 `invalid_value` (`field: "rows"`, empty / not a list), 400 `too_many_rows` (`max: 500`, `count`), 413 `payload_too_large` (> 1 MB) |
| POST | `/import` | Same body. Checks again and creates **every** row in one transaction (active, `must_change_password: true`, random temporary password, language default = Settings), or nothing: 400 `import_has_errors` with the same `{results, ok, errors}` when any row is refused (also when a username was taken meanwhile). → **201** `{created, users: [{id, username, temporary_password}]}` — the only place the temporary passwords ever appear (not stored in clear, not logged). Audit: one `create` / `user` row per user (`context.via = "bulk_import"`, no password) and one `bulk_create` / `user` row `{count, usernames}`, in the same transaction |
| DELETE | `/:id` | 1.7.0 — delete (soft): `{reason}` (3+ characters without spaces, ≤ 500) → `{deleted: [{id, username}], requests_withdrawn, imports_rejected}`. Errors: 400 `delete_reason_required` (`min`), `delete_reason_too_long` (`max`), `cannot_delete_self`, `last_admin`, `already_deleted`; 404. Revokes the sessions, removes the authenticator, withdraws pending edit requests, rejects pending import files; audit `delete` / `user` (`context: {reason, target, by, sessions_revoked, requests_withdrawn, imports_rejected}`) + auth `user_deleted_by_admin` |
| POST | `/bulk-delete` | 1.7.0 — `{ids: [..] (1–200, distinct), reason}`, one transaction, all or nothing → same answer as `DELETE /:id`. 400 `invalid_value` (`field: "ids"`), `too_many_ids` (`max: 200`), `bulk_delete_refused` `{errors: [{id, username?, error: not_found \| already_deleted \| cannot_delete_self \| last_admin}]}`. Audit: one `delete` row per user (`context.bulk`) and one `bulk_delete` / `user` row `{count, ids, usernames, reason}` |
| POST | `/:id/restore` | 1.7.0 — `{reason}` → `{user, username, temporary_password}` (shown once; `must_change_password: true`; no authenticator). 409 `username_taken` / `email_taken`, 400 `not_deleted`. Audit `restore` / `user`, auth `user_restored_by_admin` |
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
| GET | `/:type/export` | CSV with the same filters (also needs `exp` since 1.3.0) |

`auth`, `access`, `error` and `system` are for administrators only (`403 admin_only` otherwise). Other users read
`audit` only — non-full-scope users limited to their applications — with IP addresses and user agents removed
(also inside `context`, and in the CSV).

## Excel exports — `/export` (permission `exp`, 1.3.0)
| Method | Path | Description |
|---|---|---|
| GET | `/:report.xlsx` | One-sheet Excel file of a screen. `report` = `summary`, `project_status`, `department` (`id`; 1.8.0: ends with «بنود التقارير» and «إنجاز التقارير», «عدد الوظائف» counts function items), `functions` (`id`, `q`, `source`, `test` — 0–3, or `conflict` (1.8.1): items «نجح» below 100 % —, `show_off`, `show_removed`, `reason` — 1.5.0: `duplicate`, `out_of_scope`, `not_required`, `other`, `import` or `none`; `item_type` — 1.8.0: `function` \| `report`; the sheet ends with the columns «سبب الإلغاء» / «مكررة مع» / «ملاحظة الإلغاء» / «النوع»; «الحصة» is the item's share of its part — functions or reports), `weights`, `reports` (`dept`; 1.8.0: ends with «بنود التقارير» and the application's reports % «إنجاز التقارير»), `schedule`, `approvals` (`status`, `mine`; 1.9.1: the «بعد» cell of a rename ends with «سبب تعديل الاسم: …»), `imports` (`status`), `import_detail` (`id`), `users` (also `usr` + administrator role; deleted users left out, 1.7.0: `deleted=1` exports only them, with deleted on / by / reason), `log` (`type`, and the `/logs/:type` filters; also `log`). `lang=ar\|en` (default: the user's language). Same scope as the screen; strict audit row (`action=export`, `entity=<report>`); `Content-Disposition` with an ASCII `filename` and a UTF-8 `filename*`; up to 100,000 rows |

See *06-Security.md → 4a. Export policy* for the permission × scope matrix.

## Live updates — `/events` (signed in, 1.4.0)
| Method | Path | Description |
|---|---|---|
| GET | `/events` | `text/event-stream` (Server-Sent Events). Events: `ready` (stream open), `tracker_changed` (`{"type":"tracker_changed","dept_id"?,"app_id"?}` — ids only, never values; sent after the change is committed, only to users whose scope includes that department / application, without ids for project-wide changes), `session_ended` (signed out, expired, idle, revoked or disabled — the stream then closes). Heartbeat comment every `LIVE_HEARTBEAT_SECONDS` (25 s), on which the session is re-checked. At most `LIVE_MAX_STREAMS_PER_USER` (5) streams per user per API process → `429 too_many_streams`; `503 live_unavailable` when the database listener cannot start. Opening the stream is written to the access log once; neither the stream nor reloads marked `X-ETS-Live: 1` count as activity for the idle timeout |

Changes that send `tracker_changed`: function edits (%, weight, test / notification / review status, note, include / exclude), bulk set, add / remove / restore, edit requests sent / approved / rejected / withdrawn, application weights and calculation parameters, weights reset, reports track, schedule / timeline, team-result imports (submitted, signed, applied, rejected), the full tracker import, and settings that change the calculation or the approval rule. Between API processes the event travels through PostgreSQL `LISTEN/NOTIFY` (channel `ets_live`, `pg_notify` after `COMMIT`).

## Notifications — `/notifications` (signed in, 1.9.0)
| Method | Path | Description |
|---|---|---|
| GET | `/` | `?unread=1&category=approvals\|tracking\|plan\|security\|system&type=<type>&severity=info\|warning\|critical&before=<id>&limit=1..100&lang=ar\|en` → `{items:[{id, type, category, severity, title, body, link, count, created_at, updated_at, read}], next_before}` — newest first; title / body rendered by the server in `lang` (default: the user's language); only rows the user may see now |
| GET | `/count` | `{unread, critical, top_severity}` (the bell) |
| POST | `/:id/read` · `/:id/unread` | → `{marked}` (0 for a row that is not the user's or not visible) |
| POST | `/read-all` | `{ids?:[..]}` (≤ 500) — every visible unread alert, or these → `{marked}` |
| GET | `/prefs` | `{types:[{type, code, category, kind, digest, mandatory, blocked, mobile_blocked, push_allowed, muted, mobile_muted}], digest}` — the types this user may receive |
| PUT | `/prefs` | `{muted?:[type], mobile_muted?:[type], digest?:bool}` → as GET; `400 mandatory_type` for a mandatory type |
| GET | `/policy-meta` | (`cfg`, full scope) `{roles, types:[{type, code, category, kind, severity, digest, admin_only, eligible:[role], locked:[role], default_on:[role], default_push}], policy}` |

Types: `approval_pending` (A1), `approval_overdue` (A2), `request_decided` (A3), `import_pending` (A4), `import_result`
(A5), `import_overdue` (A6), `stuck` (T1), `untested` (T2), `failed_retest` (T3), `pass_conflict` (T4), `not_started` (T5),
`quality` (T6), `excluded` (T7), `dept_behind` (P1), `dept_stalled` (P2), `project_status` (P3), `close_approaching` (P4),
`account_locked` (S1), `failed_logins` (S2), `audit_integrity` (S3), `email_index` (S4), `access_denied` (S5),
`backup_missing` (S6), `retention_reduced` (S7), `server_errors` (S8), and `rate_capped` (above the hourly cap).
The policy itself is the setting `notify.policy` (`PUT /settings`). The live stream `/events` also sends
`notif_changed` `{unread, top_severity}` to the user's own streams when their alerts change (no content).

## Devices — `/devices` (1.9.0)
| Method | Path | Description |
|---|---|---|
| POST | `/pair-code` | (signed in; `{password, code? \| recovery_code?}` — re-authentication as for 2FA changes; login rate limit) → `{code, expires_at, payload}`; `payload` is the QR text: `{"v":1,"url":"<PUBLIC_BASE_URL or the request's address>","code":"<code>","cert_sha256":"<64 hex or null>"}`. Errors: `wrong_password`, `mfa_code_required`, `invalid_code`, 429 |
| POST | `/pair` | **no session, no X-Requested-With**: `{code, device_name (1–80), platform:"android", app_version?}` → `201 {device_id, token, user:{full_name, lang}}` (token shown once). `400 invalid_code` (unknown, used, expired, or account unavailable), `400 missing_fields`, `400 invalid_value`, `409 too_many_devices {max:10}`, `429 too_many_attempts` (`PAIR_RATE_LIMIT`/15 min/IP) |
| GET | `/` | (signed in) own devices `{devices:[{id, name, platform, app_version, created_at, last_seen_at, revoked_at, revoke_reason}]}` (active, and revoked in the last 30 days) |
| DELETE | `/:id` | (signed in) revoke one of one's own devices → `{ok:true, revoked:0\|1}`; another user's device → 404 |

Administrators (`/users`, `usr` + admin role): `GET /users/:id` includes `devices` (with `last_ip`) and
`notify_blocks`; `DELETE /users/:id/devices/:deviceId` → `{revoked}`; `PUT /users/:id/notify-blocks`
`{blocks:[{type|'*', channel:'all'|'mobile'}]}` → `{blocks}` (`400 cannot_change_own_permissions`, `400 mandatory_type`).
Deactivating (`PATCH is_active:false`), deleting and `reset-password` revoke the user's devices in the same transaction
(`DELETE` answers `devices_revoked`).

## Android app — `/m` (device token, 1.9.0)
Header `Authorization: Bearer <token>` on every request; no cookie, no CSRF header. The token is refused by every other
API route, and `/m` ignores session cookies. `401 invalid_token` when the token is missing, malformed, unknown or
revoked, or the account is inactive, deleted, paused or must change its password; 30 refusals per IP per 15 min → 429.

| Method | Path | Description |
|---|---|---|
| GET | `/m/me` | `{full_name, lang, server_version}` |
| GET | `/m/notifications` | `?after_id=<id>&limit=1..100` (default 20) → `{items:[{id, type, severity, title, body, link, created_at, read}], unread}`. **With `after_id` (0 included): alerts with `id > after_id`, oldest first (ascending id)** — the app pages forward from the last id it has. Without `after_id`: the newest `limit` alerts, newest first. Only types allowed on the phone; a mandatory type kept off the phone appears as `title` «لديك تنبيه جديد» / “You have a new alert”, `body: null`, `link: "/notifications"`; security / system alerts have `body: null`. `title` / `body` in the user's language. A summary that grows while unread keeps its id (announced by the stream) |
| POST | `/m/notifications/:id/read` | → `204`; `404` when not the user's or not shown on the phone |
| GET | `/m/events` | `text/event-stream` (`Cache-Control: no-cache, no-store`, `X-Accel-Buffering: no`): `retry: 10000`; `event: unread` `{"unread":n}` on connect; for each new alert the phone may show `event: notification` `{"id":n}` followed by `event: unread`; a comment line `: hb` every `LIVE_HEARTBEAT_SECONDS` (25 s), on which the device and account are re-checked. One stream per device (a new one replaces the old). The server ends the stream when the device is revoked or the account may no longer be used; reconnecting then gets 401 |
| DELETE | `/m/device` | the phone unpairs itself → `204`; the device is revoked (reason `unpaired`, `revoke:device` + `mobile_device_revoked`), the token stops working at once |

## System — `/system` (permission `cfg`, full scope)
| Method | Path | Description |
|---|---|---|
| GET | `/info` | Version, Node, PostgreSQL version, DB size, last migration, row counts, uptime |
