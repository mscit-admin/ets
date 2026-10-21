# 03 — Administrator Guide

The screens described here are visible to users with the matching permission. A System Administrator sees
all of them. The menu is under **Administration** in the sidebar.

## 1. Users (Administration → Users) — System Administrators only

User management (`usr`) belongs to the **System Administrator** role only. It cannot be granted to another role
by a permission override (the server refuses it with «صلاحية إدارة المستخدمين لمسؤولي النظام فقط»), so only
administrators create or promote administrators, reset an administrator's password or 2FA, and exempt users
from 2FA in bulk.

### Create a user
1. **New user** → fill in the full name, username (Latin letters, digits, `. _ -`; never `@`), email (optional;
   stored in lower case, one account per address — the user can sign in with it instead of the username),
   language and an initial password (at least 10 characters — 12 for an administrator —, letters and digits,
   not a common password, not containing the username, at most 72 bytes).
2. Keep **Must change password at first login** ticked. The user then picks their own password.
3. Choose a **role** (see the table below).
4. Optionally adjust **permissions**. Each permission follows the role, or can be explicitly **granted** or
   **revoked** for this user (except *Manage users*, see above). Roles themselves are fixed (defined in
   `backend/src/db/seed.js`, refreshed at every start); there is no screen to edit a role, so per-user overrides
   are the way to adjust one user (see the permission table below).
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

**Permissions** (Users → user → «الصلاحيات»; ✓ = given by the role):

| Key | Label (ar / en) | admin | pm / tm | mgr | lead | member | ed | qa | obs |
|---|---|---|---|---|---|---|---|---|---|
| `pct` | تعديل نسب الإنجاز / Edit progress | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `wgt` | تعديل الأوزان / Edit weights | ✓ | ✓ | ✓ | | | | | |
| `tst` | حالة الاختبار والملاحظات / Test status & notes | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |
| `tog` | تفعيل البنود وإضافتها / Enable / add items — include / exclude, add, remove, restore, item type | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| `ren` | تعديل اسم البند / Rename items (1.9.2) | ✓ | ✓ | ✓ | ✓ | ✓ | | | |
| `mov` | نقل البنود / Move items to another application (1.10.0) | ✓ | ✓ | ✓ | ✓ | | | | |
| `sch` | تعديل الجدول والمنحنى / Edit schedule & curve | ✓ | ✓ | ✓ | | | | | |
| `rep` | تعديل التقارير / Edit reports | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | |
| `exp` | التصدير / Export | ✓ | ✓ | ✓ | ✓ | | | | |
| `imp` | الاستيراد / Import | ✓ | ✓ | | ✓ | ✓ | | | |
| `usr` | إدارة المستخدمين / Manage users (admin role only) | ✓ | | | | | | | |
| `log` | الاطلاع على السجلات / View logs | ✓ | ✓ | ✓ | ✓ | | | | |
| `cfg` | إعدادات النظام / System settings | ✓ | | | | | | | |
| `apv_dept` | اعتماد نتائج الإدارة (رئيس الفريق) / Approve department results (team lead) | | | | ✓ | | | | |
| `apv_final` | الاعتماد النهائي (مدير المشروع / الفني) / Final approval (project / technical manager) | | ✓ | | | | | | |

`ren` (1.9.2) is separate from `tog`: revoke it to stop a user renaming items while they still add, remove and
include them, or grant it alone to let someone correct names without changing the list of items. On upgrade,
migration 018 gave `ren` to every role that has `tog` and copied every per-user `tog` override to `ren` with the
same value, so nobody gained or lost anything until an administrator changes it. A team member's rename still
waits for the team lead.

`mov` (1.10.0) moves an item to another application, possibly of another department (section 1e). It is a new
capability: migration 019 gives it to admin, pm, tm, mgr and lead only, and copies it from no per-user override —
team members, editors, testers and observers do not get it. Grant it per user (Users → user → «نقل البنود») to
let someone else request moves; revoke it to stop a lead or manager moving items.

### Import users from a file (1.1.0, drop-down lists and names since 1.1.1)
To create many accounts at once: **Users → Import users** (استيراد مستخدمين).

1. **Download the template** — *Excel (.xlsx)* or *CSV*. Download it again whenever roles, departments or
   applications change: the Excel template is built from the system's current lists.
   - Sheet **users**: the header row shows each column as `id / readable name` (e.g. `role / الدور`) and stays
     frozen; the sheet is right-to-left when the interface is in Arabic. The columns **role**, **language**,
     **departments**, **department_2**, **department_3**, **applications**, **application_2** and
     **application_3** have **drop-down lists** (rows 2–501) with the names in the interface language — e.g.
     «عضو فريق», «العربية», «إدارة الموارد البشرية والخدمات», «شؤون العاملين» in Arabic, or *Team Member*,
     *Arabic*, *Human Resources & Services*, *Personnel Affairs* in English. Selecting a cell shows a short hint.
   - The lists themselves are on a **hidden sheet `lists`** (Excel: right-click a sheet tab → *Unhide*); do not
     edit it — download a new template instead.
   - Sheet **help**: every column, and every role, department and application with its id, Arabic and English
     name (the same lists are shown in the dialog under «القيم المقبولة / Accepted values»).
2. Fill one row per user (keep the header row; the column order does not matter, extra columns are ignored;
   templates from 1.1.0 with ids only still work):

   | Column | Required | Content |
   |---|---|---|
   | `username` | yes | 3–60 Latin letters, digits, `. _ -`; must not exist yet and must not repeat in the file (case-insensitive: `Ali` = `ali`) |
   | `full_name` | yes | Full name, up to 120 characters (Arabic is fine) |
   | `email` | no | Email address |
   | `role` | yes | Pick from the list. Accepted: the Arabic or English role name, or the role id (`admin`, `pm`, `tm`, `mgr`, `lead`, `member`, `ed`, `qa`, `obs`) |
   | `language` | no | Pick from the list: العربية / الإنجليزية (also accepted: `ar`, `en`, عربي, انجليزي, إنجليزي, Arabic, English); empty = *Settings → default language* |
   | `departments`, `department_2`, `department_3` | see below | One department per cell from the list — name (Arabic, English, or the short name such as «المالية») or id |
   | `applications`, `application_2`, `application_3` | see below | One application per cell from the list — name or id |

   **More than one department / application:** use the extra columns (`department_2`, `department_3`, …), or
   type several values in one cell separated by a comma — `,` or the Arabic comma `،` (also `;`), e.g.
   «الإدارة المالية، الإدارة التجارية» or `hr,fin`. Excel then warns that the value is not in the list: choose
   **Yes / Continue** — the warning does not block, and every value is checked when the file is uploaded.

   **How names are matched:** spaces before / after and double spaces, upper / lower case, the tatweel «ـ»,
   diacritics (harakat, shadda), أ / إ / آ vs ا, ؤ / ئ (شؤون = شئون), ى vs ي and ة vs ه do not matter. An exact
   id always wins. A name that fits two items (e.g. two applications with the same name) is refused with
   «القيمة تطابق أكثر من عنصر» (`ambiguous_value`): write the id instead, or the drop-down text, which then shows
   the id in brackets, e.g. «شؤون العاملين (per)».

   A user of a department-limited role (anything except System Administrator, Project Manager and Technical
   Project Manager) **must** have at least one department or application, otherwise the row is refused («هذا
   الدور محدود بنطاق…»): such a user would see no data. Departments / applications given for a full-scope role
   are ignored. The import never grants permission overrides — adjust them per user afterwards if needed.
   A CSV file must be UTF-8 (Excel: *Save as → CSV UTF-8*); commas or `;` as separator both work. A CSV file
   has no drop-down lists; names and ids are accepted the same way.
3. **Choose the file.** It is read in your browser and every row is checked by the server **without creating
   anything**. The preview lists each row with what will be created, **in names** (role, language, departments,
   applications — e.g. «عضو فريق», «العربية»), and «سليم / OK» or its errors (username taken, duplicate in the
   file, email already used by an account or twice in the file, invalid username / email / role / language / department / application, ambiguous name, missing scope,
   missing full name). An unrecognised value is quoted in the message, e.g. «الدور غير موجود: مدير قسم» or
   «الإدارة غير موجودة: …».
   If any row has an error, **nothing can be created**: download the **error report** (.xlsx or .csv — the
   file's rows with a message for each), fix the file and choose it again. At most **500 rows** per file.
4. **Create N users.** All rows are created together in one step — if anything fails (for example another
   administrator created one of the usernames meanwhile), **no** account is created and the errors are shown
   again. Large files take up to about a minute (password hashing).
5. **One-time passwords.** The system gives every new account a random temporary password (16 characters, letters
   and digits without look-alikes such as `0/O` and `1/l/I`) and sets *Must change password at first login*.
   The list «username / temporary password» is shown **only once**, on the result screen: **Copy** it or
   **Download** it (.xlsx / .csv) before pressing *Done*. The passwords are not stored anywhere in clear and
   cannot be shown again — if one is lost, use *Reset password* on that user. Hand each user their password
   through a safe channel and delete the downloaded file afterwards. At first sign-in the user must choose their
   own password (2FA enrolment follows if the policy requires it).

Every created user is recorded in *Logs → Change history* as «إنشاء المستخدم …» with the note «ضمن استيراد
مستخدمين من ملف», plus one summary row «استيراد N مستخدم دفعة واحدة من ملف» (action `bulk_create`). No
password appears in any log.

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
- Your own password is changed in *My account* (it asks for the current one); *Reset password* is not offered on
  your own account.
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
  Renaming an item needs `ren` instead (1.9.2, see the permission table in section 1).
  Team members now have it; their additions, removals and restores wait for the department team lead.
- Removal is a soft removal with a mandatory reason: the row is kept (`removed_at`), counts in no calculation and
  never comes back through the catalog seed, a JSON import or a team file. Restore re-includes it.
- Every addition, removal, restore and include/exclude is in the audit log (`create`, `remove`, `restore`, `update`).

## 1e. Moving items to another application (1.10.0) — permission `mov`

An item (function or report) can be moved to another application, also of another department: the «نقل» button
on its row, or several at once from «تعيين جماعي» → «نقل بنود إلى تطبيق آخر» (up to 200, all or nothing). The
user picks the module (department), then the application, and writes a reason (3–500 characters). Both
applications must be in the user's scope. The dialog shows before → after for both applications, their
department(s), the project, and the weight that moves.

- **What moves:** the item keeps its id, values, history, exclusion reason and duplicate links. It gets a new code
  `C<n>` in the destination (its old code is never reused in the source) and the badge «منقول من <app> / <code>».
  The catalog seed never re-creates it in its old application.
- **Weights (fixed mode):** the item takes its share of the source application's weight:
  `share = source weight × item weight ÷ sum of the source's counted item weights` (rounded to 0.01; the source
  loses exactly what the destination gains, so the total is unchanged). An excluded item carries 0. In automatic
  mode no weight is transferred — an application's weight is the sum of its items. Both weight changes appear in
  the Weights history with the reason «نقل البند …».
- **Blocked (409):** a removed item; an item with an edit request or a result file waiting for approval
  (approve or reject it first).
- **Approval:** direct for an approver of both applications (a team lead with both in scope), for `cfg` /
  `apv_final` holders, or when *Settings → Approvals* is off. Otherwise (e.g. a department manager, or a user
  granted `mov`) it becomes a request that needs **two approvals**: the source application's team lead, then
  the destination's («اعتماد (المصدر)», «اعتماد (الوجهة)»); one approval when the same lead covers both; never the
  requester. Either lead may reject. On approval everything is checked again (requester's rights and scope on
  both applications, the item still in the source and not removed, nothing else pending on it) and the weight
  share is computed from the source **as it is at approval**; the approval screen shows the share when requested
  and the share now. A department without a team lead cannot approve its side: give someone that role first, or
  have a project / technical manager move the item directly.
- **Logs:** one `move` audit row per item («نقل أحمد البند D7 من «…» (…) إلى «…» (…) برمز C12 — نُقل وزن 0.20 —
  السبب: «…»»), plus the two application weight rows. The old department keeps seeing the item's history up to and
  including the move; the new department sees all of it. Destination users get the alert «نقل بنود إلى تطبيقات في
  نطاقي» (T8).

## 1f. Online users (Administration → «المتصلون الآن») — 1.11.0, System Administrators only

**Administration → «المتصلون الآن» / "Online now"** (`/online`) lists who is working on the system now: one row per
signed-in session (a user with two browsers has two rows). Same access as the Users page (role *System
Administrator* with *Manage users*); nobody else can see who is online, and the server refuses the list to anyone
else (403). Opening the page is recorded in the change history (`view` / `presence`), at most once per 15 minutes
per administrator. The Users page shows **«متصل الآن (n)»** linking here.

| Column | Meaning |
|---|---|
| User | Full name, username and role; «(أنت)» on your own session |
| Status · last activity | **متصل / Online**: the browser reported within the last 2 minutes. **خامل / Idle**: 2–15 minutes ago (tab hidden, browser minimised or the PC asleep) while the session is still valid. Older → not listed |
| Current screen | Readable name of the screen and of what is open on it, e.g. «وظائف التطبيق — شؤون العاملين», linked to that screen. «غير معروف» when the screen is not known or what it named no longer exists |
| On screen for | Time since the user opened this screen |
| Session duration | Time since the sign-in (the password step, also when 2FA followed), with the sign-in time |
| Active today | Today's time (Settings → Notifications time zone) with a visible ETS tab, all of the user's sessions together, not counted twice |
| Client · IP | Browser or phone app, browser / system summary, IP address |

Counts at the top: online sessions, idle sessions, all open sessions (including sessions whose tab is closed). The
filters (role, department, screen) work on the list shown; *department* means the user's data scope (users with
full scope match every department). The page refreshes every 15 seconds while it is visible, and its refreshes do
not keep your own session alive.

**«إنهاء الجلسة» / End session** (with a confirmation) signs out that one session — the user's other sessions stay.
It is the same action as *End sessions* on the user's page, limited to one session, and is logged the same way
(audit `revoke_sessions` with `session_ref`, sign-in log `sessions_revoked_by_admin`). Your own current session
has no button (use *Sign out*).

What is recorded about each user and for how long: see [06-Security.md](06-Security.md) §3a.

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
- Everyone: **Exempt everyone else from 2FA** (your own account is left out) / **Remove exemption for everyone**.

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

## 3a. Notifications (Settings → «الإشعارات») and phones — 1.9.0

Alerts reach users through the **bell** in the top bar, the **«التنبيهات»** history page and, for those who pair
an Android phone, the **ETS app**. Who receives what is decided in three layers, each of which can only narrow the
one before it:

1. **Eligibility (in the code, cannot be changed):** the permission of the alert type (e.g. `pct` for «وظائف
   عالقة», `tst` for «مكتملة ولم تُختبر», `apv_dept` for «طلب بانتظار اعتمادي») and its scope rule (the
   application in the user's scope, the whole department, or full scope for project-wide alerts). Security and
   system alerts (S1–S8) are for the **System Administrator role only**, whatever any setting says. Deactivated,
   deleted users and users who must change their password receive nothing.
2. **The policy (this screen):** the matrix *type × role*. ☑ = the role receives it; — = not eligible (cannot be
   turned on); 🔒 = mandatory in the code (cannot be turned off). Column **«الجوال»**: the type may be sent to the
   phone app. Column **«إلزامي»**: the type becomes mandatory for every role it is on for (users can then no longer
   mute it). Saving writes one change-history row with the whole matrix before / after; the Logs screen reads it
   as a sentence, e.g. «تعديل سياسة الإشعارات: «وظائف عالقة» أُوقف لدور «عضو فريق»».
3. **Restrictions on one user (Users → the user's page → «قيود التنبيهات»):** block a type on every channel or on
   the phone only (block only, never a grant; not on your own account; a type mandatory in the code for the user's
   role can only be blocked on the phone). Audited («تعديل قيود التنبيهات للمستخدم …»). Then each user may mute
   non-mandatory types and the periodic summaries on their profile page.

Every alert is checked **again when it is read**: when a permission, scope or policy cell is removed, existing
alerts are **hidden, not deleted**, and come back if the right comes back while they are kept.

**Defaults the administrator can change** (decided with the owner, see CHANGELOG 1.9.0): the matrix of the proposal
(§3.1); mandatory types A1, A4 (approvers), A2 and A6 (team lead), S3, S6, S7 (administrator); per-user blocks set
by administrators only; alerts hidden, not deleted, when a right is removed; phones revoked when the password is
reset by an administrator; phones unused for 90 days revoked automatically.

| Setting | Default | Range |
|---|---|---|
| Notifications on | on | — |
| Daily summary hour / work days / time zone | 08:00 / Sun–Thu / `Africa/Tripoli` | 0–23 / any days / an IANA zone |
| Stuck: days without progress (0 < % < 100; critical after twice as long) | 14 | 3–90 |
| Done (100 %) and not tested: days | 7 | 1–60 |
| Failed and not re-tested: days | 7 | 1–60 |
| Not started (0 %) after: days (once the project has started) | 30 | 7–180 |
| Approval reminder after (hours) / escalation to PM, TM after (days) | 48 / 5 | 4–168 / 1–30 (escalation after the reminder) |
| Import file waiting: days | 3 | 1–30 |
| Department at risk / delayed: points behind the plan | 5 / 15 | 1–50 (at risk < delayed); also used by the project status page |
| Department stalled: 30-day change at most (points) | 0.5 | 0–10 |
| Close date approaching: days | 30 | 1–180 |
| Failed sign-ins in 15 minutes / refused requests per hour / server errors per hour | 20 / 30 / 10 | 5–500 / 5–1000 / 1–1000 |
| Maximum backup age (hours) | 26 | 2–168 |
| New alerts per user per hour (more are folded into one «تنبيهات كثيرة»; mandatory ones never) | 50 | 5–500 |
| Keep read alerts (days; unread: twice as long) | 180 | 30–730 |
| Revoke phones unused for (days) | 90 | 7–365 |

**When alerts are made.** Immediately (after the change is saved): an edit request waiting (A1), a decision on a
request (A3), a result file waiting / its outcome (A4, A5), functions excluded or removed (T7), items moved into
an application (T8, 1.10.0 — same roles and policy defaults as T7), an account paused
(S1), a log retention lowered (S7). Every 15 minutes the API checks failed sign-ins, refused requests and server
errors (S2, S5, S8); every day from the summary hour: the audit-log hash chains (S3), the e-mail index (S4), the
backup age (S6); on work days the summaries (T1–T5, A2, A6, P1, P3, P4); weekly T6 and P2. Summaries are one alert per
user and application (scoped users) or department (full-scope users), updated in place while unread.

**Phones.** Users pair their own phone from *Profile → «أجهزتي»* (password and 2FA code asked again; one-time QR
code valid 10 minutes). On a user's page an administrator sees that user's phones (last use, address) and can
revoke them. Phones are revoked automatically when the account is deactivated, deleted, or its password is reset
by an administrator, and after 90 days without use. Phones outside the building connect **over the VPN** — see
10-Operations-Runbook §1b.

## 4. Logs (Administration → Logs) — permission `log`

Tabs: **Login & security**, **Audit trail**, **Request log**, **Errors**, **System**.
Filter by text, date range, event and result. Click a row to see all of its details (for audit rows this
includes the old and new values). **Export CSV** downloads the current filter (opens in Excel; Arabic is
kept); **Export to Excel** downloads the same rows as an `.xlsx` file. Both need the `exp` permission as well
(1.3.0). Every export, and an administrator opening a security log, is itself recorded in the audit trail.

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
