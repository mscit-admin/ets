# 12 — Handover Checklist & Acceptance · قائمة التسليم ومحضر الاستلام

**Project:** ETS — ERP Tracking System (مركز متابعة إنجاز ERP)
**Version delivered:** ________ (see `HISTORY.md`) **Commit / tag:** ________
**Server:** ________________ **URL:** https://________________

## 1. Deliverables

| # | Item | Delivered (✓) | Notes |
|---|---|---|---|
| 1 | Source code repository (backend, frontend, deploy, tools, reference) | ☐ | |
| 2 | Database creation script and migrations | ☐ | `deploy/db/`, `backend/src/db/migrations/` |
| 3 | Installer wizard and operations scripts | ☐ | `deploy/install.sh`, `answers.example`, `ets-backup`, `ets-restore`, `update.sh` |
| 4 | System installed on the customer server | ☐ | |
| 5 | HTTPS certificate configured | ☐ | type: self-signed / CA / Let's Encrypt |
| 6 | Original tracker data imported | ☐ | |
| 7 | Administrator accounts created (at least 2) | ☐ | |
| 8 | 2FA policy agreed and set | ☐ | off / optional / required |
| 9 | Daily backup running and first backup verified | ☐ | |
| 10 | Off-server backup copy configured | ☐ | |
| 11 | `/etc/ets/ets.env` copy handed to the customer securely | ☐ | |
| 12 | Documentation pack (`docs/handover/`, 13 documents) | ☐ | |
| 13 | Automated tests passed (23/23) | ☐ | |
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
| Certificate private key location | | |

## 3. Known limitations / open items

| # | Item | Agreed action / date |
|---|---|---|
| 1 | Function names exist in Arabic only (the source documents are Arabic). The `name_en` field is ready for translation | |
| 2 | Email notifications (e.g. lockout alerts) are not part of version 0.1.0 | |
| 3 | | |

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
