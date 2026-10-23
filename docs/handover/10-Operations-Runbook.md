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
| Backup now | Settings → «النسخ الاحتياطي» → «نسخ احتياطي الآن», or `sudo ets-backup` (database + configuration bundle + the day's logs, encrypted; offsite copies; log in `/var/log/ets-backup.log`, offsite in `/var/log/ets-offsite.log`) |
| Backup schedule | `systemctl list-timers 'ets-backup*'` (hourly backup, weekly test restore); `systemctl status ets-backup.service` (last run) |
| Backup agent (web UI jobs) | `systemctl status ets-backup-agent.timer ets-backup-agent.path`; `sudo tail -n 50 /var/log/ets-backup-agent.log`; run one cycle by hand: `sudo ets-backup-agent run` |
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
| Backup key | `/etc/ets/backup.key` (root, 600; id in `backup.key.id`). Without it no backup can be restored. Escrow it once and confirm it in Settings → «النسخ الاحتياطي» (08 §6; the banner comes back yearly and after a key change); check yearly: `sudo sha256sum /etc/ets/backup.key` against the escrowed copy. New key / passphrase: Settings → «تعيين عبارة سرية جديدة» (old backups still need the old key) |
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

## 1b. Notifications and phones (1.9.0)

| Task | Command / action |
|---|---|
| Is the periodic check running? | *Logs → System*: a `notify_scan` row with the jobs and duration (every day from the summary hour, and whenever a security check found something); journald: `journalctl -u ets-backend \| grep notify` (failures are logged `notify: scan job failed`). Several API processes are fine: one runs the check at a time (advisory lock) |
| Users get no alerts | Settings → «الإشعارات»: «تشغيل التنبيهات», the policy cell of their role, work days / hour / time zone; their profile (muted types, summaries off) and their user page (blocks). Alerts only reach users with the permission and scope (03 §3a) |
| «لا توجد نسخة احتياطية» (S6) | `ets-backup` writes a `backup` row only when it succeeds (a `backup_failed` row names the step otherwise): `sudo tail -n 50 /var/log/ets-backup.log`, `systemctl list-timers 'ets-backup*'`, `systemctl status ets-backup.service`; free space `df -h /var/backups`; run `sudo ets-backup` by hand (08 §3) |
| «النسخة الخارجية متأخرة/فشلت» (S9) | The error is in the alert, in Settings → «النسخ الاحتياطي» and in `/var/log/ets-offsite.log`. SSH: key authorised on the backup server, host key, `rrsync` path (08 §4a); NAS: `mountpoint /mnt/ets-backup` — remount (`sudo mount -a`), nothing was written while unmounted (08 §4b); cloud: credentials / bucket, `sudo rclone --config /etc/ets/rclone.conf lsf <remote>` (08 §4c). «اختبار الاتصال» after a fix; the next run copies the backlog |
| «فشل الاسترجاع التجريبي» (S10) | `sudo tail -n 80 /var/log/ets-backup-verify.log` (decryption, temporary database rights, migrations, verify-audit); run `sudo ets-backup-verify` or «تحقق الآن». Cannot create `ets_restore_check`: 08 §8. A failed verify-audit on a backup is a security incident (07 §3) |
| «استرجاع من نسخة احتياطية» (S11) | Expected after a restore. Unexpected: check *Logs → Changes* (`restore_start`, `restore` rows: who, which backup, items) and `/var/log/ets-backup-agent.log` |
| Phones: server address and certificate in the QR | `PUBLIC_BASE_URL` and `TLS_CERT_SHA256` in `/etc/ets/ets.env`, filled by `install.sh` / `update.sh` from the nginx address and certificate (`openssl x509 -in <cert> -noout -fingerprint -sha256`, colons removed; empty for Let's Encrypt). After **renewing or replacing the certificate** run `update.sh` (or set `TLS_CERT_SHA256` by hand and `systemctl restart ets-backend`): paired phones that pin the old fingerprint must be paired again |
| Phones from outside the building (VPN) | The phones reach the server only inside the network or **over the organisation's VPN** — never open the HTTPS port to the internet. Nothing else is needed on the server: `/api/m/*` goes through nginx like the web API, and `/api/m/events` streams like `/api/events` (`proxy_buffering off`, 1 h timeouts). If the phones use another name / address over the VPN than the browsers, set `PUBLIC_BASE_URL` to it by hand (`update.sh` keeps a value that is already set); with a self-signed certificate the name must be in the certificate (`subjectAltName`) |
| A phone is lost | The user revokes it in *Profile → «أجهزتي»*, or an administrator on the user's page (*Users → user → «الأجهزة المرتبطة»*). Deactivating the account or resetting its password also revokes every phone |
| List / revoke phones in SQL | `SELECT d.id, u.username, d.name, d.last_seen_at FROM mobile_devices d JOIN users u ON u.id=d.user_id WHERE d.revoked_at IS NULL;` — revoke through the screens (audited) rather than SQL |

## 2. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Site does not open | `systemctl status nginx`, `ufw status` | `sudo systemctl restart nginx`; allow 443 |
| "502 Bad Gateway" | `systemctl status ets-backend`, `journalctl -u ets-backend -n 50` | Fix the reported error, then restart. Common causes: DB down, wrong `PGPASSWORD`, missing `APP_SECRET` |
| `APP_SECRET` missing / refused in the journal | `/etc/ets/ets.env` | Restore APP_SECRET from a backup: Settings → «النسخ الاحتياطي» → «استرجاع من نسخة» → only «مفتاح النظام وإعدادات الخادم (ets.env)» (08 §9), or decrypt the newest `ets-config-*.tar.gpg` by hand (`gpg -d … \| tar -x`). Never invent a new secret on a running system: 2FA keys would become unreadable |
| "Cannot reach the server" in the UI | API health | As above |
| Dashboard badge shows "Every 30 s" instead of "Live" (live updates not reaching the browser) | `curl -sN -b <cookie> https://<site>/api/events` should print `event: ready` at once; nginx snippet has `location = /api/events` with `proxy_buffering off` | Re-deploy the nginx snippet (`deploy/nginx/ets-app.conf.tpl`), `sudo nginx -t && sudo systemctl reload nginx`. A proxy / load balancer in front of nginx must not buffer `text/event-stream` and must allow ≥ 60 s idle (heartbeat every 25 s). The screens keep working by reloading every 30 s meanwhile |
| Users are logged out immediately | Is the site served over HTTPS? | The session cookie `__Host-ets_sid` only works over HTTPS: open the `https://` address |
| A user's correct password is refused | Admin → Users → *Locked*; *Logs → Login & security* (`login_while_locked`) | Sign-in is paused after failures (§1a): wait or **Unlock** |
| "Too many attempts — wait N seconds" for everyone in one office | `rate_limited` events all from one IP | Users share one IP (NAT / proxy / load balancer): see [02 §9](02-Installation-Guide.md) |
| The service does not start after an update: `must be owner of table audit_log` | `journalctl -u ets-backend -n 50` | A migration needs the log owner's rights. Local database: `sudo ets-log-protect migrate`, then `sudo systemctl start ets-backend`. Remote database: the DBA runs it with `ETS_SU_CONNINFO` ([07 §3](07-Logging-and-Audit.md)) |
| The service does not start: `PGSSLMODE` / TLS error | journal | A remote database must accept TLS (`hostssl`, `ssl = on`); see 02 §5 |
| The service does not start: `APP_SECRET` too short / placeholder | journal | Restore the escrowed `ets.env`; never invent a new secret on a running system |
| All admins are locked out / lost 2FA | — | `cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets node scripts/create-admin.js --username admin --reset-2fa` |
| A user's 2FA codes are always "invalid" | Server clock: `timedatectl` | Enable NTP: `sudo timedatectl set-ntp true`. Codes depend on correct time |
| Disk full | `df -h` | Lower log retention, check `/var/backups/ets` (shorten the backup tiers in Settings → «النسخ الاحتياطي»; old `pre-restore-*` copies can be deleted once a restore is confirmed), then `sudo logrotate -f /etc/logrotate.d/ets` |
| A restore from the web UI failed | `/var/lib/ets/restore/status.json` (state `rolled_back` = the system is back as before; `rollback_failed` = act now) | Read `/var/log/ets-backup-agent.log`. After `rollback_failed`: the safety backup named in the status file (`safety.dump`, and the files in `/var/backups/ets/pre-restore-<time>/`) — restore it with `sudo ets-restore --yes /var/backups/ets/<safety dump>` and copy the files back; `sudo rm /var/lib/ets/restore/active` if the maintenance page stays; `sudo systemctl start ets-backend` |
| Maintenance page shown but no restore runs | `ls /var/lib/ets/restore/active` | The agent stopped during a restore: check `/var/log/ets-backup-agent.log` and the status file, then remove the flag |
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
certificate) and a Node.js older than 22.12. Read [CHANGELOG.md](../../CHANGELOG.md) for what changed — its **Upgrade notes** list what to do or check for each version.

**Upgrading to 1.0.0 — check afterwards:** users of scoped roles without a scope see nothing (03 §1, system-log
event `scope_fail_closed`); everyone signs in again once (new cookie name); backups are now `.dump.gpg` and the
new key `/etc/ets/backup.key` must be escrowed (the update prints a reminder); PM / TM / managers no longer see
the security logs; `sudo ets-log-protect status` → protected.

Rollback: restore the previous code (`git checkout <previous tag>` + `update.sh`), and if the database was
migrated, `sudo ets-restore <backup taken by update.sh>`.

**Upgrading to 1.12.0 — check afterwards:** `systemctl list-timers 'ets-backup*'` shows the hourly backup and the
weekly test restore and `/etc/cron.d/ets-backup` is gone; `/etc/ets/backup.conf` exists (imported into the database);
Settings → «النسخ الاحتياطي» shows the agent working; confirm the escrow of the backup key there; set up the offsite
destinations (08 §4); the first hourly run keeps the existing dailies (08 §3).

## 3a. Promote a version to production (1.12.19 Phase 2, 1.12.20 Phase 3 — feature-complete)

The one-button test→production pipeline. Design and the full operator setup are in
[13 — Release Promotion](13-Release-Promotion-Design.md) (§8a for keys, deploy keys, unit install/enable and the
staging dry-run rehearsal that MUST pass before first real use). Two ROOT agents do all privileged work; the API
(user `ets`) only records a signed intent — exactly the backup trust split.

**Normal promotion (happy path):**

1. On the **test** server UI: Settings → «الترقية والنشر», pick the released version (newer than production), review
   the what-changed / Upgrade notes, press Promote, pass password + OTP re-auth and type the version to confirm.
2. `ets-release-publisher` (test, root) signs the manifest, pushes the signed tag `v<version>` and
   `deploy/production-release.json(+.sig)`, and the row goes to `publishing`. Watch `/var/log/ets-release-publisher.log`.
3. `ets-deploy-agent` (production, root) fetches, verifies (signature, ancestor, newer, fresh/nonce, prev-match),
   takes a **pre-deploy backup**, checks out the tag, runs `update.sh`, and **health-gates** `/api/health`. Watch
   `/var/log/ets-deploy-agent.log`.
4. On success the prod agent signs + pushes `production-status.json`; the publisher pulls it and the test UI goes
   green (`succeeded`). An **S-REL (S12) alert** goes to every admin (1.12.20, Phase 3): started / succeeded are
   informational; **failed / rolled_back are critical** and go to the phone.

**If the deploy fails the extended health gate** (app `/api/health`, the DB reachable, migrations applied; the exact
failing check is recorded in the row `result.health_summary` / `health_checks` and shown on the Release screen):

* **No migration ran + `AUTO_ROLLBACK=on` + a previous commit exists** → the agent auto code-rolls-back (checkout prev
  commit + `update.sh`), ends `rolled_back`. No DB action needed.
* **`AUTO_ROLLBACK=off` (or no previous commit)** → the agent STOPS at `failed`; inspect, then use the break-glass
  rollback below or redeploy manually.
* **A migration ran** → the agent STOPS at `failed`, records `backup_ref`, `needs_db_restore=true` and the exact
  `ets-restore` command; the Release screen shows the **«استرجاع قاعدة البيانات»** panel. Follow **§3b**.

Automatic DB rollback is deliberately **never** done (ETS migrations do not run in reverse): the only reliable DB
rollback is restore-from-backup, and it is **manual** by design (13 §5.3).

**Manual rollback (break-glass):** the «تراجع» Rollback button on the test UI (enabled when the last deploy is
`failed`) records a `rollback` intent to the previous version and drives a **code-rollback** promotion; the §5.3 DB
caveat is shown before confirming. A rollback shows in the promotion history like any other promotion.

**Diagnostics:** `systemctl status ets-release-publisher.timer ets-deploy-agent.timer`; the two agent logs;
`ets-deploy-agent dry-run` on production verifies the current signal without deploying (reports `already_current`
when prod already runs it); a rejected signal is logged with its reason (`unknown_signer`, `non_ancestor`,
`downgrade`, `stale`, `replayed_nonce`, `prev_mismatch`) and nothing is deployed. The read-only `GET /api/release/status`
(admin) shows the deployed version/commit, last deploy time and the agent heartbeat/staleness on either server.

## 3b. Restore the database after a failed migration-deploy (1.12.20)

When a production deploy fails the health gate **after a migration ran**, the schema is ahead of the old code, so a
code rollback alone is unsafe — restore the pre-deploy backup. The Release screen's «استرجاع قاعدة البيانات» panel
names the `backup_ref` and the exact command. On the **production** server, as the operator (root):

```bash
# 1. the backup_ref is in the failed promotion's result / the «استرجاع قاعدة البيانات» panel / production-status.json
sudo ETS_ENV_FILE=/etc/ets/ets.env /usr/local/sbin/ets-deploy-agent dry-run   # confirm current state first
# 2. roll the CODE back to the version production ran before (prev_version / prev_commit on the row)
sudo git -C /opt/ets-src checkout <prev tag or prev_commit>
# 3. restore the pre-deploy DB (empties + reloads the schema in one transaction) — DATA WRITTEN SINCE THE BACKUP IS LOST
sudo ets-restore <backup_ref>
# 4. redeploy the previous code and confirm health
cd /opt/ets-src && sudo bash deploy/scripts/update.sh
curl -fsS http://127.0.0.1:${PORT:-3000}/api/health
```

The pre-deploy backup is taken immediately before the deploy, so the lost-writes window is seconds (13 §5.3). After a
clean restore, record the outcome and, if the version is to be retried, fix the migration first (expand/contract, 13
§5.3) before promoting again.

## 4. Periodic tasks

| Frequency | Task |
|---|---|
| Daily | Glance at *Logs* cards: failed attempts and errors; the administrators' bell (security / system alerts) |
| Every 15 min (automatic) | Notification checks in the API (`notify_scan`): security, backups (age, destinations, test restore); daily from the summary hour: hash chains, idle phones, alert retention |
| Hourly (automatic) | `ets-backup.timer`: backup + offsite copies; the API checks the backup age and each destination every 15 min (S6, S9) |
| Weekly | Review the *Login & security* log (administrators); Settings → «النسخ الاحتياطي»: every destination green, last test restore passed (automatic, Friday 03:00); run *Logs → Verify log integrity* and keep the chain heads off the server |
| Monthly | `sudo apt update && sudo apt upgrade`; check disk space; review user accounts (disable leavers) |
| Quarterly | Restore drill: restore the newest backup on a test server with the escrowed key (08 §11, `ets-restore-server --dry-run` at least); review the 2FA policy and exemptions |
| Yearly | Renew the certificate if it is not automatic (self-signed: 825 days — `update.sh` replaces it within 30 days of expiry); check the escrowed backup key and confirm it again in Settings → «النسخ الاحتياطي» (08 §6) |

## 5. Ports and processes

| Process | User | Listens on |
|---|---|---|
| nginx | www-data | the HTTPS port chosen at install (443 by default) and the optional HTTP redirect port (80) |
| node (ets-backend) | ets | 127.0.0.1:3000 (internal port, `PORT` in `ets.env`) |
| postgres (local database) | postgres | 127.0.0.1:5432 (the installer warns if it listens elsewhere) |
