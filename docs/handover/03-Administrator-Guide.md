# 03 — Administrator Guide

The screens described here are visible to users with the matching permission. A System Administrator sees
all of them. The menu is under **Administration** in the sidebar.

## 1. Users (Administration → Users) — permission `usr`

### Create a user
1. **New user** → fill in the full name, username (Latin letters, digits, `. _ -`), email (optional),
   language and an initial password.
2. Keep **Must change password at first login** ticked. The user then picks their own password.
3. Choose a **role** (see the table below).
4. Optionally adjust **permissions**. Each permission follows the role, or can be explicitly **granted** or
   **revoked** for this user.
5. Optionally restrict the **scope**: tick departments (all their applications) and/or single
   applications. **Leave everything unticked for full scope.** Administrators always have full scope.
6. **Save**.

| Role | Typical user |
|---|---|
| System Administrator | IT administrator of ETS |
| Department Manager | Head of a department's ERP rollout (scope: their department) |
| Application Editor | Functional lead for some applications (scope: those applications) |
| Tester | QA staff recording test results |
| Observer | Management / auditors (read only) |

### Actions on a user
| Button | Effect | Logged as |
|---|---|---|
| Reset password | Sets a new password, unlocks the account, signs out all sessions, forces a change at next login (optional) | `password_reset_by_admin` |
| Unlink authenticator | Removes the user's 2FA app and recovery codes. If 2FA is required, they enrol again at next login | `mfa_reset_by_admin` |
| Unlock | Clears a lockout caused by failed attempts | `account_unlocked_by_admin` |
| End sessions | Signs the user out everywhere | `sessions_revoked_by_admin` |
| Active (untick) | Disables the account and ends its sessions. Users are never deleted, so their history stays | audit `update user` |

Safety rules enforced by the server:
- At least one active System Administrator must always exist.
- You cannot change your own role or disable yourself.

## 1b. Team result files and the approval cycle

Roles for this cycle: **Project Manager** / **Technical Project Manager** (full scope, final approval),
**Department Team Lead** (scope = the department, first approval), **Team Member** (scope = the department,
uploads files). Give leads and members their department in *Scope*.

1. *Imports & approvals* → **Import results file** → choose the JSON (or HTML) the team sent.
2. **Choose what to import** (mandatory): a department, or **التقارير**. Each option shows how many values
   differ and the effect on the department's percentage. Only the chosen part is imported.
3. **Submit for approval** → a pending batch. Approved results do not change yet; a notice appears on the
   dashboard and a red badge in the sidebar for the people who must sign.
4. The **team lead** of that department approves (or rejects with a reason).
5. The **project manager or technical manager** approves (or rejects). It must be a different person.
6. After both approvals the changes are applied at once and the batch shows "Approved and applied". If a value
   was changed in ETS after the upload, that one value is skipped and marked ✗.

A new file for the same department replaces a batch still waiting ("Replaced by a newer file").
The *Audit trail* records every step (`import_submit`, `import_approve_lead`, `import_approve_final`,
`import_apply`, `import_reject`). *Settings → Data → Full import without approval* is only for the first
migration (it loads everything at once and needs the settings permission).

## 2. Two-factor authentication (2FA)

ETS uses time-based one-time codes (TOTP). These work with Google Authenticator, Microsoft Authenticator,
Authy, FreeOTP and similar apps.

### Policy (Settings → Two-step verification)
| Policy | Behaviour |
|---|---|
| **Disabled for all users** | Nobody is asked for a code, even users who enrolled before. Use for an emergency or when 2FA is not wanted |
| **Optional** | Users may enable it from *My account*; those who did are asked for a code |
| **Required** | Every user must use it. Users who have not enrolled are shown the QR code at their next login and cannot continue without enrolling |

### Turning 2FA off for some users only
- One user: open the user → tick **Exempt from two-step verification** → Save.
- Several users: **Users** list → tick the users → **Exempt selected** (or **Remove exemption for
  selected**).
- Everyone: **Exempt everyone from 2FA** / **Remove exemption for everyone**.

An exempt user is never asked for a code, whatever the policy. Exemptions are logged
(`mfa_exempted_by_admin`, `mfa_exemption_removed`).

### Lost phone
The user signs in with one of their **recovery codes** (link *Use a recovery code instead*). Each code
works once. If they have no codes left, an administrator uses **Unlink authenticator** on that user.

## 3. Settings (Administration → Settings) — permission `cfg`

| Section | Setting | Default |
|---|---|---|
| Two-step verification | Policy; issuer name shown in the app | Optional; `ETS` |
| General | System name (Arabic / English) on the login screen and navbar; default language | — ; Arabic |
| Security | Minimum password length | 10 |
| Log retention | Days to keep login/audit/error/system logs; days to keep the request log | 365; 90 |
| Data | Export all tracker data (JSON); import the original tracker file (HTML/JSON) | — |
| System information | Version, PostgreSQL version, database size, uptime | — |

The calculation parameters (weighting mode, notifications share, reports share) are on the **Weights**
screen.

### Branding (Settings → «الهوية البصرية»)
| Image | Where it appears | Format / limit |
|---|---|---|
| System logo | Top bar and login screen | Square PNG/WebP, transparent background, ≤ 1 MB |
| Favicon | Browser tab | Square PNG or ICO, 64×64 or larger, ≤ 512 KB (if empty, the logo is used) |
| Login background | Behind the login form (darkened slightly) | Landscape JPEG/WebP, e.g. 1920×1080, ≤ 3 MB |

**Upload image** replaces it immediately for everyone; **Restore default** returns to the built-in icon / plain
background. Images are stored in the database and included in backups. SVG files are not accepted.

## 4. Logs (Administration → Logs) — permission `log`

Tabs: **Login & security**, **Audit trail**, **Request log**, **Errors**, **System**.
Filter by text, date range, event and result. Click a row to see all of its details (for audit rows this
includes the old and new values). **Export CSV** downloads the current filter (opens in Excel; Arabic is
kept).
Users with a limited scope (for example Department Managers) see only the **audit trail** of their own
applications. Full details are in [07-Logging-and-Audit.md](07-Logging-and-Audit.md).

The cards at the top show the last 24 hours: successful logins, failed attempts, changes, errors, active
sessions and locked accounts. Check **failed attempts** and **errors** regularly.

## 5. Weights and calculation — permission `wgt`

- **Weighting mode**: *Fixed* uses the weight typed for each application. *Automatic* uses the sum of the
  weights of the application's enabled functions.
- **Notifications share** (0–50 %): how much the notification status affects a function's %.
- **Reports share** (0–50 %): how much the reports stream affects an application's %.
- **Restore default weights** returns every application to the weight from the original design.

Project-wide parameters can only be changed by full-scope users.

## 6. Command-line tools (on the server)

```bash
cd /opt/ets/backend
E="sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets"
$E node scripts/create-admin.js --username admin2 --name "Second Admin"   # create/reset an admin
$E node scripts/import-legacy.js /path/file.html                            # import original data
$E node scripts/purge-logs.js                                               # apply retention now
sudo ets-backup                                                             # backup now
```

If every administrator is locked out, `create-admin.js` with an existing username resets that account's
password, unlocks it and makes it an active administrator. Add `--reset-2fa` if the administrator has also
lost their authenticator.
