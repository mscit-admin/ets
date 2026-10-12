# 08 — Backup & Recovery

## 1. What must be protected

| Item | Location | Why |
|---|---|---|
| Database | PostgreSQL `ets` | All data: users, progress, logs |
| Configuration | `/etc/ets/ets.env` | `APP_SECRET` (decrypts 2FA keys) and the DB password |
| TLS certificate | `/etc/ssl/...` or `/etc/letsencrypt/` | HTTPS |
| Application code | `/opt/ets` | Can be reinstalled from the repository |

## 2. Automatic backups

- `/etc/cron.d/ets-backup` runs `/usr/local/bin/ets-backup` **every day at 01:30**.
- Output: `/var/backups/ets/ets-YYYYmmdd-HHMM.dump` (pg_dump custom format, compressed), plus
  `/var/backups/ets/ets.env.backup`.
- Backups older than **30 days** are deleted (`ETS_BACKUP_KEEP_DAYS`).
- Each run is logged in `/var/log/ets/backup.log` and in the system log (`event = backup`).

Manual backup: `sudo ets-backup`

**Copy the backups off the server.** A backup kept on the same disk does not protect against losing the
server. Example (daily, to a backup host):

```bash
# /etc/cron.d/ets-offsite
0 3 * * * root rsync -a /var/backups/ets/ backup@backup-host:/srv/backups/ets/
```

## 3. Restore

```bash
ls -lt /var/backups/ets/*.dump | head          # choose a file
sudo ets-restore /var/backups/ets/ets-20261012-0130.dump
# type YES; the service is stopped, the database replaced, the service started
```

Then check: sign in, open the dashboard, look at *Logs → System* (`restore` event).

## 4. Disaster recovery (new server)

1. Install Ubuntu Server and copy the repository.
2. **Before** running the installer, restore the configuration:
   `sudo mkdir -p /etc/ets && sudo cp ets.env.backup /etc/ets/ets.env && sudo chmod 640 /etc/ets/ets.env`
3. Create the database role with the **same password** as in `ets.env`:
   `sudo -u postgres psql -v ets_password="'<PGPASSWORD from ets.env>'" -f deploy/db/create-database.sql`
4. Run `sudo bash deploy/install.sh`. It keeps the existing role and `ets.env`. When it asks for an
   administrator, give any name; the restore replaces it.
5. `sudo ets-restore <latest dump>`

Users keep their passwords and 2FA, because `APP_SECRET` is the same.

## 5. Targets

| Measure | Value with the default setup |
|---|---|
| RPO (maximum data loss) | 24 h (daily backup). Run backups more often from cron if needed |
| RTO (time to restore) | about 30–60 min on a new server, about 5 min on the same server |

## 6. Restore test (recommended every 3 months)

```bash
sudo -u postgres createdb ets_restore_test
sudo -u postgres pg_restore -d ets_restore_test /var/backups/ets/<latest>.dump
sudo -u postgres psql -d ets_restore_test -c "SELECT count(*) FROM functions; SELECT max(ts) FROM audit_log;"
sudo -u postgres dropdb ets_restore_test
```
