# 02 — Installation Guide (Ubuntu Server)

## 1. Requirements

| Item | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu Server 22.04 LTS | Ubuntu Server 24.04 LTS |
| CPU / RAM | 2 vCPU / 2 GB | 4 vCPU / 4 GB |
| Disk | 20 GB | 50 GB (logs and backups) |
| Network | Outbound internet during installation (apt, NodeSource, npm) | — |
| Access | SSH with a user that has `sudo` | — |
| Address | A domain name **or** a fixed IP address | Domain name + certificate |

### What to prepare before you start

| You will be asked for | Example | Notes |
|---|---|---|
| Domain name or IP address | `ets.company.ly` or `10.0.0.15` | The address users type in the browser |
| Certificate type | self-signed / Let's Encrypt / your own files / none | Let's Encrypt only with a public domain and port 80 open to the internet |
| Web port (HTTPS) | `443` or any free port such as `8443` | The port users open |
| HTTP port | `80`, or `0` for none | Only redirects to HTTPS. With "none" (plain HTTP) this is the web port itself |
| Internal application port | `3000` | Used only between nginx and the app on the same server |
| Certificate files (if your own) | `/etc/ssl/company/ets.crt` + `.key` | Copy them to the server first |
| E-mail (if Let's Encrypt) | `it@company.ly` | Certificate expiry notices |
| Database location | this server / another PostgreSQL server | For another server, the DBA creates the database and user first (§5) |
| Database host, port, name, user, password | `127.0.0.1`, `5432`, `ets`, `ets`, `********` | Password: 12+ characters, no spaces, quotes, `\`, `$` or `#`. For a local DB, press Enter to generate one |
| Administrator username, full name, e-mail, password | `admin`, … | Password: 10+ characters with letters and digits, not containing the username |
| 2FA policy | off / optional / required | Can be changed later in Settings |
| System names (Arabic / English) | `مركز متابعة إنجاز ERP` | Shown on the login screen |
| Time zone | `Africa/Tripoli` | 2FA codes need a correct clock |
| Days to keep backups | `30` | Daily backup at 01:30 |
| Original tracker file to import | `/home/user/erp-tracker.html` | Optional |
| Configure firewall? | yes / no | Yes = allow only SSH and the chosen web ports |

## 2. Installation with the wizard (recommended)

### Step 1 — copy the project to the server
```bash
# from GitHub
git clone https://github.com/mscit-admin/ets.git && cd ets
# …or from a zip/USB copy:  scp ets.zip user@server:  then  unzip ets.zip && cd ets
```

### Step 2 — (optional) rehearse without changing anything
```bash
bash deploy/install.sh --dry-run
```
The wizard asks all the questions and writes the resulting configuration files to `./ets-dry-run/`, with
secrets masked, so you can review them. Nothing is installed.

### Step 3 — install
```bash
sudo bash deploy/install.sh
```

The wizard asks its questions in five sections: 1) address, 2) certificate and ports, 3) database,
4) administrator, 5) options. Each question shows a default in `[brackets]`; press Enter to accept it.
Answers are checked as you type. A wrong e-mail, a weak password, a port already used by another program, or
two mismatched password entries are refused, and the question is asked again. Passwords are typed twice and
never shown.

Then it shows a **summary** like this and asks `Proceed with these settings? [y/N]`:

```
  Address ............... ets.company.ly (domain)
  Web address ........... https://ets.company.ly:8443
  Certificate ........... selfsigned  (/etc/ssl/certs/ets-selfsigned.crt)
  HTTPS port ............ 8443
  HTTP port ............. 80 (redirects to HTTPS)
  Internal app port ..... 3000 (localhost only)
  Database .............. local · 127.0.0.1:5432 · db "ets" · user "ets" · password entered
  Administrator ......... admin (System Administrator) · password ********
  2FA policy ............ required
  ...
```

Nothing is changed before you answer `y`. The installation then runs 13 steps:

| # | Step |
|---|---|
| 1 | Installs packages: nginx, PostgreSQL (or only its client for a remote DB), Node.js 22, ufw, certbot if needed |
| 2 | Sets the time zone and enables clock synchronisation (NTP) |
| 3 | Creates the system user `ets` and the directories `/opt/ets`, `/etc/ets`, `/var/log/ets`, `/var/backups/ets` |
| 4 | Copies the application to `/opt/ets` |
| 5 | Creates the database and its user with the name, user and password you gave (local), or tests the connection (remote) |
| 6 | Writes `/etc/ets/ets.env` (mode 640) with a new random `APP_SECRET` (an existing one is kept) |
| 7 | Installs backend packages and builds the frontend |
| 8 | Creates the tables and catalog, the administrator, the 2FA policy and system names, and imports the tracker file if given |
| 9 | Creates or obtains the certificate |
| 10 | Configures nginx on your ports |
| 11 | Installs the `ets-backend` service, log rotation, the daily backup and the `ets-backup` / `ets-restore` commands |
| 12 | Configures the firewall: SSH (its real port is detected) and your web ports |
| 13 | Checks the service and the web server, and takes the first backup |

It ends with:

```
  ETS is installed
  Open:            https://ets.company.ly:8443
  Administrator:   admin  (the password you entered)
  Configuration:   /etc/ets/ets.env        ← copy it to a safe place (contains APP_SECRET)
  ...
```

If the database password was generated, it is shown once on the screen and stored in `/etc/ets/ets.env`.
A full log of the installation, without passwords, is kept in `/var/log/ets-install.log` (root only).

### Step 4 — first login
Open the address shown, sign in with the administrator, and (if the 2FA policy is *required*) scan the QR
code with Google/Microsoft Authenticator. Continue with [09-Test-Plan-and-UAT.md](09-Test-Plan-and-UAT.md).

## 3. Unattended installation (answers file)

```bash
cp deploy/answers.example /root/ets-answers
nano /root/ets-answers                         # fill in address, ports, DB, admin…
sudo bash deploy/install.sh --answers /root/ets-answers --yes
shred -u /root/ets-answers                     # it contains passwords
```

Any value missing from the file is asked interactively, unless `--yes` is used, in which case a missing
required value stops the installer. Every answer can also be given as an environment variable with the same
name (`ETS_ADDRESS`, `ETS_TLS`, `ETS_HTTPS_PORT`, `ETS_DB_PASSWORD`, `ETS_ADMIN_PASSWORD`, …).

## 4. Running the wizard again

`sudo bash deploy/install.sh` can be run again at any time to change the address, ports, certificate or
database password, or to repair an installation. The previous answers are offered as defaults (from
`/etc/ets/install.conf`, which holds no secrets).

- The database and all data are **kept**.
- `APP_SECRET` is **kept**, so users' 2FA keeps working.
- For a local database, press Enter at the password question to keep the current one.
- The administrator's password is set to the one you type. This also recovers a forgotten admin password.
- The previous `ets.env` is saved as `ets.env.bak-<date>`.

## 5. Using an existing (remote) PostgreSQL server

Ask the DBA to run this on the database server (as a superuser), with the names and password you will give
the wizard:

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_name=ets -v db_user=ets -v db_password='<password>' \
     -f create-database.sql          # file: deploy/db/create-database.sql
```

Also make sure that PostgreSQL accepts connections from the ETS server (`listen_addresses` in
`postgresql.conf`, plus a `host ets ets <ets-server-ip>/32 scram-sha-256` line in `pg_hba.conf`), and that the
firewall between the two servers allows the DB port. In the wizard choose **"On another, existing PostgreSQL
server"**. It tests the connection and the `citext` extension before installing anything.

## 6. Configuration reference (`/etc/ets/ets.env`)

The wizard writes this file. Edit it by hand only if needed, then run `sudo systemctl restart ets-backend`.

| Variable | Meaning |
|---|---|
| `APP_SECRET` | Encrypts 2FA secrets. **Never change after go-live** |
| `PORT` | Internal application port (must match nginx; change it through the wizard) |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Database connection |
| `SESSION_TTL_HOURS` (12), `SESSION_IDLE_MINUTES` (60) | Session length and idle timeout |
| `COOKIE_SECURE` | `true` with HTTPS. `false` is refused with `NODE_ENV=production` unless `ALLOW_INSECURE_COOKIES=true` (lab only) |
| `MAX_FAILED_LOGINS` (5), `LOCK_MINUTES` (15), `LOCKOUT_RESET_MINUTES` (60) | Failures before sign-in to an account pauses, longest pause, quiet time after which the failure count restarts |
| `LOGIN_RATE_LIMIT` (30), `API_RATE_LIMIT` (600) | Password / 2FA checks per IP per 15 min (and failures per account); any API request per IP per minute |
| `BCRYPT_ROUNDS` (12) | Password hashing cost, 10–14 |
| `LOG_DIR`, `LOG_LEVEL`, `ACCESS_LOG_DB` | Logging |
| `ETS_BACKUP_DIR`, `ETS_BACKUP_KEEP_DAYS` | Backups |

## 7. Verifying the installation

```bash
systemctl status ets-backend nginx            # both active (running)
curl -s http://127.0.0.1:3000/api/health      # {"status":"ok",...}  (use your internal port)
sudo ufw status                               # SSH and your web ports allowed
ls -l /var/log/ets/ /var/backups/ets/
```

## 8. Common installation problems

| Message | Cause / fix |
|---|---|
| `port N is already used by 'apache2'` | Another web server uses the port. Choose another port, or stop it: `sudo systemctl disable --now apache2` |
| `cannot connect to the database` | Remote DB: check host/port/user/password, `pg_hba.conf`, the firewall |
| `the 'citext' extension is missing` | The DBA runs `CREATE EXTENSION citext;` in the database |
| `Let's Encrypt failed` | The domain does not point to this server, or port 80 is not reachable from the internet. Use a self-signed certificate or your own instead |
| Browser warning "not secure" | Normal with a self-signed certificate: import `/etc/ssl/certs/ets-selfsigned.crt` into the client PCs' trusted roots |
| Signed out immediately after login | You use `http://` while the certificate type is HTTPS: open the `https://` address |
