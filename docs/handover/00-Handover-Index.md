# ETS — Handover Pack · حزمة التسليم

**System:** ETS — ERP Tracking System (مركز متابعة إنجاز ERP)
**Version:** 1.9.0 (release notes: [CHANGELOG.md](../../CHANGELOG.md))
**Date:** 2026-10-19

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
| 13 | [Functions Catalog (AR, Excel)](13-Functions-Catalog.xlsx) | All parties | قائمة الوظائف الـ513 حسب الموديول (الإدارة) والتطبيق، مع الرمز والمصدر والمرجع وحالة المورّد، وورقة ملخص |

## Delivered items

1. Source code (this repository): `backend/`, `frontend/`, `deploy/`, `tools/`, `reference/`.
2. Database creation script `deploy/db/create-database.sql`, audit-trail protection `deploy/db/harden-log-tables.sql`
   and migrations `backend/src/db/migrations/`.
3. Schema reference `deploy/db/schema-reference.sql`.
4. Installer `deploy/install.sh` and operations scripts (`ets-backup`, `ets-restore`, `ets-log-protect`, `update.sh`).
5. This documentation pack, and the release notes [CHANGELOG.md](../../CHANGELOG.md) (every version, what changed
   and what to check when updating).
6. Automated tests (`backend/test/`, 90 tests).
