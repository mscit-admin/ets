# ETS — ERP Tracking System · مركز متابعة إنجاز ERP

Web system for tracking how far an ERP implementation has progressed, per department, application and
function. It grew out of the single-file tracker page in
[`reference/erp-tracker-original.html`](reference/erp-tracker-original.html), which is now a
multi-user system with a database, a login screen and full logging.

| | |
|---|---|
| **Backend** | Node.js 22.12+ or 24+ + Express 5 (REST API) — `backend/` |
| **Database** | PostgreSQL 14+ (developed on 16) — schema in `backend/src/db/migrations/` |
| **Frontend** | React 19 + Vite, ERPNext-style UI, **Arabic (RTL) and English (LTR)**, **Cairo** font (bundled, works offline) — `frontend/` |
| **Login** | Username + password, progressive sign-in pause and rate limits, optional/required **2FA (TOTP)** with recovery codes; HTTPS only |
| **Logs** | Login & security log, tamper-evident audit trail (old/new values, hash-chained, append-only), HTTP request log, error log, system log — in the DB **and** in `/var/log/ets/*.log`; security logs for administrators only |
| **Target server** | Ubuntu Server 22.04 / 24.04, nginx + systemd — `deploy/` |

## Quick start (development)

```bash
# 1. PostgreSQL database (once); the password is typed at the prompt, never on the command line
sudo -u postgres psql -v db_name=ets -v db_user=ets -f deploy/db/create-database.sql
sudo -u postgres psql -c '\password ets'

# 2. Backend
cd backend
cp .env.example .env            # set APP_SECRET (openssl rand -base64 48), PGPASSWORD, NODE_ENV=development, COOKIE_SECURE=false (plain-http dev only), LOG_DIR=./logs
npm install
npm run setup                   # create tables + load the catalog (4 departments, 30 applications, 513 functions)
npm run create-admin            # first administrator (password asked: 12+ characters)
npm run import-legacy -- ../reference/erp-tracker-original.html   # optional: load the original page's data
npm run dev                     # API on http://127.0.0.1:3000

# 3. Frontend (second terminal)
cd frontend
npm install
npm run dev                     # UI on http://localhost:5173 (proxies /api to :3000)
```

Tests: `cd backend && TEST_DATABASE_URL=postgres://ets:<password>@127.0.0.1/ets_test npm test`
(90 tests; uses a **separate, disposable** database that the tests wipe; the unit tests run without it).
Other scripts: `npm run verify-audit` (audit-trail hash chains), `npm run rotate-app-secret`, `npm run purge-logs`.

## Production install (Ubuntu Server)

```bash
git clone https://github.com/mscit-admin/ets.git && cd ets
sudo bash deploy/install.sh            # add --dry-run to rehearse without changing anything
```

The installer is a wizard. It asks for the domain or IP address, the certificate type (always HTTPS:
self-signed, Let's Encrypt or your own), the HTTPS/HTTP-redirect and internal ports, the database (local or
remote over TLS: host, port, name, user, password, CA), the administrator account, the 2FA policy, the time zone
and the backup retention. It shows a summary to confirm, then installs and configures everything: Node.js,
PostgreSQL, nginx, the sandboxed service, log rotation, encrypted backups (key `/etc/ets/backup.key` — escrow
it), the audit-trail protection in the database and the firewall. Updates: `sudo bash deploy/scripts/update.sh`.
Unattended mode: `--answers deploy/answers.example --yes`. See
[docs/handover/02-Installation-Guide.md](docs/handover/02-Installation-Guide.md).

## Documents

- [STRUCTURE.md](STRUCTURE.md) — what every folder and file is for
- [CHANGELOG.md](CHANGELOG.md) — release notes: every change, fix, upgrade and the operator steps per version
- [docs/handover/](docs/handover/00-Handover-Index.md) — handover pack for the customer (installation, admin
  and user guides, database, security, logging, backup, test plan / UAT, acceptance)
