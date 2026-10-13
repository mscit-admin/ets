# ETS — Handover Pack · حزمة التسليم

**System:** ETS — ERP Tracking System (مركز متابعة إنجاز ERP)
**Version:** 0.5.0 (see [HISTORY.md](../../HISTORY.md))
**Date:** 2026-10-12

This folder contains every document delivered to the customer with the system. Documents marked
**(AR)** are in Arabic for end users; technical documents are in English.

| # | Document | Audience | Purpose |
|---|---|---|---|
| 01 | [System Overview](01-System-Overview.md) | Management, IT | What the system does, architecture, components, features |
| 02 | [Installation Guide](02-Installation-Guide.md) | IT / system administrator | Install on Ubuntu Server step by step |
| 03 | [Administrator Guide](03-Administrator-Guide.md) | System administrator | Users, roles, permissions, 2FA, settings, logs |
| 04 | [User Guide (AR)](04-User-Guide-AR.md) | All users | دليل المستخدم: الدخول، التحقق بخطوتين، تحديث الإنجاز |
| 05 | [Database Design](05-Database-Design.md) | DBA, IT | Tables, relationships, codes, migrations |
| 06 | [Security](06-Security.md) | IT security | Authentication, 2FA, sessions, hardening, recommendations |
| 07 | [Logging & Audit](07-Logging-and-Audit.md) | IT security, auditors | All log types, fields, events, retention |
| 08 | [Backup & Recovery](08-Backup-and-Recovery.md) | IT | Backup schedule, restore, disaster recovery |
| 09 | [Test Plan & UAT](09-Test-Plan-and-UAT.md) | Customer testers | Test cases with expected results and sign-off columns |
| 10 | [Operations Runbook](10-Operations-Runbook.md) | IT operations | Start/stop, health checks, troubleshooting, updates |
| 11 | [API Reference](11-API-Reference.md) | Developers | REST endpoints |
| 12 | [Handover Checklist & Acceptance](12-Handover-Checklist-and-Acceptance.md) | Both parties | What is delivered, acceptance form |

## Delivered items

1. Source code (this repository): `backend/`, `frontend/`, `deploy/`, `tools/`, `reference/`.
2. Database creation script `deploy/db/create-database.sql` and migrations `backend/src/db/migrations/`.
3. Schema reference `deploy/db/schema-reference.sql`.
4. Installer `deploy/install.sh` and operations scripts (`ets-backup`, `ets-restore`, `update.sh`).
5. This documentation pack.
6. Automated tests (`backend/test/`).
