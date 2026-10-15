# 02 — Installation Guide (Ubuntu Server)

## 1. Requirements

| Item | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu Server 22.04 LTS | Ubuntu Server 24.04 LTS |
| CPU / RAM | 2 vCPU / 2 GB | 4 vCPU / 4 GB |
| Disk | 20 GB | 50 GB (logs and backups) |
| Network | Outbound internet during installation (apt, NodeSource, npm) | — |
| Node.js | 22.12+ or 24+ (installed by the wizard when missing or older) | — |
| Access | SSH with a user that has `sudo` | — |
| Address | A domain name **or** a fixed IP address | Domain name + certificate |

### What to prepare before you start

| You will be asked for | Example | Notes |
|---|---|---|
| Domain name or IP address | `ets.company.ly` or `10.0.0.15` | The address users type in the browser |
| Certificate type | self-signed / Let's Encrypt / your own files | Always HTTPS (plain HTTP is not offered). Let's Encrypt only with a public domain and port 80 open to the internet; your organisation's CA is best for an internal server |
| Web port (HTTPS) | `443` or any free port such as `8443` | The port users open |
| HTTP port | `80`, or `0` for none | Only redirects to HTTPS |
| Internal application port | `3000` | Used only between nginx and the app on the same server |
| Certificate files (if your own) | `/etc/ssl/company/ets.crt` + `.key` | Copy them to the server first |
| E-mail (if Let's Encrypt) | `it@company.ly` | Certificate expiry notices |
| Database location | this server / another PostgreSQL server | For another server, the DBA creates the database and user first (§5) |
| Database host, port, name, user, password | `127.0.0.1`, `5432`, `ets`, `ets`, `********` | Password: 12+ printable characters, no spaces, quotes, `\`, `$` or `#`, not an example value. For a local DB, press Enter to generate one |
| Remote database only: CA certificate | `/root/db-ca.crt` | The connection is always encrypted (TLS). With the CA file of the DB server's certificate it is also verified (`verify-full`) |
| Administrator username, full name, e-mail, password | `admin`, … | Password: 12+ characters (max 72 bytes) with letters and digits, not containing the username, not a common or example word |
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

Nothing is changed before you answer `y`. The installation then runs 12 steps:

| # | Step |
|---|---|
| 1 | Installs packages: nginx, PostgreSQL (or only its client for a remote DB), ufw, certbot if needed, and Node.js 22 from the NodeSource apt repository (its signing key is checked against a pinned fingerprint; no `curl \| bash`). **Before the first install, confirm the pinned fingerprint** (`NODESOURCE_FPR` in `deploy/scripts/deploy-lib.sh`) against the key NodeSource publishes — see 12 §1 item 5a |
| 2 | Sets the time zone and enables clock synchronisation (NTP) |
| 3 | Creates the system user `ets` and the directories `/opt/ets`, `/etc/ets`, `/var/log/ets`, `/var/backups/ets` |
| 4 | Builds the application as the unprivileged user `ets-build` (packages installed with `npm ci --ignore-scripts`) and copies only the runtime files to `/opt/ets` (no docs, tests or reference data; owned by root, not world-readable except the built web pages) |
| 5 | Creates the database and its user (local; the password is sent as a SCRAM verifier, never on a command line; other users may not connect or create objects), or tests the TLS connection (remote) |
| 6 | Writes `/etc/ets/ets.env` (mode 640) with a new random `APP_SECRET` (an existing one is kept) |
| 7 | Creates the tables (local database: migrations as the PostgreSQL superuser through `ets-log-protect`, then the **audit-trail protection**: the change history and sign-in log become read / append-only for the application role — 07 §3), the catalog, the administrator, the 2FA policy and system names, and imports the tracker file if given |
| 8 | Creates or obtains the certificate |
| 9 | Configures nginx on your ports (TLS 1.2/1.3, security headers) |
| 10 | Installs the `ets-backend` service (sandboxed), log rotation, the daily **encrypted** backup with its key `/etc/ets/backup.key`, and the `ets-backup` / `ets-restore` / `ets-log-protect` commands |
| 11 | Configures the firewall: SSH (its real port is detected) and your web ports |
| 12 | Checks the service and the web server, and takes the first backup |

It ends with:

```
  ETS is installed
  Open:            https://ets.company.ly:8443
  Administrator:   admin  (the password you entered)
  Audit trail:     protected in the database (read/append only for ets) · sudo ets-log-protect status
  Configuration:   /etc/ets/ets.env        ← copy it to a safe place (contains APP_SECRET)
  Backup key:      /etc/ets/backup.key     ← copy it to a safe place, NOT with the backups (needed to restore)
  ...
```

**Escrow the backup key and `ets.env` now** ([08 §2](08-Backup-and-Recovery.md)): without them the encrypted
backups cannot be restored and users' 2FA cannot be read after a restore.

If the database password was generated, it is shown once on the screen and stored in `/etc/ets/ets.env`.
A full log of the installation, without passwords, is kept in `/var/log/ets-install.log` (root only).

### Step 4 — first login
Open the address shown, sign in with the administrator, and (if the 2FA policy is *required*) scan the QR
code with Google/Microsoft Authenticator. Continue with [09-Test-Plan-and-UAT.md](09-Test-Plan-and-UAT.md).

## 3. Unattended installation (answers file)

```bash
install -m 600 deploy/answers.example /root/ets-answers
nano /root/ets-answers                         # fill in address, ports, DB, admin…
sudo bash deploy/install.sh --answers /root/ets-answers --yes
shred -u /root/ets-answers                     # it contains passwords
```

The file is read as plain `KEY=value` lines (it is never run as a script); put values with spaces in double
quotes. The example passwords are placeholders and are refused. An administrator password given in a file
or environment variable is temporary: it must be changed at the first sign-in.

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
- The previous `ets.env` is saved as `ets.env.bak-<date>` (root only; the 5 newest are kept).

## 5. Using an existing (remote) PostgreSQL server

Ask the DBA to run this on the database server (as a superuser), with the names you will give the wizard,
then to set the password at the prompt (never on the command line — it would be visible in the process list
and the shell history):

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_name=ets -v db_user=ets \
     -f create-database.sql          # file: deploy/db/create-database.sql
sudo -u postgres psql -c '\password ets'
```

The connection between ETS and the database is always encrypted. The DBA enables TLS on the server
(`ssl = on` with a server certificate in `postgresql.conf`), lets the ETS server in with a **`hostssl`** line
(not `host`) in `pg_hba.conf`, e.g. `hostssl ets ets <ets-server-ip>/32 scram-sha-256`, sets `listen_addresses`,
and opens the DB port in the firewall between the two servers. Ask for the CA certificate that signed the
server certificate: given to the wizard, the server is also verified (`PGSSLMODE=verify-full`, the host name
must match the certificate); without it the traffic is encrypted but the server is not verified
(`PGSSLMODE=require`). In the wizard choose **"On another, existing PostgreSQL server"**. It tests the
encrypted connection and the `citext` extension before installing anything.

**Audit-trail protection on a remote server.** The installer cannot assume superuser rights on the DBA's server,
so it runs the migrations as the application role and prints whether the log tables are protected. After the
first installation (the tables exist then), the DBA protects them once as a superuser — from the ETS server
with `sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full sslrootcert=/etc/ets/db-ca.crt' ets-log-protect apply`,
or with `psql -v db_user=ets -v log_owner=ets_log_owner -d ets -f deploy/db/harden-log-tables.sql`
([07 §3](07-Logging-and-Audit.md)). Later, a migration that has to change the log tables stops the update
without changing anything until the DBA applies it the same way (`… ets-log-protect migrate`).

## 6. Configuration reference (`/etc/ets/ets.env`)

The wizard writes this file. Edit it by hand only if needed, then run `sudo systemctl restart ets-backend`.

| Variable | Meaning |
|---|---|
| `APP_SECRET` | Encrypts 2FA secrets. **Never change after go-live** |
| `PORT` | Internal application port (must match nginx; change it through the wizard) |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Database connection |
| `SESSION_TTL_HOURS` (12), `SESSION_IDLE_MINUTES` (60) | Session length and idle timeout |
| `COOKIE_SECURE` | `true` (always written by the installer): the session cookie is `__Host-ets_sid` and works only over HTTPS. `false` is refused with `NODE_ENV=production` unless `ALLOW_INSECURE_COOKIES=true` (lab only, never on a real server) |
| `MAX_FAILED_LOGINS` (5), `LOCK_MINUTES` (15), `LOCKOUT_RESET_MINUTES` (60) | Failures before sign-in to an account pauses, longest pause, quiet time after which the failure count restarts |
| `LOGIN_RATE_LIMIT` (30), `API_RATE_LIMIT` (600) | Password / 2FA checks per IP per 15 min (and failures per account); any API request per IP per minute |
| `BCRYPT_ROUNDS` (12) | Password hashing cost, 10–14 |
| `TRUST_PROXY` (`loopback`) | Which proxy may set the client IP (`X-Forwarded-For`): nginx on the same server. Never `true` — see §9 for a load balancer |
| `LOG_DIR`, `LOG_LEVEL`, `ACCESS_LOG_DB` | Logging |
| `ETS_BACKUP_DIR`, `ETS_BACKUP_KEEP_DAYS` | Backups |

Also written when needed: `PGSSLMODE` (`require` / `verify-ca` / `verify-full`) and `PGSSLROOTCERT`
(`/etc/ets/db-ca.crt`) for a remote database — the application refuses to start with an unencrypted
connection to a database on another machine; `ETS_BACKUP_KEY` (`/etc/ets/backup.key`, the backup encryption
key); `APP_SECRET_OLD` only while `APP_SECRET` is being rotated ([06-Security.md](06-Security.md)).
`APP_SECRET` placeholders (such as the one in `backend/.env.example`) and short or low-variety values are refused.

## 7. Verifying the installation

```bash
systemctl status ets-backend nginx            # both active (running)
curl -s http://127.0.0.1:3000/api/health      # {"status":"ok"}  (use your internal port; no version is shown)
sudo ets-log-protect status                   # local database: "protected"
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
| Browser warning "not secure" | Normal with a self-signed certificate. Compare the SHA-256 fingerprint shown at the end of the installation and accept the certificate for this site only. Do **not** add it to the client PCs' trusted root certificates; for a warning-free setup use a certificate from your organisation's CA (certificate type "your own files") |
| Signed out immediately after login | You use `http://`: the session cookie only works over HTTPS — open the `https://` address |
| `the NodeSource signing key has fingerprint …, expected …` | The key downloaded from NodeSource differs from the pinned one. Do not bypass it: confirm the new key with NodeSource, or install Node.js 22.12+ yourself and run the installer again |
| `must be owner of table audit_log` (remote database) | A migration needs the log owner's rights; nothing was changed. The DBA runs `ets-log-protect migrate` with `ETS_SU_CONNINFO` (§5) |
| `this installation uses plain HTTP, which is no longer supported` (update) | Run `sudo bash deploy/install.sh` once and choose a certificate |

## 9. Behind a load balancer, reverse proxy or NAT (client IP addresses)

ETS sees the client's IP address through nginx on the same server (`TRUST_PROXY=loopback`; nginx passes
`$remote_addr` in `X-Real-IP` / `X-Forwarded-For`). The IP is used for the login rate limits (nginx 10 / min,
API `LOGIN_RATE_LIMIT` per 15 min, `API_RATE_LIMIT` per min) and in the logs.

- **If a load balancer or reverse proxy sits in front of nginx**, every request seems to come from the
  balancer: all users share **one** rate-limit bucket (a few wrong passwords from anyone can slow everyone's
  sign-in) and the logs show the balancer's address. Tell nginx which addresses are your balancers, so that it
  takes the client IP from the header they add. Put this in its own file — `update.sh` re-creates the ETS site
  files from templates, a file in `conf.d` stays:

  ```nginx
  # /etc/nginx/conf.d/ets-realip.conf   (http context; needs the realip module, included in Ubuntu's nginx)
  set_real_ip_from 10.0.0.5;        # the load balancer — list ONLY your balancers' addresses / subnets
  # set_real_ip_from 10.0.0.6;
  real_ip_header   X-Forwarded-For; # or the header your balancer sets (e.g. X-Real-IP)
  real_ip_recursive on;
  ```

  Then `sudo nginx -t && sudo systemctl reload nginx`. Never list a whole network that clients are in, and do
  **not** change `TRUST_PROXY` to `true` in `ets.env`: either would let a client choose the IP address it
  appears to have (and so escape the rate limits and falsify the logs). Check: sign in from two PCs and look
  at *Logs → Login & security* — each shows its own IP.
- **If many users reach ETS through one NAT / web proxy** (all requests really come from one address), no
  setting can tell them apart. The per-account limit and the sign-in pause still protect each account; if the
  shared limits are reached in normal use (`rate_limited` events from that one IP, users told to wait), raise
  `LOGIN_RATE_LIMIT` / `API_RATE_LIMIT` in `ets.env` moderately and restart the service.
- The API's counters are kept in memory and start again when the service restarts (for example after an
  update); the per-account sign-in pause is stored in the database and survives restarts.
