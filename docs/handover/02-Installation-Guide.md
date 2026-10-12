# 02 — Installation Guide (Ubuntu Server)

## 1. Requirements

| Item | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu Server 22.04 LTS | Ubuntu Server 24.04 LTS |
| CPU / RAM | 2 vCPU / 2 GB | 4 vCPU / 4 GB |
| Disk | 20 GB | 50 GB (logs and 30 days of backups) |
| Network | Outbound internet during installation (apt, NodeSource, npm) | — |
| Access | A user with `sudo` | — |
| Name | A DNS name or a fixed IP address | DNS name + certificate |

Ports: **443** (HTTPS) and **80** (redirects to HTTPS) open to users, and **22** for administration.
PostgreSQL (5432) and the API (3000) listen on localhost only.

## 2. Automatic installation (recommended)

```bash
# copy the repository to the server (git clone, or scp/USB of the release archive)
cd ~ && git clone <repository-url> ets && cd ets
sudo bash deploy/install.sh
```

The installer asks three questions:

1. **Server name or IP** used in the address bar (for example `ets.company.ly` or `10.0.0.15`).
2. **Certificate**:
   - `1` self-signed, for an internal network. Browsers warn once; for trusted internal use, import
     `/etc/ssl/certs/ets-selfsigned.crt` into the client machines.
   - `2` Let's Encrypt, for a public DNS name reachable from the internet on port 80.
   - `3` existing certificate files issued by the organisation.
3. **First administrator** username, full name and password (at least 10 characters, letters and digits).

To install without prompts:
`sudo ETS_DOMAIN=ets.company.ly ETS_HTTPS=selfsigned ETS_ADMIN_USER=admin bash deploy/install.sh`
(the administrator password is still asked).

What it does, in order:

1. Installs nginx, PostgreSQL, Node.js 22 (NodeSource), ufw and logrotate.
2. Creates the system user `ets` and the directories `/opt/ets`, `/etc/ets`, `/var/log/ets` and
   `/var/backups/ets`.
3. Copies the application to `/opt/ets`.
4. Creates the PostgreSQL role and database `ets` with a random password
   (`deploy/db/create-database.sql`).
5. Writes `/etc/ets/ets.env` with a random `APP_SECRET` and the database password.
6. Installs backend packages and builds the frontend.
7. Runs the migrations and loads the catalog (4 departments, 30 applications, 513 functions).
8. Creates the first administrator.
9. Configures the certificate, the nginx site and the systemd service `ets-backend`.
10. Installs log rotation, the daily backup (01:30) and the `ets-backup` / `ets-restore` commands.
11. Enables the firewall (OpenSSH and Nginx Full).

At the end it prints `ETS is running: https://<server>`.

> **Important:** copy `/etc/ets/ets.env` to a safe place. `APP_SECRET` encrypts users' 2FA keys; without it,
> restored users must enrol in 2FA again.

## 3. Loading the existing tracker data (optional)

To bring in the progress recorded in the original single-file page, use either of these:

- UI: **Settings → Data → Import from the original tracker file**, then choose the HTML or JSON file.
- CLI:
  ```bash
  cd /opt/ets/backend
  sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env node scripts/import-legacy.js /path/to/erp-tracker.html
  ```

## 4. Manual installation (reference)

```bash
sudo apt install -y nginx postgresql curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
sudo useradd --system --home /opt/ets --shell /usr/sbin/nologin ets
sudo mkdir -p /opt/ets /etc/ets /var/log/ets && sudo chown ets:ets /var/log/ets
sudo rsync -a ./ /opt/ets/
sudo -u postgres psql -v ets_password="'<strong-password>'" -f /opt/ets/deploy/db/create-database.sql
sudo cp /opt/ets/backend/.env.example /etc/ets/ets.env    # edit APP_SECRET, PGPASSWORD
cd /opt/ets/backend && sudo npm ci --omit=dev
cd /opt/ets/frontend && sudo npm ci && sudo npm run build
cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env sh -c 'node src/db/migrate.js && node src/db/seed.js'
sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env node scripts/create-admin.js
sudo cp /opt/ets/deploy/systemd/ets-backend.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now ets-backend
# nginx: copy deploy/nginx/ets.conf, replace __SERVER_NAME__, __SSL_CERT__, __SSL_KEY__
```

## 5. Configuration reference (`/etc/ets/ets.env`)

| Variable | Default | Meaning |
|---|---|---|
| `APP_SECRET` | (generated) | Encrypts 2FA secrets. **Never change after go-live.** |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | 127.0.0.1, 5432, ets, ets | Database connection |
| `HOST`, `PORT` | 127.0.0.1, 3000 | API listen address (behind nginx) |
| `SESSION_TTL_HOURS` | 12 | Maximum session length |
| `SESSION_IDLE_MINUTES` | 60 | Signed out after this much inactivity |
| `COOKIE_SECURE` | true | Cookies only over HTTPS. Set `false` only for plain-HTTP testing |
| `MAX_FAILED_LOGINS`, `LOCK_MINUTES` | 5, 15 | Account lockout |
| `BCRYPT_ROUNDS` | 12 | Password hashing cost |
| `LOG_DIR`, `LOG_LEVEL` | /var/log/ets, info | File logs |
| `ACCESS_LOG_DB` | true | Also store every HTTP request in the database |

Apply changes with `sudo systemctl restart ets-backend`.

## 6. Verifying the installation

```bash
systemctl status ets-backend          # active (running)
curl -s http://127.0.0.1:3000/api/health   # {"status":"ok",...}
sudo nginx -t
ls -l /var/log/ets/
```

Then open `https://<server>`, sign in as the administrator, and follow the acceptance tests in
[09-Test-Plan-and-UAT.md](09-Test-Plan-and-UAT.md).
