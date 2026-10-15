# 10 — Operations Runbook

## 1. Daily commands

| Task | Command |
|---|---|
| Service status | `systemctl status ets-backend` |
| Start / stop / restart | `sudo systemctl start|stop|restart ets-backend` |
| Health check | `curl -s http://127.0.0.1:3000/api/health` → `{"status":"ok"}` |
| Live application log | `sudo tail -f /var/log/ets/app.log` |
| Errors | `sudo tail -n 50 /var/log/ets/error.log` |
| Service console | `journalctl -u ets-backend -n 100 --no-pager` |
| nginx | `sudo nginx -t && sudo systemctl reload nginx`; logs in `/var/log/nginx/ets.*.log` |
| Database shell | `sudo -u postgres psql ets` |
| Backup now | `sudo ets-backup` |
| Disk usage | `df -h /var; du -sh /var/backups/ets /var/log/ets` |

## 2. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Site does not open | `systemctl status nginx`, `ufw status` | `sudo systemctl restart nginx`; allow 443 |
| "502 Bad Gateway" | `systemctl status ets-backend`, `journalctl -u ets-backend -n 50` | Fix the reported error, then restart. Common causes: DB down, wrong `PGPASSWORD`, missing `APP_SECRET` |
| `APP_SECRET must be set` in the journal | `/etc/ets/ets.env` | Restore `ets.env` from backup. Never invent a new secret on a running system: 2FA keys would become unreadable |
| "Cannot reach the server" in the UI | API health | As above |
| Users are logged out immediately | Is the site served over HTTPS? | Cookies only work over HTTPS: open the `https://` address. Do not set `COOKIE_SECURE=false` on a production server |
| A user is locked | Admin → Users → *Locked* | **Unlock** |
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
backup/restore commands from `/etc/ets/install.conf`, and restarts (checking the port in `ets.env`). Database
migrations run automatically at start-up. Read [HISTORY.md](../../HISTORY.md) for what changed.

Rollback: restore the previous code (`git checkout <previous tag>` + `update.sh`), and if the database was
migrated, `sudo ets-restore <backup taken by update.sh>`.

## 4. Periodic tasks

| Frequency | Task |
|---|---|
| Daily | Glance at *Logs* cards: failed attempts and errors |
| Weekly | Review the *Login & security* log; confirm the backups exist (`ls -lt /var/backups/ets | head`) |
| Monthly | `sudo apt update && sudo apt upgrade`; check disk space; review user accounts (disable leavers) |
| Quarterly | Restore test (doc 08 §6); review the 2FA policy and exemptions |
| Yearly | Renew the certificate if it is not automatic (self-signed: 3 years) |

## 5. Ports and processes

| Process | User | Listens on |
|---|---|---|
| nginx | www-data | 0.0.0.0:80, 0.0.0.0:443 |
| node (ets-backend) | ets | 127.0.0.1:3000 |
| postgres | postgres | 127.0.0.1:5432 |
