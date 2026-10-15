# 08 — Backup & Recovery

## 1. What must be protected

| Item | Location | Why |
|---|---|---|
| Database | PostgreSQL `ets` | All data: users, progress, logs |
| Configuration | `/etc/ets/ets.env` | `APP_SECRET` (decrypts 2FA keys) and the DB password |
| Backup key | `/etc/ets/backup.key` | Decrypts the backups — without it they cannot be restored |
| TLS certificate | `/etc/ssl/...` or `/etc/letsencrypt/` | HTTPS |
| Application code | `/opt/ets` | Can be reinstalled from the repository |

## 2. Automatic backups

- `/etc/cron.d/ets-backup` runs `/usr/local/bin/ets-backup` **every day at 01:30**.
- Output: `/var/backups/ets/ets-YYYYmmdd-HHMMSS.dump.gpg` — a pg_dump (custom format) **encrypted with gpg
  (AES-256, tamper-evident)** using the backup key `/etc/ets/backup.key` — and `<file>.sha256` (checksum).
  Files are root-only (600) in a root-only directory.
- The configuration (`ets.env`) is **not** copied next to the dumps any more. A copy left there by an older
  version (`ets.env.backup`) is deleted, and older unencrypted `*.dump` files are encrypted, at the next run.
- Backups older than **30 days** are deleted (`ETS_BACKUP_KEEP_DAYS`).
- Each run is logged in `/var/log/ets-backup.log` (root-only, rotated monthly) and in the system log
  (`event = backup`).
- With a remote database the dump travels over TLS (the `PGSSLMODE` / `PGSSLROOTCERT` of `ets.env`).

Manual backup: `sudo ets-backup`

**Copy the backups off the server.** A backup kept on the same disk does not protect against losing the
server. The files are encrypted, so the backup host never sees the data. Example (daily, to a backup host):

```bash
# /etc/cron.d/ets-offsite
0 3 * * * root rsync -a /var/backups/ets/ backup@backup-host:/srv/backups/ets/
```

### Key escrow — do this once, right after the installation

The backups are useless without the backup key, and a restored database needs the same `APP_SECRET` for
users' 2FA. Keep both **away from the backup files** (never on the backup host):

```bash
sudo cat /etc/ets/backup.key      # 64 characters
sudo cat /etc/ets/ets.env         # APP_SECRET and the DB password
```

Store them in the organisation's password manager / vault, or print them and keep the sheet in a sealed
envelope in a safe; ideally two people know where. Record the date. If the backup key is ever exposed:
create a new one (`sudo sh -c 'umask 077; openssl rand -base64 48 > /etc/ets/backup.key'`), escrow it, take a
new backup, and delete the backups made with the old key once they are no longer needed.

## 3. Restore

```bash
sudo ls -lt /var/backups/ets/ | head                           # choose a .dump.gpg file
sudo ets-restore /var/backups/ets/ets-20261012-013000.dump.gpg
# type YES
```

`ets-restore`:

1. checks the file against its `.sha256` checksum, decrypts it with `/etc/ets/backup.key` (a damaged or
   altered file is refused) and checks it is a valid dump — nothing is changed yet;
2. takes a fresh backup of the current data (so a restore can itself be undone);
3. stops the service, restores in **one transaction** (any error → nothing is changed), starts the service.

The change history and sign-in log are protected in the database (owned by `ets_log_owner`, see
[07 §3](07-Logging-and-Audit.md)), so the application role alone cannot replace them. For a local database
`ets-restore` therefore restores through `ets-log-protect restore`: one PostgreSQL-superuser transaction in which
the restore runs as the application role and the protection is applied again before `COMMIT`. Then it applies the
migrations of the installed version (a backup from an older version is brought up to date) and checks
`ets-log-protect status`. For a **remote** database whose log tables the DBA has protected, `ets-restore` stops
before changing anything unless the DBA provides a superuser connection:
`sudo ETS_SU_CONNINFO='host=<db server> user=<superuser> sslmode=verify-full' ets-restore <file>`.

Then check: sign in, open the dashboard, look at *Logs → System* (`restore` event). Older, unencrypted
`.dump` files can still be restored (a warning is shown).

## 4. Disaster recovery (new server)

1. Install Ubuntu Server and copy the repository.
2. **Before** running the installer, put back the escrowed configuration and backup key:
   ```bash
   sudo mkdir -p /etc/ets
   sudo nano /etc/ets/ets.env        # paste the saved file;  then: sudo chmod 640 /etc/ets/ets.env
   sudo sh -c 'umask 077; nano /etc/ets/backup.key'   # paste the saved key (one line)
   ```
3. Run `sudo bash deploy/install.sh`. Answer with the same database name and user as before, and press
   Enter at the database password question to keep the one in `ets.env`. The existing `APP_SECRET` and
   backup key are kept automatically. For the administrator, give any password; the restore replaces the users.
4. Copy the latest `.dump.gpg` (and `.sha256`) back to `/var/backups/ets/` and run `sudo ets-restore <file>`.

Users keep their passwords and 2FA, because `APP_SECRET` is the same.

## 5. Targets

| Measure | Value with the default setup |
|---|---|
| RPO (maximum data loss) | 24 h (daily backup). Run backups more often from cron if needed |
| RTO (time to restore) | about 30–60 min on a new server, about 5 min on the same server |

## 6. Restore test (recommended every 3 months)

```bash
F=$(sudo ls -1t /var/backups/ets/*.dump.gpg | head -1)
sudo sh -c "cd /var/backups/ets && sha256sum -c $(basename "$F").sha256"
sudo gpg --batch --pinentry-mode loopback --passphrase-file /etc/ets/backup.key -d "$F" > /tmp/ets-test.dump
sudo chown postgres /tmp/ets-test.dump
sudo -u postgres createdb ets_restore_test
sudo -u postgres pg_restore --no-owner --no-acl -d ets_restore_test /tmp/ets-test.dump
sudo -u postgres psql -d ets_restore_test -c "SELECT count(*) FROM functions; SELECT max(ts) FROM audit_log;"
sudo -u postgres dropdb ets_restore_test; sudo shred -u /tmp/ets-test.dump
```

Also check once a year that the escrowed backup key and `ets.env` can be found and match the server
(`sudo sha256sum /etc/ets/backup.key` against the escrowed copy).
