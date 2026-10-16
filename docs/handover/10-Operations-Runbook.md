# 10 — Operations Runbook

## 1. Daily commands

| Task | Command |
|---|---|
| Service status | `systemctl status ets-backend` |
| Start / stop / restart | `sudo systemctl start|stop|restart ets-backend` |
| Health check | `curl -s http://127.0.0.1:3000/api/health` → `{"status":"ok"}` (use the internal port from `ets.env`; no version is shown — the version is in *Settings → System information*) |
| Live application log | `sudo tail -f /var/log/ets/app.log` |
| Errors | `sudo tail -n 50 /var/log/ets/error.log` |
| Service console | `journalctl -u ets-backend -n 100 --no-pager` |
| nginx | `sudo nginx -t && sudo systemctl reload nginx`; logs in `/var/log/nginx/ets.*.log` |
| Database shell | `sudo -u postgres psql ets` |
| Backup now | `sudo ets-backup` (encrypted `.dump.gpg`, log in `/var/log/ets-backup.log`) |
| Audit-trail checks | `sudo ets-log-protect status` (exit 0 = protected); chain check: see §1a |
| Disk usage | `df -h /var; du -sh /var/backups/ets /var/log/ets` |

## 1a. Security operations

Command-line tools run from the backend directory as the service user:

```bash
cd /opt/ets/backend
E="sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets"
```

| Task | Command / action |
|---|---|
| Verify the audit trail (hash chains) | `$E node scripts/verify-audit.js` → `OK` per table and the chain heads; exit code 0 = intact, 2 = broken (`--json` for details). Also *Logs → Verify log integrity* (administrators). Copy a head line now and then to a ticket / e-mail outside the server |
| A chain is reported broken (`log_chain_broken` alert) | Do not "repair" rows. Keep the report (`--json`), compare with the last chain head kept outside the server and the latest backups, find who had database access, and treat it as a security incident ([07 §3](07-Logging-and-Audit.md)). Meanwhile the daily purge deletes nothing and records `purge_skipped` (alert) every day. Once the incident is handled and the evidence kept, let the purge continue with `$E node scripts/purge-logs.js --acknowledge-broken-chain` (recorded as `purge_acknowledge` with your OS user; [07 §5](07-Logging-and-Audit.md)) |
| Audit-trail protection | `sudo ets-log-protect status`; re-apply: `sudo ets-log-protect apply` (idempotent; also done by every `update.sh`). Remote database: the DBA does it ([07 §3](07-Logging-and-Audit.md)) |
| Apply the log retention now | `$E node scripts/purge-logs.js` (recorded as `cli:<OS user>`; never deletes audit rows younger than 365 days). Exit 2 = a hash chain is broken and nothing was deleted (see next row) |
| Backup key | `/etc/ets/backup.key` (root, 600). Without it no backup can be restored. Escrow it once (08 §2) and check yearly: `sudo sha256sum /etc/ets/backup.key` against the escrowed copy. New key after exposure: 08 §2 |
| Rotate `APP_SECRET` (suspected leak of `ets.env`) | Procedure in [06 §6a](06-Security.md): `APP_SECRET_OLD` + new `APP_SECRET`, restart, `$E node scripts/rotate-app-secret.js`, remove `APP_SECRET_OLD`, restart, escrow the new `ets.env` |
| Create / reset an administrator | `$E node scripts/create-admin.js --username admin2 --name "Second Admin"` — the password is asked at the prompt (12+ characters); that account's sessions end. `--reset-2fa` also removes its authenticator; `--must-change-password` forces a change at the next sign-in |

**Sign-in pauses ("locked" accounts).** After `MAX_FAILED_LOGINS` (5) failed password / 2FA / recovery-code
checks, sign-in to the account pauses for 1 minute, then 2, 4, 8 … up to `LOCK_MINUTES` (15) with each further
failure. The pause **ends by itself**; the failure count restarts after `LOCKOUT_RESET_MINUTES` (60) without
failures, or after a complete sign-in (password and 2FA). During a pause the login screen shows the same
"incorrect username or password" message as for a wrong password (it never says the account is locked), so
users may report "my correct password does not work". Check *Users* (status *Locked* until `locked_until`) or
*Logs → Login & security* (`account_locked`, `login_while_locked`), then either let the user wait a few minutes
or use **Unlock** (clears the count and the pause; logged `account_unlocked_by_admin`). Many failures for one
account from different IPs, or `rate_limited` events, point to an attack rather than a forgetful user.

## 2. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Site does not open | `systemctl status nginx`, `ufw status` | `sudo systemctl restart nginx`; allow 443 |
| "502 Bad Gateway" | `systemctl status ets-backend`, `journalctl -u ets-backend -n 50` | Fix the reported error, then restart. Common causes: DB down, wrong `PGPASSWORD`, missing `APP_SECRET` |
| `APP_SECRET` missing / refused in the journal | `/etc/ets/ets.env` | Restore `ets.env` from the escrowed copy (08 §2; it is not in the backups). Never invent a new secret on a running system: 2FA keys would become unreadable |
| "Cannot reach the server" in the UI | API health | As above |
| Users are logged out immediately | Is the site served over HTTPS? | The session cookie `__Host-ets_sid` only works over HTTPS: open the `https://` address |
| A user's correct password is refused | Admin → Users → *Locked*; *Logs → Login & security* (`login_while_locked`) | Sign-in is paused after failures (§1a): wait or **Unlock** |
| "Too many attempts — wait N seconds" for everyone in one office | `rate_limited` events all from one IP | Users share one IP (NAT / proxy / load balancer): see [02 §9](02-Installation-Guide.md) |
| The service does not start after an update: `must be owner of table audit_log` | `journalctl -u ets-backend -n 50` | A migration needs the log owner's rights. Local database: `sudo ets-log-protect migrate`, then `sudo systemctl start ets-backend`. Remote database: the DBA runs it with `ETS_SU_CONNINFO` ([07 §3](07-Logging-and-Audit.md)) |
| The service does not start: `PGSSLMODE` / TLS error | journal | A remote database must accept TLS (`hostssl`, `ssl = on`); see 02 §5 |
| The service does not start: `APP_SECRET` too short / placeholder | journal | Restore the escrowed `ets.env`; never invent a new secret on a running system |
| All admins are locked out / lost 2FA | — | `cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets node scripts/create-admin.js --username admin --reset-2fa` |
| A user's 2FA codes are always "invalid" | Server clock: `timedatectl` | Enable NTP: `sudo timedatectl set-ntp true`. Codes depend on correct time |
| Disk full | `df -h` | Lower log retention, check `/var/backups/ets`, then `sudo logrotate -f /etc/logrotate.d/ets` |
| PostgreSQL down | `systemctl status postgresql` | `sudo systemctl start postgresql`; check `/var/log/postgresql/` |

## 3. Updating to a new version

```bash
cd ~/ets && git pull            # or unpack the new release
sudo bash deploy/scripts/update.sh
```

`update.sh` takes an encrypted backup, builds the new version as the unprivileged `ets-build` user (and runs
`npm audit`), copies it, re-deploys the service unit, nginx site and security headers, log rotation and the
backup/restore/`ets-log-protect` commands from `/etc/ets/install.conf`, stops the service, applies the database
migrations (local database: as the PostgreSQL superuser through `ets-log-protect`, then protects the audit trail
again; remote database: as the application role), and starts the new version (checking the port in `ets.env`).
It refuses an installation still configured for plain HTTP (run `deploy/install.sh` once and choose a
certificate) and a Node.js older than 22.12. Read [HISTORY.md](../../HISTORY.md) for what changed.

**Upgrading to 1.0.0 — check afterwards:** users of scoped roles without a scope see nothing (03 §1, system-log
event `scope_fail_closed`); everyone signs in again once (new cookie name); backups are now `.dump.gpg` and the
new key `/etc/ets/backup.key` must be escrowed (the update prints a reminder); PM / TM / managers no longer see
the security logs; `sudo ets-log-protect status` → protected.

Rollback: restore the previous code (`git checkout <previous tag>` + `update.sh`), and if the database was
migrated, `sudo ets-restore <backup taken by update.sh>`.

## 4. Periodic tasks

| Frequency | Task |
|---|---|
| Daily | Glance at *Logs* cards: failed attempts and errors |
| Weekly | Review the *Login & security* log (administrators); confirm the backups exist (`sudo ls -lt /var/backups/ets \| head`); run *Logs → Verify log integrity* and keep the chain heads off the server |
| Monthly | `sudo apt update && sudo apt upgrade`; check disk space; review user accounts (disable leavers) |
| Quarterly | Restore test (doc 08 §6); review the 2FA policy and exemptions |
| Yearly | Renew the certificate if it is not automatic (self-signed: 825 days — `update.sh` replaces it within 30 days of expiry); check the escrowed `ets.env` and backup key (08 §6) |

## 5. Ports and processes

| Process | User | Listens on |
|---|---|---|
| nginx | www-data | the HTTPS port chosen at install (443 by default) and the optional HTTP redirect port (80) |
| node (ets-backend) | ets | 127.0.0.1:3000 (internal port, `PORT` in `ets.env`) |
| postgres (local database) | postgres | 127.0.0.1:5432 (the installer warns if it listens elsewhere) |
