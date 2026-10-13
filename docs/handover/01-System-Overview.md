# 01 — System Overview

## 1. Purpose

ETS tracks how far an ERP implementation has progressed. The project is split into **departments** (Human
Resources, Finance, Commercial, Infrastructure). Each department has **applications** (30 in total), and each
application has **functions** (513 requirements). For every function the project team records:

- progress (0–100 %) and weight
- test status (not tested / passed with note / passed / failed) and a test note
- notifications status and review status
- whether the item counts in the calculation (items "from experience" are off until enabled)

ETS rolls these values up into application, department and project percentages. It also tracks a separate
**reports** stream per application, and a **schedule** (planned S-curve against actual progress, with SPI).

ETS replaces the original single-file page (`reference/erp-tracker-original.html`). It keeps the same
catalog and calculation rules and adds the following:

| Original page | ETS |
|---|---|
| Data in one browser / embedded in the file | Central PostgreSQL database, shared by all users |
| No real login | Username + password, lockout, optional/required 2FA |
| Roles were advisory only | Roles, permissions and data scope enforced by the server |
| Local activity list | Five server-side logs incl. a full audit trail with old/new values |
| Arabic only | Arabic and English, per-user choice |

## 2. Architecture

```
 Browser (Arabic/English UI, Cairo font)
        │  HTTPS (443)
        ▼
 nginx ── serves the built UI (/opt/ets/frontend/dist)
        │  proxies /api/* to 127.0.0.1:3000
        ▼
 Node.js API (systemd: ets-backend) ── writes logs ──► /var/log/ets/*.log
        │  SQL (localhost:5432)
        ▼
 PostgreSQL database "ets" ── daily pg_dump ──► /var/backups/ets
```

| Layer | Technology | Location |
|---|---|---|
| UI | React 19, Vite build, plain CSS (ERPNext visual language), Cairo font bundled | `frontend/` |
| API | Node.js 22, Express 5, pg, bcryptjs, helmet, pino | `backend/` |
| Database | PostgreSQL 14+ | schema in `backend/src/db/migrations/` |
| Web server | nginx (TLS, static files, reverse proxy, login rate limit) | `deploy/nginx/` |
| Service | systemd unit with sandboxing | `deploy/systemd/` |
| OS | Ubuntu Server 22.04 / 24.04 LTS | — |

The UI has no external runtime dependencies (no CDN, no Google Fonts), so it works on an isolated network.

## 3. Calculation rules

1. **Function %** = progress. When a notification status is set, it is blended in:
   `progress × (1 − n) + N × n`, where N is 100 (working), 50 (working with notes) or 0 (not working), and
   n is the *notifications share* (default 10 %).
2. **Application (functions)** = the weighted average of the *enabled* functions, using the function weights.
3. **Application %** = functions % × (1 − r) + reports % × r. Here r is the *reports share* (default 15 %).
   This only applies to departments with reports; Infrastructure is a requirements department, so it has
   none.
4. **Department %** = the weighted average of its applications, using the application weights. These are
   fixed weights, or in *auto* mode the sum of the application's enabled function weights.
5. **Project %** = the weighted average of the departments, using their total weights.

Users with a limited scope see totals calculated over their own scope only.

## 4. Main features

- Dashboard: overall progress, counters, department cards, the five least-advanced applications and the
  test status distribution.
- Department and application screens with inline editing. Changes save immediately and are audited.
- Bulk set (progress or test status for all enabled functions); custom requirements can be added.
- Weights screen, reports screen, S-curve and schedule with SPI and deviation, and search.
- Users and permissions: 5 roles, 11 permissions, per-user grant/revoke, department/application scope.
- Two-factor authentication: a policy (off / optional / required), per-user or bulk exemption, and admin
  reset.
- Logs viewer: login & security, audit, requests, errors and system. Filters, details and CSV export.
- Settings: 2FA policy, system names, password length, log retention, import/export, system information.
- Import of the original page's data (HTML or JSON) and export in the same format.

## 5. Roles

| Role | Default permissions |
|---|---|
| System Administrator (`admin`) | Everything, always full scope |
| Department Manager (`mgr`) | Progress, weights, testing, enable items, schedule, reports, export, logs (own scope) |
| Application Editor (`ed`) | Progress, testing, reports within assigned applications |
| Tester (`qa`) | Test status and notes only |
| Observer (`obs`) | Read only |
| Project Manager (`pm`) / Technical Project Manager (`tm`) | All departments: progress, weights, testing, items, schedule, reports, export, import, logs, **final approval** of team results |
| Department Team Lead (`lead`) | Own department: progress, testing, items, reports, export, import, logs, **first approval** of the team's results |
| Team Member (`member`) | Own department: progress, testing, reports, and uploading result files for approval |

Permission keys: `pct` progress · `wgt` weights · `tst` test status/notes · `tog` enable/add items ·
`sch` schedule · `rep` reports · `exp` export · `imp` import · `usr` users · `log` logs · `cfg` settings ·
`apv_dept` team-lead approval · `apv_final` project/technical-manager approval.

### Team result files and approvals
Teams that still work in the original HTML page send their exported JSON. In *Imports & approvals* the uploader
chooses **one department** or **Reports**; only that part of the file is compared with the approved data. The
differences wait as a *batch* and change nothing until both the department team lead and the project (or
technical) manager approve it; then they are applied together. Either can reject it with a reason.
