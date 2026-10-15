# 12 — Handover Checklist & Acceptance · قائمة التسليم ومحضر الاستلام

**Project:** ETS — ERP Tracking System (مركز متابعة إنجاز ERP)
**Version delivered:** ________ (see `HISTORY.md`) **Commit / tag:** ________
**Server:** ________________ **URL:** https://________________

## 1. Deliverables

| # | Item | Delivered (✓) | Notes |
|---|---|---|---|
| 1 | Source code repository (backend, frontend, deploy, tools, reference) | ☐ | |
| 2 | Database creation script and migrations | ☐ | `deploy/db/`, `backend/src/db/migrations/` |
| 3 | Installer wizard and operations scripts | ☐ | `deploy/install.sh`, `answers.example`, `ets-backup`, `ets-restore`, `ets-log-protect`, `update.sh` |
| 4 | System installed on the customer server | ☐ | |
| 5 | HTTPS certificate configured (no plain-HTTP mode) | ☐ | type: self-signed / CA / Let's Encrypt. Self-signed: SHA-256 fingerprint given to users: ________ |
| 5a | **NodeSource signing-key fingerprint verified before the first install** | ☐ | `NODESOURCE_FPR=6F71F525282841EEDAF851B42F59B5F99B1BE0B4` in `deploy/scripts/deploy-lib.sh` was **not** verified by the supplier against NodeSource's published key (the key could not be downloaded in the build environment). It **must be checked** against the key published by NodeSource (https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key and NodeSource's documentation, e.g. `curl -fsSL <url> \| gpg --show-keys`) before the first install; if it differs, the installer stops before installing Node.js — correct the value only after confirming the new key with NodeSource. Checked by / date: |
| 6 | Original tracker data imported | ☐ | |
| 7 | Administrator accounts created (at least 2) | ☐ | |
| 8 | 2FA policy agreed and set | ☐ | off / optional / required |
| 9 | Daily **encrypted** backup running and first backup verified (`.dump.gpg` + `.sha256`, restore test doc 08 §6) | ☐ | |
| 10 | Off-server backup copy configured | ☐ | |
| 11 | `/etc/ets/ets.env` copy handed to the customer securely | ☐ | |
| 11a | **Backup key escrow**: `/etc/ets/backup.key` stored by the customer away from the backups (vault / sealed envelope, two people know where); `sha256sum` recorded | ☐ | sha256 (first 12 chars): ________ |
| 11b | Audit-trail protection active: `sudo ets-log-protect status` → protected (remote DB: DBA ran `harden-log-tables.sql`, 07 §3); `verify-audit` OK | ☐ | |
| 11c | Scope of every non-full-scope user set (no «بلا نطاق / No scope» left) | ☐ | |
| 11d | Network path agreed: load balancer / NAT in front of nginx? If yes, `real_ip` configured (02 §9) | ☐ | |
| 12 | Documentation pack (`docs/handover/`, 13 documents and the functions catalog) | ☐ | |
| 13 | Automated tests passed (90/90) | ☐ | |
| 14 | UAT executed and signed (doc 09) | ☐ | |
| 15 | Administrator training given | ☐ | date: |
| 16 | End-user training given | ☐ | date: |

## 2. Credentials and secrets handed over

Hand these over in person or through a secure channel. **Never write passwords in this document.**

| Secret | Holder | Handed over (date / initials) |
|---|---|---|
| Server SSH access | | |
| ETS administrator account(s) | | |
| `/etc/ets/ets.env` (APP_SECRET, DB password) | | |
| Backup key `/etc/ets/backup.key` (kept apart from the backups) | | |
| Certificate private key location | | |

## 3. Known limitations / open items

| # | Item | Agreed action / date |
|---|---|---|
| 1 | Function names exist in Arabic only (the source documents are Arabic). The `name_en` field is ready for translation | |
| 2 | Email notifications (e.g. lockout alerts) are not part of version 1.0.0; alert events are marked `"alert":true` in the logs for a SIEM (07 §4) | |
| 3 | Release signatures: `update.sh` does not verify a signature or checksum of the release copy (none is published); copy releases only from the agreed repository | |
| 4 | Remote database: the audit-trail protection and any migration that changes the log tables need the DBA (07 §3) | |
| 5 | | |

## 4. Acceptance

The customer confirms that the system was delivered and installed as described, that the UAT in document 09
was executed, and that the result is:

☐ **Accepted** ☐ **Accepted with the open items listed above** ☐ **Not accepted** (reasons attached)

| | Supplier · المورّد | Customer · العميل |
|---|---|---|
| Name · الاسم | | |
| Position · الصفة | | |
| Signature · التوقيع | | |
| Date · التاريخ | | |
