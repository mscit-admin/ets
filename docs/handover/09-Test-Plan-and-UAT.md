# 09 — Test Plan & User Acceptance Testing (UAT)

## 1. Scope and approach

| Level | Who | How | Status at handover |
|---|---|---|---|
| Unit tests | Developer | `backend/test/totp.test.js`, `calc.test.js` | 9 tests, all pass |
| API integration tests | Developer | `backend/test/api.test.js` against a disposable PostgreSQL DB | 14 tests, all pass |
| UAT | Customer | The test cases below, run in the browser on the installed server | To be run by the customer |

How to run the automated tests:

```bash
sudo -u postgres createdb -O ets ets_test
cd backend && TEST_DATABASE_URL=postgres://ets:<pw>@127.0.0.1/ets_test npm test
# expected: "# tests 23  # pass 23  # fail 0"
```

> `ets_test` is wiped by the tests. **Never** point `TEST_DATABASE_URL` at the production database.

### Test environment for UAT
- Server installed per [02-Installation-Guide.md](02-Installation-Guide.md); browsers Chrome/Edge/Firefox
  (latest) and a phone browser.
- Test accounts created by the administrator: `uat.admin` (System Administrator), `uat.hr` (Department
  Manager, scope HR), `uat.editor` (Application Editor, scope Payroll), `uat.qa` (Tester), `uat.view`
  (Observer).
- A phone with Google Authenticator or Microsoft Authenticator.

### Recording results
For each case write **P** (pass) or **F** (fail), the date and initials. For a failure, add the observed
result and a screenshot to the defect list (§4).

## 2. Test cases

### A. Login & passwords
| ID | Steps | Expected result | Result |
|---|---|---|---|
| A-01 | Open the site over `http://` | Redirected to `https://` | |
| A-02 | Sign in with a correct username and password (2FA policy *Optional*, user not enrolled) | Dashboard opens; *Logs → Login & security* shows `login` success | |
| A-03 | Sign in with a wrong password | "Incorrect username or password"; log shows `login_bad_password` | |
| A-04 | Sign in with a non-existent username | Same message as A-03 (does not reveal that the user does not exist); log `login_unknown_user` | |
| A-05 | Enter a wrong password 5 times, then the correct one | Account locked message; log `account_locked`; the admin sees the user as *Locked* | |
| A-06 | Admin → user → **Unlock**; user signs in | Login works; log `account_unlocked_by_admin` | |
| A-07 | Admin creates a user with "must change password"; user signs in | The *Change password* screen appears; no other screen is reachable until it is changed | |
| A-08 | Try a new password `abc` | Refused with the policy message | |
| A-09 | Change the password correctly | Dashboard opens; log `password_changed` | |
| A-10 | Stay idle for 60 minutes, then click anything | Returned to the login screen | |
| A-11 | Click the avatar → **Log out** | Login screen; log `logout` | |
| A-12 | Switch language on the login screen | All texts switch Arabic ↔ English and the direction changes RTL ↔ LTR | |

### B. Two-factor authentication
| ID | Steps | Expected result | Result |
|---|---|---|---|
| B-01 | *My account* → **Enable two-step verification**, scan the QR, enter the code | 10 recovery codes shown; status *Enabled* | |
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
| B-12 | *My account* → **Generate new recovery codes** (password required) | New codes shown; old codes no longer work | |

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

### E. Logs & audit
| ID | Steps | Expected result | Result |
|---|---|---|---|
| E-01 | Logs → *Audit trail* after C-04 | A row `update function` with old `{progress:0}` and new `{progress:60}` | |
| E-02 | Logs → *Login & security*, filter Result = Failure | Only failed events | |
| E-03 | Logs → *Request log* | API requests with status and duration | |
| E-04 | Logs → *System* | `startup`, `migration`, `seed` events present | |
| E-05 | **Export CSV** and open it in Excel | Arabic text readable; columns as on screen | |
| E-06 | Sign in as `uat.hr` → Logs | Only the *Audit trail* tab, limited to HR | |
| E-07 | On the server: `ls /var/log/ets` | `app.log`, `error.log`, `access.log` exist and are growing | |

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

### G. Usability
| ID | Steps | Expected result | Result |
|---|---|---|---|
| G-01 | Use the system on a phone | The menu opens from the ☰ button; pages fit the screen without horizontal scrolling | |
| G-02 | Check the font | Cairo is used in Arabic and English (also without internet) | |
| G-03 | Arabic screens | Right-to-left layout; numbers and percentages display correctly (e.g. `49.2%`) | |

## 3. Exit criteria
- All cases in A, B, D and E pass.
- No open defect of severity *Critical* or *High*.
- Other failures have an agreed fix date.

## 4. Defect list
| # | Case ID | Description | Severity (Critical/High/Medium/Low) | Reported by / date | Status |
|---|---|---|---|---|---|
| | | | | | |
