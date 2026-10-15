# 03 — Administrator Guide

The screens described here are visible to users with the matching permission. A System Administrator sees
all of them. The menu is under **Administration** in the sidebar.

## 1. Users (Administration → Users) — System Administrators only

User management (`usr`) belongs to the **System Administrator** role only. It cannot be granted to another role
by a permission override (the server refuses it with «صلاحية إدارة المستخدمين لمسؤولي النظام فقط»), so only
administrators create or promote administrators, reset an administrator's password or 2FA, and exempt users
from 2FA in bulk.

### Create a user
1. **New user** → fill in the full name, username (Latin letters, digits, `. _ -`), email (optional),
   language and an initial password (at least 10 characters — 12 for an administrator —, letters and digits,
   not a common password, not containing the username, at most 72 bytes).
2. Keep **Must change password at first login** ticked. The user then picks their own password.
3. Choose a **role** (see the table below).
4. Optionally adjust **permissions**. Each permission follows the role, or can be explicitly **granted** or
   **revoked** for this user (except *Manage users*, see above).
5. Set the **scope**: tick departments (all their applications) and/or single applications. Full scope comes
   from the role only (System Administrator, Project Manager, Technical Project Manager). **A user of any other
   role with nothing ticked sees no data at all** — the form shows a warning and the user list shows
   «بلا نطاق / No scope». A user scoped to single applications sees, uploads and approves changes of those
   applications only, never the rest of the department.
6. **Save**.

| Role | Typical user | Scope |
|---|---|---|
| System Administrator | IT administrator of ETS (the only role with *Manage users*) | always full |
| Project Manager / Technical Project Manager | Run the project; final approval of team result files | always full |
| Department Manager | Head of a department's ERP rollout | their department |
| Department Team Lead | Leads a department team; first approval of team files and approval of data-entry edits | their department (or applications) |
| Team Member | Enters progress / tests; edits and files wait for the team lead | their department (or applications) |
| Application Editor | Functional lead for some applications | those applications |
| Tester | QA staff recording test results | the applications they test |
| Observer | Management / auditors (read only) | what they may see |

Roles other than the three full-scope roles **must** be given a scope, otherwise the user sees nothing.

### Actions on a user
| Button | Effect | Logged as |
|---|---|---|
| Reset password | Sets a new password, clears a sign-in pause, signs out all sessions, forces a change at next login (optional) | `password_reset_by_admin` |
| Unlink authenticator | Removes the user's 2FA app and recovery codes and signs the user out. If 2FA is required, they enrol again at next login | `mfa_reset_by_admin` |
| Unlock | Shown while sign-in to the account is paused («مقفل / Locked»): clears the failure count and the pause | `account_unlocked_by_admin` |
| End sessions | Signs the user out everywhere | `sessions_revoked_by_admin` |
| Active (untick) | Disables the account and ends its sessions. Users are never deleted, so their history stays | audit `update user` |

Safety rules enforced by the server:
- At least one active System Administrator who still holds *Manage users* and *Settings* (after permission
  overrides) must always exist; concurrent changes are serialised so two administrators cannot remove each other.
- You cannot change your own role or disable yourself.
- You cannot widen your own permissions or scope, or exempt yourself from 2FA — another administrator does that.
  Revoking a permission from yourself is allowed (unless you are the last administrator).
- Disabling a user withdraws their edit requests still waiting for approval.

**Sign-in pauses instead of a fixed lock (1.0.0).** After 5 failed password / 2FA / recovery-code checks
(`MAX_FAILED_LOGINS`) sign-in to the account pauses for 1 minute, then 2, 4, 8 … up to 15 minutes
(`LOCK_MINUTES`); the pause ends by itself and the count restarts after 60 minutes without failures
(`LOCKOUT_RESET_MINUTES`) or after a complete sign-in. The login screen never says that an account is locked — it
shows the same «incorrect username or password» message — so a user may report that their correct password does
not work: check the *Locked* badge and *Logs → Login & security* (`account_locked`, `login_while_locked`), then
let them wait or press **Unlock**. Too many attempts from one PC show «Too many attempts — wait N seconds».

> **Upgrading to 1.0.0 — check the scope of existing users.** Before 1.0.0 a user of a scoped role (Department
> Manager, Team Lead, Team Member, Application Editor, Tester, Observer) with no department/application ticked
> saw *everything*. From 1.0.0 such a user sees **nothing** until you give them a scope. Nothing is granted
> automatically. After the upgrade, open *Users*, look for «بلا نطاق / No scope» and set each user's scope; the
> migration also writes the list of affected usernames to the system log (event `scope_fail_closed`). Any
> *Manage users* override held by a non-administrator is removed by the upgrade (recorded in the audit trail).

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
   The uploader may sign **neither** stage, so a batch always needs two people other than the uploader.
   Each approver needs every application the batch changes in their scope. When the second signature would
   apply the batch, the server checks that the uploader is still active, still has the import permission and
   still covers those applications; otherwise it refuses («صاحب هذا التعديل لم يعد مخوّلاً به») and the batch
   should be rejected.
6. After both approvals the changes are applied at once and the batch shows "Approved and applied". If a value
   was changed in ETS after the upload, that one value is skipped and marked ✗.

A new file with changes for the same department replaces a batch still waiting ("Replaced by a newer file") only
if nobody has signed that batch yet and it is the uploader's own or lies entirely within the uploader's scope; a
file without changes never replaces anything. A team member scoped to some applications only uploads the
changes of those applications.
The *Audit trail* records every step (`import_submit`, `import_approve_lead`, `import_approve_final`,
`import_apply`, `import_reject`). *Settings → Data → Full import without approval* is only for the first
migration (it loads everything at once and needs the settings permission).

Things to know when reviewing (by design): a team file can change **function and application weights** even when
the uploader has no weights permission — check the weight lines in the batch before signing; the field-level
rules of the screens (for example «مع ملاحظات» needing a note) are not re-applied to imported values; the full
import without approval replaces everything for every department (it is audited with a full before-snapshot) and
should not be used after go-live; a Department Manager changes the weights of their own applications directly,
while function weight edits by data-entry users wait for the team lead.

## 1c. Approval of data-entry edits (team lead only)

When a **team member** (or any user who is not an approver of the department) edits a function, runs a bulk
set or edits a report, the change is **not applied**: it becomes an *edit request*. The approved value stays on
screen with a «بانتظار الاعتماد» chip showing the proposed value. The **team lead of that department** sees a red
badge on «اعتماد التعديلات» and a notice on the dashboard, and approves or rejects (with a reason) each request,
or uses *Approve all shown*. The project / technical manager is **not** needed for these edits.

Applied directly (no request): team leads for the applications in their scope, project manager, technical
manager, system administrators. A team lead scoped to single applications approves requests for those
applications only. When a request is approved the server re-checks that its author is still active, still has
the application in scope and still holds the permission for each field; if not, the request is refused (or
skipped by *Approve all shown*) and should be rejected. The rule can be switched off in *Settings → Approvals*. A department without a team lead cannot
approve its members' edits — give someone the Team Lead role with that department in scope.

## 1d. Adding and removing functions
- Permission `tog` (include / exclude) also allows adding, removing and restoring functions in the user's scope.
  Team members now have it; their additions, removals and restores wait for the department team lead.
- Removal is a soft removal with a mandatory reason: the row is kept (`removed_at`), counts in no calculation and
  never comes back through the catalog seed, a JSON import or a team file. Restore re-includes it.
- Every addition, removal, restore and include/exclude is in the audit log (`create`, `remove`, `restore`, `update`).

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

### What users must confirm themselves
Turning 2FA on from *My account* asks for the password; turning it off or generating new recovery codes asks
for the password **and** a current authenticator code (or a recovery code). Recovery codes have the form
`xxxx-xxxx-xxxx`; users with codes from before 1.0.0 see a hint to generate new ones (the old ones keep working
until used).

### Lost phone
The user signs in with one of their **recovery codes** (link *Use a recovery code instead*). Each code
works once. If they have no codes left, an administrator uses **Unlink authenticator** on that user. Only an
administrator can do this for another administrator; exempting users from 2FA in bulk is for administrators only.

## 3. Settings (Administration → Settings) — permission `cfg`

| Section | Setting | Default |
|---|---|---|
| Two-step verification | Policy; issuer name shown in the app | Optional; `ETS` |
| General | System name (Arabic / English) on the login screen and navbar; default language (login screen and interface for a browser that has not chosen a language yet, and new users created without a language) | — ; Arabic |
| Security | Minimum password length (10–64; administrators always need at least 12) | 10 |
| Log retention | Days to keep the **audit trail** (change history, at least 365); days to keep the login, error and system logs (at least 30); days to keep the request log (at least 7). Lowering a value is flagged in the logs; every purge is recorded in the audit trail | 365; 365; 90 |
| Data | Export all tracker data (JSON); import the original tracker file (HTML/JSON) | — |
| System information | Version, PostgreSQL version, database size, uptime | — |

The calculation parameters (weighting mode, notifications share, reports share) are on the **Weights**
screen.

### Project timeline (Settings → «الجدول الزمني للمشروع»)
- **Project start** and **project close date**. Saved with the page's Save button.
- When both are set, the number of curve periods is derived automatically (the last period ends on the close
  date) and the dates can no longer be changed from the curve page. At most 60 periods.
- They drive the **Project status** page: planned-to-date, deviation, schedule delay in days, SPI / SPI(t),
  current and required pace, forecast close date, lagging departments and recommendations.
- The API stores a progress snapshot every hour (one row per day, table `progress_snapshots`); after 7 days
  the pace and forecast use the last 30 days of real progress instead of the average since the start.

### Branding (Settings → «الهوية البصرية»)
| Image | Where it appears | Format / limit |
|---|---|---|
| System logo | Top bar and login screen | Square PNG/WebP, transparent background, ≤ 1 MB |
| Favicon | Browser tab | Square PNG or ICO, 64×64 or larger, ≤ 512 KB (if empty, the logo is used) |
| Login background | Behind the login form (darkened slightly) | Landscape JPEG/WebP, e.g. 1920×1080, ≤ 3 MB |

Below the images, two sliders set the **logo size** in the top bar (20–80 px) and on the login screen (40–200 px);
the size changes live and is saved when you release the slider. Wide logos keep their proportions.

**Upload image** replaces it immediately for everyone; **Restore default** returns to the built-in icon / plain
background. Images are stored in the database and included in backups. SVG files are not accepted.
Branding images are public (the login screen shows them), so on upload the system removes their metadata
(camera, GPS position, author, comments) and anything after the end of the image; the picture itself is unchanged.

## 4. Logs (Administration → Logs) — permission `log`

Tabs: **Login & security**, **Audit trail**, **Request log**, **Errors**, **System**.
Filter by text, date range, event and result. Click a row to see all of its details (for audit rows this
includes the old and new values). **Export CSV** downloads the current filter (opens in Excel; Arabic is
kept). Every export, and an administrator opening a security log, is itself recorded in the audit trail.

**Security logs are for System Administrators only.** The *Login & security*, *Request log*, *Errors* and
*System* tabs, the statistics cards, IP addresses and user agents are shown to the System Administrator role
only. Every other role with `log` (Project / Technical Project Manager, Department Manager, Team Lead) sees only
the **audit trail** — of their own applications when their scope is limited — without IP addresses.
Full details are in [07-Logging-and-Audit.md](07-Logging-and-Audit.md).

The cards at the top (administrators) show the last 24 hours: successful logins, failed attempts, changes,
errors, active sessions, locked accounts and log rows that could not be saved. Check **failed attempts** and
**errors** regularly. **Verify log integrity** recomputes the hash chains of the audit trail and the sign-in log
and shows their heads — note a head now and then outside the server (07 §3).

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
$E node scripts/create-admin.js --username admin2 --name "Second Admin"   # create/reset an admin (password asked, 12+)
$E node scripts/import-legacy.js /path/file.html                            # import original data
$E node scripts/purge-logs.js                                               # apply retention now
$E node scripts/verify-audit.js                                             # check the audit-trail hash chains
$E node scripts/set-setting.js mfa.mode required                            # change a setting (audited as cli:<user>)
$E node scripts/rotate-app-secret.js                                        # APP_SECRET rotation, see 06 §6a
sudo ets-backup                                                             # encrypted backup now
sudo ets-log-protect status                                                 # audit-trail protection (07 §3)
```

These scripts write to the audit trail in the name of `cli:<operating-system user>`. `create-admin` signs the
account out everywhere; `--must-change-password` forces a new password at the next sign-in; `--password` on the
command line is deprecated (visible in the process list).

If every administrator is locked out, `create-admin.js` with an existing username resets that account's
password, unlocks it and makes it an active administrator. Add `--reset-2fa` if the administrator has also
lost their authenticator.
