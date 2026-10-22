# 09 — Test Plan & User Acceptance Testing (UAT)

## 1. Scope and approach

| Level | Who | How | Status at handover |
|---|---|---|---|
| Unit tests | Developer | `backend/test/totp.test.js`, `calc.test.js`, `config.test.js`, and the unit parts of `passwords.test.js` / `input.test.js` | run without a database |
| API integration and security tests | Developer | `api.test.js`, `auth-security.test.js` (lockout, rate limits, sessions, 2FA step-up), `passwords.test.js` (password policy, recovery codes, cookie), `authz.test.js` (permissions, `usr` admin-only, scope fail-closed, approvals, two-person rule), `input.test.js` (request limits, validation, CSV, branding images), `audit-log.test.js` (append-only, hash chain, purge, admin-only logs), `rotate.test.js` (APP_SECRET rotation) against a disposable PostgreSQL DB | **90 tests**, all pass |
| Deployment checks | Developer | Audit-trail protection with a non-superuser application role (install, migrations that change the log tables, backup, restore, refused tampering) — run by hand on a test cluster, see §2 E-11/E-12 | pass |
| UAT | Customer | The test cases below, run in the browser on the installed server | To be run by the customer |

How to run the automated tests:

```bash
sudo -u postgres createdb -O ets ets_test          # on a development / test machine
cd backend && TEST_DATABASE_URL=postgres://ets:<password>@127.0.0.1/ets_test npm test
# expected: "# tests 90  # pass 90  # fail 0"
```

> `ets_test` is wiped by the tests. **Never** point `TEST_DATABASE_URL` at the production database.

### Test environment for UAT
- Server installed per [02-Installation-Guide.md](02-Installation-Guide.md); browsers Chrome/Edge/Firefox
  (latest) and a phone browser.
- Test accounts created by the administrator: `uat.admin` and `uat.admin2` (System Administrators), `uat.hr`
  (Department Manager, scope HR), `uat.editor` (Application Editor, scope Payroll), `uat.qa` (Tester, scope HR),
  `uat.view` (Observer, scope HR), `uat.noscope` (Tester with **no** scope), plus the accounts of §H.
  Passwords: at least 10 characters (12 for administrators), not a common word.
- A phone with Google Authenticator or Microsoft Authenticator.

### Recording results
For each case write **P** (pass) or **F** (fail), the date and initials. For a failure, add the observed
result and a screenshot to the defect list (§4).

## 2. Test cases

### A. Login & passwords
| ID | Steps | Expected result | Result |
|---|---|---|---|
| A-01 | Open the site over `http://` (when an HTTP port was configured) | Redirected to `https://`; there is no plain-HTTP mode | |
| A-02 | Sign in with a correct username and password (2FA policy *Optional*, user not enrolled) | Dashboard opens; *Logs → Login & security* shows `login` success | |
| A-02b | Sign in with the user's **e-mail address** instead of the username (try upper case and spaces around it) | Dashboard opens; the `login` row shows `detail.via = email`. A 2FA user still gets the code step | |
| A-02c | Wrong password by e-mail, then by username, then an unknown address | Same message each time; the account's failure counter counts both names (Users → the user) | |
| A-03 | Sign in with a wrong password | "Incorrect username or password"; log shows `login_bad_password` | |
| A-04 | Sign in with a non-existent username | Same message as A-03 (does not reveal that the user does not exist); log `login_unknown_user` | |
| A-05 | Enter a wrong password 5 times, then the correct one at once | Every answer is the same "Incorrect username or password. After several failed attempts, sign-in to the account pauses for a few minutes and then resumes by itself" — the correct password is not accepted during the pause and the screen does not say the account is locked; log `account_locked`, then `login_while_locked`; the admin sees the user as *Locked* | |
| A-05b | Wait 1 minute after A-05, sign in with the correct password | Sign-in works (the pause ends by itself; it doubles with each further failure, up to 15 min) | |
| A-06 | Repeat A-05, then admin → user → **Unlock**; user signs in | Login works at once; log `account_unlocked_by_admin` | |
| A-07 | Admin creates a user with "must change password"; user signs in | The *Change password* screen appears; no other screen is reachable until it is changed | |
| A-08 | Try new passwords `abc`, `Abcdefg12` (9 characters) and `Password2026!` (common) | Each refused with the policy message (at least 10 characters, letters and digits, not common, not containing the username) | |
| A-08b | Admin creates an administrator with an 11-character password | Refused: administrators need at least 12 characters | |
| A-09 | Change the password correctly | Dashboard opens; log `password_changed` | |
| A-10 | Stay idle for 60 minutes (do not touch the page; leave the dashboard or Settings → «النسخ الاحتياطي» open) | Returned to the login screen by itself, with «انتهت الجلسة بسبب عدم النشاط»; a reload and a hard reload (Ctrl+Shift+R) stay on the login screen; log `session_expired` (reason idle) | |
| A-10b | Keep working in one tab for more than 60 minutes while a second tab of the same browser stays untouched | Neither tab signs out | |
| A-11 | Click the avatar → **Log out** | Login screen; log `logout` | |
| A-12 | Switch language on the login screen | All texts switch Arabic ↔ English and the direction changes RTL ↔ LTR | |
| A-13 | Send more than 30 wrong sign-ins from one PC within 15 minutes (any usernames) | "Too many attempts — wait N seconds" (HTTP 429); log `rate_limited` written once for the window | |
| A-14 | Browser developer tools → Application → Cookies after sign-in | One cookie `__Host-ets_sid`, *HttpOnly*, *Secure*, *SameSite=Strict*, path `/` | |
| A-15 | Open `https://<address>/api/health` | `{"status":"ok"}` only — no version number | |

### B. Two-factor authentication
| ID | Steps | Expected result | Result |
|---|---|---|---|
| B-01 | *My account* → **Enable two-step verification**: enter your password, scan the QR, enter the code | The password is asked first; 10 recovery codes in the form `xxxx-xxxx-xxxx` shown once; status *Enabled* | |
| B-02 | Log out and in again | After the password a 6-digit code is requested; a correct code opens the dashboard | |
| B-03 | Enter a wrong code | "Invalid code"; log `mfa_bad_code` | |
| B-04 | Use the same correct code for a second login within 30 s | Refused (`mfa_code_replay`) | |
| B-05 | Sign in using a recovery code | Accepted once; using the same code again is refused | |
| B-06 | Admin: Settings → policy **Required**; a user without 2FA signs in | The enrolment screen (QR) appears and must be completed | |
| B-07 | Admin: exempt that user (user form → *Exempt from two-step verification*) | The user signs in without a code; log `mfa_exempted_by_admin` | |
| B-08 | Admin: Users → tick 2 users → **Exempt selected** | Both show *Exempt* | |
| B-09 | Admin: **Exempt everyone from 2FA**, then **Remove exemption for everyone** | All exempt, then none exempt | |
| B-10 | Admin: policy **Disabled for all users** | Enrolled users sign in without a code | |
| B-11 | Admin: user → **Unlink authenticator** | That user's 2FA is removed; under *Required* they enrol again | |
| B-12 | *My account* → **Generate new recovery codes** | Password **and** a current authenticator code (or a recovery code) are required; new codes shown; old codes no longer work | |
| B-13 | *My account* → **Disable two-step verification** with the right password but a wrong code | Refused; with the password and a correct code it is disabled (log `mfa_disabled_by_user`) and the user's other sessions end | |
| B-14 | At the 2FA step after the password, enter wrong codes until refused | After the limit: "Too many attempts — wait N seconds"; the failures count towards the account pause; a correct code during the pause is refused | |
| B-15 | Admin → user → **Unlink authenticator** while that user is signed in elsewhere | The user's sessions end (signed out) | |

### C. Tracking
| ID | Steps | Expected result | Result |
|---|---|---|---|
| C-01 | Open the dashboard | Total %, counters, 4 department cards, lowest 5 applications, test distribution | |
| C-02 | Compare the totals with the original tracker file after import (Settings → Data → Import) | Same department percentages (e.g. Infrastructure 52.8 %) | |
| C-03 | Open a department, then an application | Breadcrumb shows the path; functions listed with code, source, reference, vendor status | |
| C-04 | Change a function's progress from 0 to 60 and press Enter | Saved; the application % updates; *Last change* shows your name | |
| C-05 | Set test status to *Failed* and write a note | Saved; the note icon is highlighted | |
| C-05b | Choose *Passed with note* (or notifications *Working with notes*, or review *Present with notes*) on an item without a note | The note window opens; **Save** is disabled until a note is typed; **Cancel** keeps the old status; after saving, status and note are both stored. The note cannot be cleared while such a status is set | |
| C-06 | Tick a disabled "from experience" item | It counts in the calculation; the application % changes | |
| C-07 | **Bulk set** progress = 100 | All enabled functions become 100 % | |
| C-08 | **Add function** with weight 1, progress 100, included | The impact table shows application / department / project before → after; after confirming the row appears with a new `C…` code and the percentages match the preview | |
| C-08a | Add a function with «include» unticked | Row added, percentages unchanged | |
| C-08b | **Remove** a scope function (e.g. `D1`) | Reason is mandatory; impact shown; the row disappears and the percentages change; «Show removed» lists it with who / when / why | |
| C-08c | **Restore** the removed function | It returns included; percentages back as before | |
| C-08d | Tick / untick ✓ on a function | Confirmation window with the impact; Cancel changes nothing | |
| C-08e | As a team member, add and remove a function | «Sent for approval»; nothing changes until the team lead approves on «Edit approvals» | |
| C-08f | Export JSON after removing a function, then import that file | The removed function is not in the file and stays removed | |
| C-09 | Filter by source / test status / text | The list narrows correctly | |
| C-10 | Weights: change an application weight and save | Department shares change; audit shows old → new weight | |
| C-11 | Weights: switch to *Automatic* | Weights follow the sum of the function weights | |
| C-12 | Reports: edit an application's reports % and status | Saved; the application % changes by the reports share | |
| C-13 | Schedule: set the start date and 11 monthly periods, enter actual values, save | Curve starts at 0 % on the start date and shows planned vs actual; a «Today» point shows the current computed progress | |
| C-13a | Check the curve KPIs against the table | Planned as of today is interpolated between the two periods around today; deviation = actual now − planned now; SPI = actual now ÷ planned now | |
| C-13b | Open the dashboard; hover over the curve; click «Details» | Dashboard shows the curve card with the same 4 KPIs; tooltip shows planned/actual/deviation per period; link opens the curve page | |
| C-13d | Settings → project timeline: set start and close dates, save | Curve periods follow the dates; the curve page shows the dates read-only; close before start is refused | |
| C-13e | Open «Project status» | Status badge, time vs work bars, delay in days, SPI / SPI(t), pace, forecast close date, departments vs plan and recommendations are shown | |
| C-13f | Log in as a department user and open «Project status» | Only that department's figures are shown | |
| C-13c | Start date 31 Jan with monthly periods | Period 1 ends on 28/29 Feb (not 3 Mar) | |
| C-14 | Search for an Arabic word from a function name | Matching functions are listed with links | |

### D. Roles, permissions and scope
| ID | Steps | Expected result | Result |
|---|---|---|---|
| D-01 | Sign in as `uat.qa` and open an application | Only test status, review and note are editable; progress and weight are disabled | |
| D-02 | Sign in as `uat.hr` | Only the HR department is visible; opening `/app/acc` shows "outside your scope" | |
| D-03 | Sign in as `uat.editor` | Only the Payroll application is visible and editable | |
| D-04 | Sign in as `uat.view` | Everything is read-only; no Administration menu | |
| D-05 | Admin: grant `uat.qa` the extra permission *Edit progress* | `uat.qa` can now edit progress | |
| D-06 | Admin: try to change their own role, or disable themselves | Refused | |
| D-07 | Admin: try to demote the only administrator | Refused ("at least one active administrator") | |
| D-08 | Admin: give `uat.hr` (or a Project Manager) the *Manage users* permission | Refused: «صلاحية إدارة المستخدمين لمسؤولي النظام فقط»; *Users* is not in their menu | |
| D-09 | `uat.admin` tries to widen their own permissions or scope, or exempt themselves from 2FA | Refused; `uat.admin2` can do it for them | |
| D-10 | Sign in as `uat.noscope` (scoped role, nothing ticked) | Dashboard, departments, logs and approvals show **no data**; the Users list marks the account «بلا نطاق / No scope» | |
| D-11 | A team lead scoped to **one application** opens an edit request or import batch of another application of the same department | Not listed / cannot approve | |
| D-12 | Two administrators remove each other's admin role at the same time (two browsers) | One change is refused («at least one active administrator») | |

### E. Logs & audit
| ID | Steps | Expected result | Result |
|---|---|---|---|
| E-01 | Logs → *Audit trail* after C-04 | A row `update function` with old `{progress:0}` and new `{progress:60}` | |
| E-02 | As `uat.admin`: Logs → *Login & security*, filter Result = Failure | Only failed events | |
| E-03 | Logs → *Request log* | API requests with status and duration | |
| E-04 | Logs → *System* | `startup`, `migration`, `seed` events present | |
| E-05 | **Export CSV** and open it in Excel | Arabic text readable; columns as on screen | |
| E-06 | Sign in as `uat.hr` → Logs | Only the *Audit trail* tab, limited to HR, **without IP addresses** (also in its CSV export); no statistics cards | |
| E-06b | Sign in as `uat.pm` → Logs; open `/api/logs/auth` in the browser | Only the audit trail; the API answers 403 `admin_only` for the login & security, request, error and system logs | |
| E-07 | On the server: `ls /var/log/ets` | `app.log`, `error.log`, `access.log` exist and are growing | |
| E-08 | Admin: Logs → **Verify log integrity** | Both chains reported intact; audit row `verify` / `log` | |
| E-09 | Server: `cd /opt/ets/backend && sudo -u ets env ETS_ENV_FILE=/etc/ets/ets.env LOG_DIR=/var/log/ets node scripts/verify-audit.js; echo $?` | `OK` for `audit_log` and `auth_log`; exit code 0 | |
| E-10 | Settings → «Keep the audit trail» = 300 | Refused (minimum 365); 400 accepted, and the change is in the audit trail | |
| E-11 | Server (local database): `sudo ets-log-protect status` | `protected` (owner `ets_log_owner`), exit code 0 | |
| E-12 | Server: `sudo -u ets psql -h 127.0.0.1 -U ets -d ets -c "UPDATE audit_log SET username='x'"` (password from `/etc/ets/ets.env`), and the same with `DELETE FROM audit_log`, `TRUNCATE audit_log`, `DROP TRIGGER ets_append_only ON audit_log` | Every statement refused (*permission denied* / *must be owner*); nothing changes | |

### H. Team result files and approvals
Accounts: `uat.pm` (Project Manager), `uat.comlead` (Team Lead, scope Commercial), `uat.commember` (Team Member, scope Commercial).

| ID | Steps | Expected result | Result |
|---|---|---|---|
| H-01 | As `uat.commember`: Imports & approvals → Import results file → choose the commercial team's JSON | The options list only Commercial and "Reports" (scope), each with its number of changes and effect | |
| H-02 | Try to submit without choosing an option | Submit stays disabled / "Choose a department or reports" | |
| H-03 | Choose Commercial → Submit for approval | Batch "Awaiting approval"; the Commercial percentages on the dashboard do **not** change yet; values of other departments in the file are not listed | |
| H-04 | As `uat.comlead`: dashboard and sidebar | Notice "batch awaiting approval" and a red badge "1"; the batch shows before/after per value | |
| H-05 | `uat.comlead` approves | Lead approval signed; results still unchanged | |
| H-06 | As `uat.pm`: approve | Status "Approved and applied"; Commercial percentages now show the new values; audit trail has `import_apply` | |
| H-07 | Repeat H-01/H-03 with option **Reports**; `uat.pm` rejects with a reason | Status "Rejected" with the reason; reports unchanged | |
| H-08 | Upload two files for the same department before approval | The first batch becomes "Replaced by a newer file" | |
| H-09 | The same person tries to sign both approvals (user with both permissions) | Second signature refused | |
| H-10 | `uat.comlead` uploads a file, then tries to sign it; `uat.pm` uploads a file and tries the final approval | Both refused: the uploader signs neither stage | |

### I. Data-entry edits approved by the team lead
| ID | Steps | Expected result | Result |
|---|---|---|---|
| I-01 | As `uat.commember`: change a Commercial function's progress | Message "sent for approval"; the approved value stays; a yellow "awaiting approval" chip shows the new value | |
| I-02 | As `uat.comlead`: dashboard / sidebar | Notice "edits awaiting your approval" and a red badge on «اعتماد التعديلات» | |
| I-03 | `uat.comlead` approves | The value changes; the function shows the member as last editor; no PM approval needed | |
| I-04 | Member edits again; lead rejects with a reason | Value unchanged; the member sees "rejected" and the reason under "My requests" | |
| I-05 | Member edits a report and runs a bulk set | Both appear as requests; "Approve all shown" applies them | |
| I-06 | As `uat.comlead` and `uat.pm`: edit a value | Applied immediately (no request) | |
| I-07 | Another department's lead opens the request | Cannot approve it | |
| I-08 | Settings → Approvals: switch off; member edits | Applied immediately | |

### F. Administration & operations
| ID | Steps | Expected result | Result |
|---|---|---|---|
| F-01 | Settings: change the system name (AR/EN) | The login screen and navbar show the new name | |
| F-01b | Settings → Branding: upload a logo, a favicon and a login background; then sign out | New logo in the top bar and login screen, new browser-tab icon, background picture behind the login form; "Restore default" brings back the original | |
| F-02 | Settings → Data → **Export data** | A JSON file downloads | |
| F-03 | Server: `sudo ets-backup` | A new encrypted `.dump.gpg` and its `.sha256` in `/var/backups/ets`; no `ets.env` copy there | |
| F-04 | Server: restore the dump on a test DB (doc 08 §6) | The function count matches | |
| F-05 | Server: `sudo systemctl restart ets-backend` | The site is back within seconds; log `startup` | |
| F-06 | Server: reboot | ETS starts automatically | |
| F-07 | Test server only: `sudo ets-restore <latest .dump.gpg>` (type YES) | Checksum and decryption checked; safety backup taken; data restored; `sudo ets-log-protect status` → protected; audit row `restore` / `database` | |
| F-08 | Server: `sudo bash deploy/scripts/update.sh` from the same release copy | Backup taken, `update ok`; audit trail still protected | |
| F-09 | Check that the backup key and `ets.env` are escrowed (08 §2) | The escrowed key's `sha256sum` matches `/etc/ets/backup.key` | |

### G. Usability
| ID | Steps | Expected result | Result |
|---|---|---|---|
| G-01 | Use the system on a phone | The menu opens from the ☰ button; pages fit the screen without horizontal scrolling | |
| G-02 | Check the font | Cairo is used in Arabic and English (also without internet) | |
| G-03 | Arabic screens | Right-to-left layout; numbers and percentages display correctly (e.g. `49.2%`) | |

## 3. Exit criteria
- All cases in A, B, D and E pass, and F-03, F-07 and F-09.
- No open defect of severity *Critical* or *High*.
- Other failures have an agreed fix date.

## 4. Defect list
| # | Case ID | Description | Severity (Critical/High/Medium/Low) | Reported by / date | Status |
|---|---|---|---|---|---|
| | | | | | |
