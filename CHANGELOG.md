# Changelog — سجل التغييرات

This file records every notable change to ETS (ERP Tracking System): new features, changes, fixes, security work,
dependency upgrades and the steps an operator must take when updating. Newest version first. It is the single
place for release notes; the handover documents point here.

> يسجّل هذا الملف كل الإضافات والتعديلات والإصلاحات والتحديثات والترقيات في نظام ETS، الأحدث أولاً.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

### How to update this file

- **Every change** (code, database, deployment, dependencies, documentation that changes behaviour) adds a line
  under `## [Unreleased]`, in the right category: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**,
  **Security**, plus **Upgrade notes** for anything an operator must do or check (migrations, `update.sh`, nginx,
  new settings, one-time actions). Use only the categories that apply.
- Start an entry with its area in bold when it helps: **Backend**, **Frontend**, **Database**, **Deployment**,
  **Docs**, **Tests**. Keep it to one or two lines; name files, endpoints, error codes and security IDs
  (`ETS-SEC-xxx`) exactly.
- A database change always comes with a new numbered migration in `backend/src/db/migrations/`, named in
  **Upgrade notes**.
- **On release:** rename `[Unreleased]` to `[x.y.z] — YYYY-MM-DD — short title`, set the version in both
  `package.json` files and lockfiles, add a new empty `[Unreleased]` above it, and update the compare links at the
  bottom of this file.

---

## [Unreleased]

---

## [1.12.26] — 2026-10-25 — in-app messaging / الرسائل

### Added
- **In-app messaging (new «الرسائل» / "Messages" screen):** a user with the new permission `msg` composes a message
  and sends it to selected recipients — specific individuals (searchable multi-select), everyone, by department or
  by role (combinable) — and each recipient gets a **private 1:1 conversation** with the sender and can reply,
  forming a back-and-forth thread. A message sent to "everyone" becomes a **separate private thread per recipient**:
  a recipient never sees another recipient's thread or replies. Backend `backend/src/services/messages.js` +
  `backend/src/routes/messages.js` mounted at `/api/messages`: `POST /` (send, `msg`, rate-limited, audited),
  `POST /resolve` + `GET /recipients` + `GET /compose-meta` (compose, `msg`), `GET /inbox`, `GET /sent` (`msg`),
  `GET /sent/:id` (author only), `GET /threads/:id` (party only — 403 otherwise, marks read),
  `POST /threads/:id/reply` (party only), `GET /unread-count` (nav badge). Three new tables (`message_broadcasts`,
  `message_threads`, `message_posts`). Frontend `frontend/src/pages/Messages.jsx` (lazy-loaded; inbox / sent /
  compose / chat-style thread view with a reply box, RTL), a nav entry with an unread badge, AR+EN i18n.
- **New permission `msg` («إرسال الرسائل» / "Send messages"):** grantable per user (Users permission editor,
  `perm_msg` AR/EN). It grants the ability to **send within the sender's own visible scope only** — it never widens
  who the sender can see: the recipient set is always intersected with the sender's scope (the existing
  `canSee` / scope model), so a scoped sender can never message a user outside it and a full-scope sender reaches
  everyone. Receiving and replying need **no** permission.
- **Two new notifications** (category `messages`): `message_received` (M1 — a new message, to the recipient) and
  `message_reply` (M2 — a reply, to the other party: recipient → sender, sender → recipient). Both are per-user
  **directed** alerts (scope `self`, no permission gate, severity info, phone allowed). Added to the catalog
  (`notify-catalog.js`), text (`notify-text.js`, AR/EN), events (`notify-events.js`), the Notifications page filter
  and the bell / profile category tabs (`ncat_messages`, `nt_message_received`, `nt_message_reply`, AR/EN), and the
  policy matrix (derived from the catalog).

### Changed
- **Database:** `notifications.category` now also accepts `messages` (was `tracking / approvals / plan / security /
  system`).

### Upgrade notes
- **Migration 026** (`026_messaging.sql`, forward-only and idempotent like 025) creates `message_broadcasts`,
  `message_threads` and `message_posts` with their indexes, grants the new permission `msg` to the **admin role
  only** (a new capability — not copied from any per-user override, like `mov` / `ren`), and widens the
  `notifications_category_check` constraint to include `messages`. Runs automatically on deploy (`update.sh` →
  `db/migrate.js`). The seed run at every start also lists `msg` for the admin role, so a fresh install agrees.
- Grant `msg` to any non-admin who should be able to send (e.g. a department lead) from Users → user →
  «إرسال الرسائل». Optional send/reply rate limits: `ETS_MESSAGE_SEND_LIMIT` (default 60/h), `ETS_MESSAGE_REPLY_LIMIT`
  (default 240/h).
- Messaging is **web-first**; display on the Android app may be added later.

---

## [1.12.25] — 2026-10-25 — «إعادة الاختبار» test status & its tester alert

### Added
- **New test status «إعادة الاختبار» / "Needs re-testing" (`functions.test_status` = 4):** a fifth value for
  functions / report items alongside Not tested (0), Passed with note (1), Passed (2) and Failed (3). It is a
  **not-passed, needs-testing** state — it does **not** count as tested or passed (the «نجح» = 100 % rule of
  1.8.1 / 1.12.21 and `tested_ok` are unaffected, and it is never a pass conflict) — and it **requires a note**
  like «نجح مع ملاحظة», enforced on both the client (`frontend/src/lib/itemRules.js` `NOTE_REQUIRED`, now a set of
  values per field) and the server (`backend/src/routes/tracker.js`: the single PATCH and the bulk path). Selectable
  across the Application table / test-status filter / bulk dialog, shown in the Dashboard and department test-status
  distributions, the project-status quality panel and the Excel export, in a distinct amber tone (`TEST_COLORS`,
  `--amber-*`). i18n `ts_4` (AR/EN). Imports / legacy restore accept `0..4` for `test_status`.
- **New notification T10 `retest`** (category tracking, periodic, warning, **testers only** — perm `tst`, scope
  app-or-dept, push + digest): alerts when an item sits in «إعادة الاختبار» (`test_status` 4) longer than the new
  `notify.retest_days` threshold (default 3, range 1–60, editable in Settings → «الإشعارات» → العتبات). Added to
  the periodic scan (`notify-scan.js`), catalog (`notify-catalog.js`), text (`notify-text.js`, AR/EN), the
  Notifications page filter (`nt_retest`, AR/EN) and the policy matrix (derived from the catalog). T2 `untested`
  and T3 `failed_retest` are unchanged.

### Changed
- **Database:** `functions.test_status` now allows `0..4` (was `0..3`); existing values 0–3 keep their meaning and
  nothing is renumbered. `notif_status` / `review_status` bounds are untouched.

### Upgrade notes
- **Migration 025** (`025_retest_status.sql`, forward-only and idempotent like 022 / 023) drops and re-adds the
  `functions_test_status_check` constraint, widening it from `BETWEEN 0 AND 3` to `BETWEEN 0 AND 4`; `DEFAULT 0` is
  unchanged and there is no backfill. Runs automatically on deploy (`update.sh` → `db/migrate.js`).
- A new setting `notify.retest_days` (default 3) drives the T10 `retest` alert; no action needed unless you want to
  tune it in Settings → «الإشعارات».

### Tests
- **Backend:** `test_status` five-state coverage in `api.test.js` (state 4 needs a note, out-of-range 5 rejected,
  4 is not a pass / not a conflict, bulk 4 needs a note) and the T10 `retest` alert in `notifications.test.js`
  (fires for testers past the threshold, reaches `tst` holders and not others, T2/T3 unaffected, the summary closes
  once the item leaves state 4).

---

## [1.12.24] — 2026-10-25 — faster first load & single favicon request

### Changed
- **Frontend/Build:** the SPA is now **code-split** for a smaller first load. Authenticated pages (Dashboard, Users,
  Settings, Application, Approvals, Reports, Logs, …) load on first navigation via `React.lazy`, behind a single
  `<Suspense fallback={<Loading/>}>` around the router outlet (`frontend/src/App.jsx`, `components/Layout.jsx`); React
  and React-Router move to a long-lived `vendor` chunk via `build.rollupOptions.output.manualChunks`
  (`frontend/vite.config.js`); and the Excel libraries stay dynamically imported (users-import only). The entry/app
  chunk shrinks from **859 kB (≈246 kB gzip)** to **55 kB (≈16 kB gzip)**, and initial JS (entry + vendor + i18n)
  is **≈540 kB raw / ≈164 kB gzip**; the rest loads per-page on demand.

### Fixed
- **Frontend/Branding:** the browser no longer issues a **second, aborted `favicon.svg` request** (`NS_BINDING_ABORTED`).
  The branding effect now swaps `<link rel="icon">` only when a **custom favicon/logo is actually uploaded**, instead of
  re-assigning the default icon's `href`/`type` on every load — which aborted the request the browser had already made
  from `index.html`. The custom-favicon branding feature is unchanged (`frontend/src/lib/branding.jsx`).

---

## [1.12.23] — 2026-10-24 — S13: distributed login-probing alert

### Added
- **Backend/Notifications:** a new security alert **S13 `distributed_logins`** (admin only, in-app only, critical)
  for a **DISTRIBUTED login-probing pattern** — when the **TOTAL `login_unknown_user` («معرّف غير موجود») across ALL
  source IPs combined** in a window exceeds a threshold, even when no single IP trips the per-IP **S2 `failed_logins`**
  (`backend/src/services/notify-catalog.js`, `notify-scan.js` security check). The scan sums unknown-user attempts over
  the window and reports the total count and the number of distinct IPs; it fires **at most once per window** (dedupe
  key = the window bucket). Two configurable settings, editable in **Settings → «الإشعارات» → العتبات**:
  `notify.distributed_login_threshold` (default `20`) and `notify.distributed_login_window_min` (default `15`). AR/EN
  text and the `nt_distributed_logins` / `ns_distributed_login_*` labels added; the type appears in the Notifications
  page filter and the policy matrix. No migration (settings keys default via the seed, `ON CONFLICT DO NOTHING`).

### Security
- **Catches distributed account enumeration that evades the per-IP S2 check** (ETS-SEC-047 eligibility: admin role
  only). A real pen-test spread a handful of unknown-user attempts across ≈11 IPs so no single IP reached the per-IP
  threshold; S13 sums across all IPs to detect exactly this. It **complements, not replaces,** S2's per-IP and
  all-together branches.

---

## [1.12.22] — 2026-10-24 — Fix: re-seeding reverted a moved application's department

### Fixed
- **Database/Seed:** the idempotent catalog seed (`backend/src/db/seed.js`), which runs on every deploy, reset each
  application's `department_id` back to the catalog value on conflict — silently **reverting any «نقل التطبيق إلى
  إدارة أخرى» move (1.12.16)** on the next update. The applications upsert no longer touches `department_id` on
  conflict: the catalog department is the **initial placement only** (applied on first INSERT); after that a move
  (`application_moves`) owns it — mirroring how the functions seed already respects `function_moves` and how user-owned
  `weight` is left untouched. Catalog display fields (names, icon, sort…) still refresh, and brand-new catalog apps are
  still placed correctly.

### Upgrade notes
- No migration. After deploying this version, re-apply any application move that an earlier deploy reverted (the move
  then persists across future updates). Item moves (`function_moves`) were never affected.

---

## [1.12.21] — 2026-10-24 — «نجح» auto-sets 100 %

### Changed

- **Frontend + Backend.** Choosing the test status «نجح» (`test_status: 2`, plain pass) on an item below 100 % now
  **auto-sets its progress to 100 %** and saves both together, instead of blocking with `pass_needs_100_now` /
  `pass_requires_100` — reversing the 1.8.1 "no auto-fill" behaviour (the user no longer has to enter 100 % first).
  A confirmation is shown before the auto-fill: a dialog for a single item (`PassFillModal`) and a confirmation step
  in the bulk modal; cancelling saves nothing. Applies to the single-item change (`PATCH /tracker/functions/:id`), the
  bulk set (`POST /tracker/applications/:id/bulk`, `field: "test_status"`) and the edit-request approval path (the
  request carries both `test_status: 2` and `progress: 100`). The **server is the single source of truth**:
  `withPassProgress(cur, changes)` (`backend/src/services/passRule.js`) adds `progress: 100` whenever a write sets
  «نجح» below 100, after the per-field permission check so a user with only `tst` (not `pct`) can mark «نجح». A bulk
  «نجح» brings every newly-passed item to 100 % but leaves an item already «نجح» below 100 % (a pre-1.8.1 conflict)
  untouched.
- The guard that a passed item's progress **cannot be lowered** below 100 while it stays «نجح»
  (`progress_below_100_while_passed`) is unchanged, and **imports** keep the 1.8.1 rule (a row setting «نجح» below
  100 % is still a row error — imports are not auto-filled).

### Docs

- `docs/handover/04-User-Guide-AR.md` and `docs/handover/11-API-Reference.md` updated to describe the auto-set
  behaviour (single + bulk) in place of the old "enter 100 % first" block.

---

## [1.12.20] — 2026-10-23 — Release promotion pipeline — Phase 3 (feature-complete: rollback, health gating, history)

The test→production release-promotion pipeline (design in `docs/handover/13-Release-Promotion-Design.md`) is now
**feature-complete**. Phase 3 adds the operator-facing finish: a full history view, an extended health gate that
explains WHY a deploy failed, the completed auto-rollback decision with the manual DB-restore guidance, the current
production/agent-freshness display, and release-event alerts. **Live use still requires operator setup** (keys,
deploy credentials, systemd units — see `docs/handover/13` §8a and `docs/handover/10` §3a/§3b); nothing new is enabled
automatically.

### Added
- **Promotion history view** (`frontend/src/components/ReleasePromotion.jsx`): an expandable per-promotion table —
  version, who authorized, time, final status, backup_ref, the phase progression and the health-check detail; RTL,
  Arabic + English.
- **Extended health gate** (`backend/src/release/deploy-agent.js`): a readiness sweep (app `/api/health`, an optional
  known endpoint `READY_URL`, the database reachable, migrations applied) with a configurable timeout + exponential
  retry/backoff (`HEALTH_TIMEOUT`, `HEALTH_RETRY_DELAY`, `HEALTH_RETRY_MAX`, `HEALTH_REQUIRE`). The **pure, unit-tested
  reducer `evaluateHealth()`** (`backend/src/services/release.js`) turns the probe results into a pass/fail verdict +
  human-readable summary, recorded in the promotion `result` / signed `production-status.json` so the Release screen
  shows the failing check.
- **Completed auto-rollback decision** (`rollbackDecision()`, pure + unit-tested, `backend/src/services/release.js`):
  `{auto_rollback, migration_ran, health_passed, backup_ref, prev_commit}` → `none` | `code_rollback` | `stop` |
  `stop_needs_db_restore`. A migration-after-failure stops at `failed` and records the exact `ets-restore <backup_ref>`
  command; the Release screen surfaces it in a **«استرجاع قاعدة البيانات»** guidance panel (manual — DB rollback is
  never automatic, per design §5.3). The «تراجع» rollback button drives a code-rollback promotion and shows in history.
- **Current production + agent-freshness display**: the Release screen shows the deployed version/commit, last deploy
  time and the deploy-agent heartbeat with a **staleness warning** when production has not reported recently. The
  read-only `GET /api/release/status` serves this on both servers (on production it reads that server's own
  `release_agent_status`); no separate prod endpoint was needed.
- **S-REL notification class** (`release_event`, **S12**): a production promotion **started / succeeded / failed /
  rolled_back** alerts every administrator (`backend/src/services/notify-catalog.js`, `notify-text.js`,
  `notify-events.js`; Notifications page filter + `nt_release_event` label, AR/EN). **failed / rolled_back are
  critical** (phone); started / succeeded informational. `started` is sent by the API on `/promote`; the terminal
  stages by the test-side publisher when it pulls the signed production status.

### Changed
- `GET /api/release/versions` and `/status` now report **`phase: 3`** (the API-contract marker; the pipeline is
  complete). The Phase-1 note on the Release screen is replaced with a feature-complete note.

### Tests
- Unit tests for `evaluateHealth` (pass / failed-check / no-checks / required-not-run), `rollbackDecision` (every
  branch of the table), `releaseNotifyStage` + `releaseStageSeverity`; API tests for `phase: 3`, the history row shape
  and the S12 `started` alert firing on `/promote` (`backend/test/release.test.js`).

### Upgrade notes
- **No new migration.** `release_promotions.progress`/`result` (migration **024**) already carry the health verdict
  and the rollback action; `release_event` (S12) is a code-only notification type. The latest migration remains **024**.
- No operator action is required by this release itself. The live pipeline still needs the Phase-2 operator setup
  (`docs/handover/13` §8a); the new **DB-restore-after-failed-migration** procedure is documented in
  `docs/handover/10` **§3b** and is linked from the Release screen's guidance panel. Optional deploy-agent config keys
  (`READY_URL`, `HEALTH_RETRY_DELAY`, `HEALTH_RETRY_MAX`, `HEALTH_REQUIRE`) default sensibly when unset.

---

## [1.12.19] — 2026-10-23 — Release promotion pipeline — Phase 2 (the root agents, signing & systemd)

### Added
- **Release promotion pipeline, PHASE 2 — the real root agents, signing and systemd** (design in
  `docs/handover/13-Release-Promotion-Design.md`; **requires operator setup — see §8a and `docs/handover/10` §3a**).
  Two unprivileged-API-never-root agents mirror `ets-backup-agent`:
  - **`ets-release-publisher`** (TEST server; `deploy/scripts/release-publisher.sh` →
    `backend/scripts/release-publisher.js` → `backend/src/release/publisher.js`; units
    `deploy/systemd/ets-release-publisher.{service,timer,path}`). Reads the latest `release_promotions` row in status
    `requested` **from the database**, re-verifies the signed manifest, creates/pushes the **annotated signed git tag
    `v<version>`**, writes + pushes the signed manifest `deploy/production-release.json(+.sig)` via a write-restricted
    deploy key, sets the row `publishing`, and pulls the signed `production-status.json` back.
  - **`ets-deploy-agent`** (PRODUCTION server; `deploy/scripts/deploy-agent.sh` →
    `backend/scripts/deploy-agent.js` → `backend/src/release/deploy-agent.js`; units
    `deploy/systemd/ets-deploy-agent.{service,timer,path}`). Fetches, verifies the signal (signature, **real
    `git merge-base --is-ancestor`** ancestor check, strictly-newer/rollback, freshness + one-time nonce,
    prev-match), takes a pre-deploy `ets-backup`, checks out the tagged commit, runs `update.sh`, **health-gates**
    `/api/health`, and signs + pushes the status back. On a failed health check with `AUTO_ROLLBACK=on` and **no
    migration applied** it performs the **code rollback** (checkout prev + `update.sh`); when a migration ran it stops
    at `failed` with `backup_ref` + `needs_db_restore=true` (DB restore is the §5.3 manual / Phase-3 path).
- **Shared no-shell verifier `deploy/release/verify.mjs`** (ESM) — imports the pure `backend/src/services/release.js`,
  verifies a manifest + detached signature against a directory of allow-listed signer public keys, and exits 0/1/2
  with a machine-readable JSON reason. Both agents call it (no crypto in bash). A `--mode signature` check verifies
  the status back-channel file. New `backend/test/release-verify.test.js` exercises every rejection against the real
  helper process.
- **Install hooks** (`deploy/scripts/deploy-lib.sh`): `install_release_agent_files` installs the agent scripts, the 6
  units and `verify.mjs` on both servers (enabling nothing automatically); `ensure_release_signing_key` generates the
  Ed25519 release keypair on the test server only when `ETS_RELEASE_GENERATE_KEY=1`. Example role configs
  `deploy/release-publisher.conf.example` and `deploy/deploy-agent.conf.example`.

### Security
- The signal's authenticity is the **Ed25519 signature over the canonical manifest**, independent of git transport: a
  compromised repo or a leaked deploy key cannot forge a production deploy (a bad/unknown-signer/replayed/downgrade/
  non-ancestor/prev-mismatched signal is **rejected and logged**, nothing deployed). Signing keys live only in
  root-owned files (never in the DB or the repo); the API (user `ets`) stays unprivileged and holds no push credential.
- The **ancestor check is now real** in the production agent (the Phase-1 stub, `checkAncestor` in
  `services/release.js`, completed with the git working copy): a signal pointing at a commit that is not an ancestor
  of the default branch is refused. Agents use allow-listed argument-array `run()` (no shell) and a writable-file
  allow-list — the only files they write in the repo are the signal / status files.

### Upgrade notes
- **No database migration this phase.** `update.sh` installs the new agent scripts, the 6 systemd units and
  `verify.mjs` automatically, but **enables no timer and generates no key on its own.** To activate the pipeline the
  operator must provision keys, deploy keys and the per-server role conf and enable the role's units — follow
  `docs/handover/13` **§8a.5** (test: `ets-release-publisher`; production: `ets-deploy-agent`) and run the **§8a.4
  staging dry-run rehearsal BEFORE first real use**. The promotion/rollback runbook is `docs/handover/10` §3a.
- Signed tags need `git user.signingkey` + gpg configured for root on the test server, or set `TAG_SIGN=off` in
  `release-publisher.conf` for annotated (unsigned) tags. Escrow the release and status signing keys like the backup
  key.

---

## [1.12.18] — 2026-10-23 — Release promotion pipeline — Phase 1 (in-app foundation)

### Added
- **Test→production release promotion pipeline, PHASE 1** (the in-app foundation; design in
  `docs/handover/13-Release-Promotion-Design.md`). An administrator proves a version on the test server and records a
  **signed promotion request** to production from a new Settings tab. **No production deploy happens yet** — in Phase 1
  the deploy agent is mocked: nothing is pushed to git, no tag is created, no checkout/`update.sh`/health-check runs.
  The real root agents, signing-key install and systemd units are **Phase 2**.
- **Backend:** `backend/src/services/release.js` — pure, unit-tested manifest + **Ed25519 sign/verify** logic (Node
  `crypto`), reusing `canon()` from `backend/src/backup/config.js` for the canonical signed bytes. Verification checks
  (§3.1 of the design): signature against an **allow-listed signer**, **downgrade** block (strictly-newer version),
  **replay** block (freshness window + one-time nonce), and **prev-state** match are **full**; **commit membership** is
  partial — format + resolves-to-a-known-release is checked, the full `git merge-base --is-ancestor` ancestor check is
  a documented **Phase 2 stub** (needs the root agent's git working copy).
- **Backend:** `backend/src/routes/release.js` mounted at `/api/release` (admin-only: `cfg` + role `admin`).
  `GET /versions` (released versions resolved to a commit by an annotated tag `v<x.y.z>` when present, else the
  `release <x.y.z>` commit, each with its what-changed summary from `CHANGELOG.md`), `GET /status`, `GET /history`,
  and `POST /promote` / `POST /rollback` — each guarded by **re-authentication (password + OTP)** reusing
  `reauth()` from `routes/auth.js` (the same re-auth as the backup restore/escrow flow), a confirm-the-version step,
  a per-admin rate limit and a full audit (`logAudit` / `logSystem`). `/promote` signs the manifest and writes a
  `release_promotions` row with status `requested`; the actual publish/deploy is mocked. An `auto_rollback` boolean
  (default `true`) is stored for Phase 3 to honour.
- **Frontend:** Settings → «الترقية والنشر» / "Release & deploy" tab (admin-only),
  `frontend/src/components/ReleasePromotion.jsx` — current production/test state banner, a version picker with the
  what-changed preview, the `auto_rollback` toggle (default on), a «ترقية إلى الإنتاج» button that opens the existing
  password+OTP `ReauthModal` with a type-the-version confirm, and the current status + history. Clearly labelled as
  recording a promotion request (Phase 1). RTL, AR+EN (`frontend/src/i18n/messages.js`, `rel_*` + `set_tab_release`).

### Upgrade notes
- **Database:** new migration `backend/src/db/migrations/024_release_promotion.sql` — creates `release_promotions`
  (the promotion intent + lifecycle record, including the signed `manifest`/`signature`, `nonce`, `signer`,
  `prev_*`, `auto_rollback` and a `status` of `requested`/`publishing`/`deploying`/`succeeded`/`failed`/`rolled_back`/
  `cancelled`) and `release_agent_status` (the latest state the Phase 2 deploy agent reports back, plus the last
  applied `nonce`). Forward-only and idempotent (`CREATE TABLE/INDEX IF NOT EXISTS`); a **unique partial index** keeps
  at most one promotion in flight. No data backfill; runs with `update.sh` like any other migration.
- **This is Phase 1 (foundation only): no production deploy is performed.** New config/env keys (keys live only in
  root-owned files, never in the DB or the repo — same secrets rule as backups): `ETS_RELEASE_SIGN_KEY` (path to the
  Ed25519 release private-key PEM, default `/etc/ets/release-sign.key`; when unset/unreadable the promote button is
  disabled and `/promote` returns `release_signing_unavailable`), `ETS_RELEASE_SIGNERS_DIR` (allow-listed signer
  public-key PEMs, default `/etc/ets/release-trust`), `ETS_RELEASE_FRESHNESS_DAYS` (replay window, default 14) and
  `ETS_RELEASE_PROMOTE_LIMIT` (per-admin promote rate, default 10/hour). **Generating the signing key, the
  write-restricted deploy key and installing the root agents/systemd units are Phase 2** (design §8a).

---

## [1.12.17] — 2026-10-23 — Two more review states: «إطلاع» and «اعتماد»

### Added
- **Two new review states for functions / report items**, so `functions.review_status` now has **six** states
  instead of four: `4` «إطلاع» / "Acknowledged" and `5` «اعتماد» / "Approved". Both are **completed** reviews — like
  `1` Present and `3` Notes they are **not** counted as «المراجعة غير موجودة» / review-missing; only `2` Missing is.
  They appear as options in the review picker on the application page (`frontend/src/pages/Application.jsx`,
  `StatusSelect`) with distinct badge colours — blue for «إطلاع», purple for «اعتماد» — and are labelled everywhere
  a review value is shown (audit log `frontend/src/lib/audit.js`, Excel export `services/export-labels.js` +
  `routes/export.js`, imports preview, project status), AR+EN (`frontend/src/i18n/messages.js` `rv_4`/`rv_5`).

### Changed
- **The two existing review states `0` and `3` were relabelled** (their numeric values are unchanged): Arabic
  «لا تحتاج» → «لا توجد حاجة للمراجعة» and «موجودة مع ملاحظات» → «ملاحظات»; English "Not needed" → "No review needed"
  and "Present with notes" → "Notes". Choosing `3` (Notes) still makes the item's note mandatory. States `1`
  (Present/موجودة) and `2` (Missing/غير موجودة) are unchanged.
- **Validation widened from `0–3` to `0–5`** on every path that writes `review_status`: the single-field and bulk
  edit (`routes/tracker.js` `FIELD_OK`), the team-result import mapping (`services/imports.js`, new `int05`) and the
  legacy save path (`services/legacy.js`). The test and notification statuses keep their four states (`0–3`).

### Upgrade notes
- **Database:** new migration `backend/src/db/migrations/023_review_status_states.sql` — widens the named CHECK
  constraint `functions_review_status_check` on `functions.review_status` from `BETWEEN 0 AND 3` to `BETWEEN 0 AND 5`.
  Forward-only and idempotent (`DROP CONSTRAINT IF EXISTS` then `ADD CONSTRAINT`); `DEFAULT 0` unchanged, no data
  backfill. It runs with `update.sh` like any other migration; no operator action beyond running the migration.

---

## [1.12.16] — 2026-10-23 — Move a whole application to another department

### Added
- **Move an entire application (with all its functions / report items) from one department ("module", الإدارة) to
  another.** A new «نقل التطبيق» / "Move application" action on the application header (users with `mov`) opens a dialog
  to pick the destination department and a required reason (3–500 characters, spaces not counted — the item-move rule),
  shows the before → after impact on both departments and the project, and moves the application — directly or through a
  two-lead approval. The application keeps its id, weight, functions (ids, codes, values, statuses, provenance) and
  everything else; only its `department_id` changes. A «منقول من …» badge on the header records where it came from.
  - **Backend:** `services/app-move.js` (`moveApplication`, `moveAppNeedsApproval`, `checkAppMovable`, `appMovesOf`,
    `approveAppMove`, `isDeptApprover`); endpoints `GET /tracker/app-move-targets`, `POST
    /tracker/applications/:id/move-dept[/preview]` (`routes/tracker.js`). The application provenance is in
    `application_moves` (mirrors `function_moves`).
  - **Weight (fixed mode):** a department's weight is **derived** — the sum of its applications' weights — so the
    application's weight follows it with **no mutation**: the source department's total decreases by exactly the
    application's weight and the destination's increases by it, leaving the overall weight sum unchanged. There is no
    stored department weight and no department weight cap, so nothing can overflow or need clamping. **Auto mode:** a
    department's weight is the sum of its applications' counted item weights, which likewise follow the application —
    nothing to transfer. One strict audit row for the application move (`move` on `application`), plus — in fixed mode —
    the two departments' derived weight changes (`update` on `department`).
  - **Approval:** a new request kind `move_application`. When the initiator is a lead (`apv_dept`) of BOTH departments,
    holds `cfg`/`apv_final`, or approvals are off → the move applies directly; otherwise a request needs the SOURCE
    department's team lead, then the DESTINATION department's (one approval when the same person leads both; never the
    requester). On the final approval the move is applied in the requester's name (`routes/approvals.js`,
    `services/edits.js`). The 1.12.1 Approvals filters/labels, the Excel export (`services/export-labels.js`,
    `routes/export.js`) and the audit sentences (`frontend/src/lib/audit.js`) handle the new kind, AR+EN. A T9
    `app_moved_in` alert tells the destination department's users (`services/notify-*`).
  - **Permission:** the existing `mov` is reused — no new permission. A regular member granted `mov` who is not a lead
    of both departments goes through the two-lead approval.
  - **Guards (409):** the application already in the destination department (`move_same_dept`), a pending edit / move /
    import request on the application or its items (`move_app_pending_request`), and a name already used by another
    application of the destination department (`move_app_name_conflict`).

### Upgrade notes
- **Database:** new migration `backend/src/db/migrations/022_move_applications.sql` — creates `application_moves`,
  adds `move_application` to the `edit_requests` kind check and extends the move-target check (a `move_application`
  request carries a destination department but no destination application), extends `edit_request_items` kind check to
  allow an `application` item, and indexes `edit_requests(target_department_id)` for pending rows. Forward-only and
  idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then `ADD`); it runs with `update.sh` like any
  other migration. No data backfill or operator action beyond running the migration.

---

## [1.12.15] — 2026-10-23 — Dashboard: function-count stats moved inside the ERP card

### Changed
- **Frontend:** the four function-count stats (الوظائف الداخلة في الحساب، المكتملة كليًا، التي اختُبرت بنجاح، التي عليها
  ملاحظات) moved from a separate row below the ERP card into that same card, as a footer stats row under the wheel/KPI
  (`pages/Dashboard.jsx`). Each tile gets a subtle 3D splash (accent-tinted gradient + raised shadow + inset highlight,
  `app.css` `.erp-stats`/`.erp-stat`), responsive 4-across → 2×2, RTL-correct. Values/labels unchanged; `NumberCard`
  elsewhere untouched (a scoped `.erp-stat` variant is used, not a global restyle).

---

## [1.12.14] — 2026-10-23 — Download encrypted backup files from the backup screen

### Added
- **Backend:** two endpoints in `routes/backups.js` to download a backup artifact of any kind (database `dump`,
  `config`, `logs`) from Settings → «النسخ الاحتياطي». `POST /api/backups/download/authorize` `{file}`
  re-authenticates (password + 2FA) and returns a short-lived (~90 s) token bound to that administrator and that
  artifact; `GET /api/backups/download?file=<name>&token=<token>` then **streams the file exactly as it is on disk —
  still gpg/AES-256 encrypted** (`Content-Disposition: attachment`, `application/octet-stream`, `no-store`,
  streamed never buffered). The artifact's `.sha256` / `.meta` siblings are downloadable with the same token for
  integrity verification. Rate-limited (30 per 15 minutes per administrator; `ETS_BACKUP_DOWNLOAD_LIMIT`).
- **Frontend:** a ⬇ «تنزيل / Download» button and a **SHA-256** checksum link on every row of the backup files table
  (database / configuration / logs) in `components/BackupCenter.jsx`, reusing the existing `ReauthModal` for the
  password (+ 2FA) prompt and the `downloadFile` helper. A hint states the files are encrypted (AES-256) and need the
  backup key/passphrase to restore. New AR/EN strings `bk_download*` and `err_download_reauth_required`.

### Security
- The download path **never decrypts** an artifact, never reads, requires or exposes the backup key/passphrase, and
  logs no secret. Downloading the full encrypted database off the server is data exfiltration, so it is gated like the
  strictest existing backup actions: admin + `cfg`, plus a fresh re-authentication (password, and the 2FA code when
  enabled) — the GET accepts only an in-memory, user- and artifact-bound token (no database, no secret), error
  `download_reauth_required` otherwise. File names are validated with the same strict `parseArtifact` + `.gpg`
  pattern as `/upload`, and the resolved **real path** (`realpathSync`) must stay inside `ETS_BACKUP_DIR`, so `..`,
  absolute paths and symlinks escaping the directory are refused (`invalid_file_name` / `backup_file_not_found`).
  Both the authorization and each streamed file are written to the change history (`backup_download_authorize`,
  `backup_download`: who, which file, when).

### Upgrade notes
- **Deployment:** so the unprivileged API (`ets`) can read the artifacts it streams, `/var/backups/ets` is now
  `root:ets 0750` and `ets-backup` writes each artifact `root:ets 0640` (read-only for the group — the API still
  gets **no write access and no root**). New installs get this from `deploy/install.sh` and `deploy/scripts/backup.sh`.
  **On an existing server grant the read once** (no service restart needed; later backup runs keep new files correct):
  ```bash
  sudo chgrp -R ets /var/backups/ets
  sudo chmod 0750 /var/backups/ets
  sudo find /var/backups/ets -maxdepth 1 -type f -exec chmod 0640 {} +
  ```
  No database migration.

---

## [1.12.13] — 2026-10-23 — Users overview: summary card beside the donut, stats as rows

### Changed
- **Frontend:** the dashboard Users overview (`components/UsersOverview.jsx`) now lays the combined
  «المستخدمون» KPI card and the «عرض حسب» breakdown-donut card **side by side in one row** (new `.uo-row`
  flex container in `styles/app.css`) instead of stacking them vertically; the row follows the page direction
  (summary leading, donut trailing) in both Arabic (RTL) and English (LTR) and **wraps back to a stack** on
  narrow / phone widths. The summary keeps a compact width (`flex: 1 1 280px; max-width: 360px`) so the donut
  cell (`flex: 1 1 360px`) gets the room it needs, replacing the donut card's former `max-width: 540px` centring.
- **Frontend:** the combined «المستخدمون» KPI card now shows its five figures (total / active / online /
  disabled / deleted) as a **vertical list of rows** — each `.uo-stat` is a `space-between` row with the label on
  the leading side and the number on the trailing side, separated by a subtle divider — instead of a horizontal
  row of centred columns. Same figures, colours (`.nc-value` green/blue/orange/red) and links (online →
  `/users?tab=online`, deleted → `/users?tab=deleted`); `space-between` and logical properties keep it correct in
  RTL and LTR.

---

## [1.12.12] — 2026-10-23 — Users overview: one donut with a dimension selector

### Changed
- **Frontend:** the dashboard Users overview (`components/UsersOverview.jsx`) now consolidates all the user
  breakdowns into a **single donut driven by a dropdown** instead of a department bar chart plus four separate
  donuts. The `<select>` (styled with the shared `.input input-sm`) chooses the dimension — «المستخدمون حسب
  الإدارة» (departments, the default), «المستخدمون حسب الدور» (roles), «حالة الحسابات» (account status),
  «الاتصال الآن» (presence) and «التحقق بخطوتين» (2FA) — and the one `Donut` re-renders its slices, legend,
  centre total and tooltips for the chosen dimension. Each dimension keeps its existing colours, labels and links
  (presence online → `/users?tab=online`, status deleted → `/users?tab=deleted`, roles / status active →
  `/users`); the new departments slices reuse the role palette and link to `/department/{id}`. The selection is
  held in component state and mirrored to the URL (`?uo=<dim>`) so a reload or shared link reopens the same
  breakdown. The card is width-constrained and centred so the lone donut never looks lost.
- **Frontend:** fixed the combined «المستخدمون» KPI card alignment — each stat is now a self-contained centred
  block with its number directly above its label (`.uo-stat` in `styles/app.css`), reading as one unit in both
  Arabic (RTL) and English (LTR); previously the ltr-forced number and the direction-following label drifted to
  opposite edges of each cell.

### Removed
- **Frontend:** the Users-overview department **bar chart** and the four standalone donuts (by role, status,
  presence, 2FA), together with their now-unused `.uo-grid` / `.ubar-*` styles — all replaced by the single
  dropdown-driven donut above.

---

## [1.12.11] — 2026-10-23 — Users overview: one combined KPI card

### Changed
- **Frontend:** the dashboard Users overview (`components/UsersOverview.jsx`) now shows the headline user figures
  in a **single «المستخدمون» / Users KPI card** instead of three separate `NumberCard`s. The one card presents
  total, active, online now, disabled and deleted as a row of stat items (big number + short label) reusing the
  existing `NumberCard` typography and colour accents (`.uo-stats` / `.uo-stat` in `styles/app.css`). The online
  and deleted figures are links (`/users?tab=online`, `/users?tab=deleted`) with the same navigate-on-plain-click
  behaviour as the donut slices; the grid lays out correctly in both RTL and LTR via logical properties. The bar
  chart and the four donuts are unchanged. New i18n key `uo_summary` (AR/EN). No backend or API change.

---

## [1.12.10] — 2026-10-23 — Users overview: two-factor donut

### Added
- **Frontend:** a fourth donut — **«التحقق بخطوتين» / Two-factor authentication** — in the dashboard Users
  overview (`components/UsersOverview.jsx`), built from the `tfa` tally the endpoint already returns. Slices:
  enabled (`tfa.enabled`, green), exempt (`tfa.exempt`, orange), not enabled (`tfa.off`, gray), reusing the same
  `Donut` component, screen palette, legend, and `<title>` tooltip (label · count · percentage) as the sibling
  donuts. The slices are display-only (no Users-screen filter maps to a 2FA state). Labels reuse the existing
  `two_fa` / `tfa_on` / `tfa_exempt` / `tfa_off` i18n keys (Arabic and English); no new keys.

### Upgrade notes
- No database or backend change: the `GET /api/dashboard/users-overview` payload already carried `tfa`; only the
  dashboard UI now renders it.

---

## [1.12.9] — 2026-10-23 — dashboard users overview

### Added
- **Frontend:** a new **«نظرة عامة على المستخدمين» / Users overview** section on the dashboard
  (`pages/Dashboard.jsx`), shown only to system administrators. Summary `NumberCard`s (total, active, online now),
  a per-department bar chart of scoped users, and three hand-built SVG donuts — by role, account status
  (active / disabled / deleted), and presence (online / offline). New reusable `components/Donut.jsx` in the
  ERP-wheel style and `components/UsersOverview.jsx`; the figures reuse the existing screen palette (the ERP-wheel
  navy from `lib/wheelGeometry.js` and the indicator-pill tones in `styles/app.css`) and lay out correctly in both
  RTL and LTR. Each slice and bar carries an SVG `<title>` tooltip (label · count · percentage); the slices that
  map to a Users view are links (role / status → `/users`, deleted → `/users?tab=deleted`, online →
  `/users?tab=online`). New i18n keys under `i18n/messages.js` in both Arabic and English.
- **Backend:** `GET /api/dashboard/users-overview` (`routes/dashboard.js`, `services/userStats.js`) returns
  aggregated user statistics — **counts only, no per-user data** — computed in SQL with `GROUP BY` / `FILTER`
  (lifecycle and 2FA tallies, users per role, scoped users per department, and distinct online users via the new
  `onlineUserCount()` in `services/presence.js`).

### Changed
- **Frontend:** the dashboard's bottom departments grid — which duplicated the top ERP wheel — was **removed** and
  replaced by the Users overview section.

### Security
- The Users overview section and its endpoint are gated by the **same permission as the Users screen**: `'usr'`
  plus the admin role (`requireAuth, requirePerm('usr'), requireAdmin`, matching `routes/users.js` and
  `routes/presence.js`, per ETS-SEC-004). A reader without `'usr'` does not render the section and the endpoint
  returns 403. The payload carries no PII — aggregate counts only.

### Tests
- **Backend:** `test/dashboard-users-overview.test.js` — response shape, correct counts on seeded data (lifecycle,
  2FA split, roles, per-department, online), and that the `'usr'` + admin gate is enforced (non-admin 403,
  signed-out 401).

### Upgrade notes
- No database change: the endpoint is pure `SELECT` aggregation (no migration, no schema change).

---

## [1.12.8] — 2026-10-23 — browser tab title follows the configured system name

### Fixed
- **Frontend:** the browser tab title now follows the configured system name instead of the static
  `index.html` `<title>`. A single effect in `App.jsx` sets `document.title` from `me.org_name_ar` /
  `me.org_name_en` (the same source and current-language rule the header uses in `components/Layout.jsx`):
  the current UI language's name, falling back to the other language's name and then to `t('app_title')`.
  Empty/whitespace-only names fall through to the default, so an all-empty config never yields a blank tab
  title. It updates on initial load once `/auth/me` is available, on a Settings → General save (`refresh()`
  reloads `me`) and on a UI-language switch. Before sign-in `me` carries no org name, so the title stays the
  default rather than a stale name. `index.html` keeps the same string as its pre-hydration default.

---

## [1.12.7] — 2026-10-23 — «المستخدمون المحذوفون» promoted to a top tab

### Changed
- **Frontend:** the deleted-users list is now a top-level tab on the Users screen (`pages/Users.jsx`), sitting
  between «المستخدمون» (active) and «المتصلون الآن» (online): «المستخدمون» · «المستخدمون المحذوفون» · «المتصلون
  الآن». It replaces the inner active/deleted sub-tab row, which is removed. The tab is kept in the query string
  (`/users?tab=deleted`), matching the online tab (`?tab=online`); active stays the default with no param. The
  fetch (`/users?deleted=1`), the per-row restore action with its blocked-restore reasons, and the deleted export
  are unchanged. The deleted tab is visible to anyone who can open the Users screen (the `usr` route guard),
  exactly as the old sub-tab was; the online tab stays admin-only via `can('usr')`. Pure navigation/placement
  change — no API call or data behaviour changed.

---

## [1.12.6] — 2026-10-23 — Settings screen organized into tabs

### Changed
- **Frontend:** the Settings screen is no longer one long scroll — its sections are grouped into tabs
  (`pages/Settings.jsx`): «عام» (المخطط الزمني، عام، الهوية), «الأمان والجلسة» (التحقق بخطوتين، الاعتماد، الأمان،
  حفظ السجلّات), «الإشعارات» (الجدولة والعتبات ومصفوفة السياسات), «النسخ الاحتياطي» (للمدير فقط), «متقدّم» (تصدير/
  استيراد البيانات، معلومات النظام). The active tab is kept in the query string (`/settings?tab=security`), matching
  the Users and Approvals screens. Pure layout/navigation change — no setting's behaviour, API call or data changed.
- **Permissions preserved exactly:** every section keeps its existing guard; the «النسخ الاحتياطي» tab appears only
  for an administrator, and export/import buttons stay gated by `exp`/`imp`.

### Upgrade notes
- No migration, no setting change. Old deep-links still work: `/settings#backups`, `#notifications`, `#timeline`
  (and `/settings?restored=1#backups` from the restore wizard) open the matching tab and still scroll into view.

---

## [1.12.5] — 2026-10-23 — the sign-in page always explains an expired session

### Fixed
- **Frontend:** when a session ended on the server and the browser learned of it through a background request —
  a `401` on a data/presence poll, or the live stream's `session_ended` — rather than the idle tracker's own
  timer, the sign-in page appeared bare with no explanation. It now shows the «انتهت الجلسة. سجّل الدخول مجدداً» /
  "Your session has ended. Sign in again" notice in every case (`lib/auth.jsx`). The unauthorized handler passes
  the end-of-session through as an `ended` reason (reusing the existing mechanism and i18n keys), and a refresh
  never clobbers a more specific reason (`idle`, `expired`) that an in-flight check already recorded; a deliberate
  sign-out still shows no notice. This closes the «no reload, no error» gap a user saw when a session expired while
  the tab was backgrounded or the machine asleep — the expired session is surfaced promptly and in place (no
  full-page reload) for foreground idle, return from background/sleep, absolute expiry, and a session ended
  elsewhere. The server remains the sole authority; only the client-side notice changed.

### Notes
- Investigated a report of the page reloading by itself with `HTTP 499` on `GET /` and `/favicon.ico` after a
  session expired. The app never reloads itself on expiry (it renders the sign-in page in place, confirmed by
  E2E: zero self-navigations); the self-reload is the browser restoring a discarded or slept tab, and the `499`
  is nginx recording that the browser aborted that in-flight navigation. Both `/` and `/favicon.ico` return
  `index.html` (`text/html`) through the SPA fallback (`try_files $uri /index.html`; there is no `favicon.ico`
  file, only `favicon.svg`) — expected, benign behaviour, not an application fault.

---

## [1.12.4] — 2026-10-23 — «المتصلون الآن» as a tab inside the Users screen

### Changed
- **Frontend:** the «المتصلون الآن» (online users) screen is no longer a separate page or sidebar item — it is now
  the second tab inside the Users screen (`pages/Users.jsx`, `components/Layout.jsx`). The active tab is kept in the
  query string (`/users?tab=online`), matching how other screens persist state. Live-presence logic in
  `pages/OnlineUsers.jsx` is reused unchanged.
- **Permissions:** the tab's label and its content are both gated by `can('usr')` (the same admin-only check that
  guarded the old route), so a user without that permission can neither see nor activate the tab, including by URL.

### Removed
- **Frontend:** the standalone online-users sidebar entry.

### Upgrade notes
- No migration, no setting change. Old links and the backend presence screen-link to `/online` still work: the old
  route now redirects to `/users?tab=online` (`App.jsx`).

---

## [1.12.3] — 2026-10-23 — Trust-proxy safety guard against X-Forwarded-For spoofing

### Security
- **Backend:** the service now refuses to start when `TRUST_PROXY` is set to a **trust-all** value — `true` / `'true'`
  or an all-addresses CIDR (`0.0.0.0/0`, `::/0`) — with a clear, actionable message (`config.js`,
  `trustProxyProblem`, checked in `assertConfig`). Such a value would make Express trust the whole `X-Forwarded-For`
  chain, so any client could set its own IP address: it would win a fresh per-IP login rate-limit bucket on every
  request (defeating `LOGIN_RATE_LIMIT`, `middleware/ratelimit.js`) and write a false IP to the logs. The default
  `loopback` (nginx on this server appends the real client address on the right, which Express takes), a hop count,
  and a proxy IP / subnet / comma list stay valid and quiet. This matches how the app already refuses to start on
  other insecure settings (a weak `APP_SECRET`, an unencrypted remote database). Before this change `TRUST_PROXY=true`
  failed to start anyway, but with an obscure `invalid IP address: true` from the proxy parser.

### Tests
- **Tests:** `backend/test/trust-proxy.test.js` — with the default `TRUST_PROXY=loopback` (as the running server
  bootstraps it), a client-supplied `X-Forwarded-For` that changes on every request does **not** win a fresh per-IP
  login bucket: the per-IP limiter still answers `429` after `LOGIN_RATE_LIMIT`. The test fails if the code is changed
  so `req.ip` follows the client header under the default config. It also checks the per-account rate limit and the
  per-account lockout (`services/lockout.js`) still fire whatever the header says. `config.test.js` covers
  `trustProxyProblem` (trust-all refused, safe values quiet) and that `assertConfig` throws on `TRUST_PROXY=true`.

### Docs
- **Docs:** `02-Installation-Guide.md` (§6 variable table, §9) and `06-Security.md` state the safe `TRUST_PROXY`
  values and that the service refuses to start with `true` / an all-addresses CIDR.

### Upgrade notes
- No migration, no setting change. The default (`loopback`) is unchanged. Only deployments that had wrongly set
  `TRUST_PROXY=true` are affected — those could not start before this change either; set `TRUST_PROXY=loopback` (and,
  behind a load balancer, configure nginx `real_ip` for the balancer's addresses only — 02 §9).

---

## [1.12.2] — 2026-10-22 — Sessions: idle timeout counts only real user activity

### Security
- **Backend:** the idle timeout (`SESSION_IDLE_MINUTES`, 60) now counts **only genuine user activity**: a request
  moves `sessions.last_seen_at` only when it carries **`X-ETS-Activity: 1`** (opt-in; at most one write per 30 s).
  Before, every request counted except `GET /events`, `X-ETS-Live: 1` and `POST /presence`, so any automatic request
  the client did not tag kept a session alive — the 30 s refresh of Settings → «النسخ الاحتياطي» kept an
  administrator's session open indefinitely, and every page reload (soft or hard) restarted the idle clock through
  `GET /auth/me`. `X-ETS-Live: 1` still wins, and the stream and presence reports never count even with the header
  (`middleware/auth.js`, `isUserActivity`).
- **Frontend:** the web app signs out by itself after the idle limit without input (`frontend/src/lib/activity.js`):
  only `pointerdown`, `keydown`, `wheel` and `touchstart` count (not `mousemove`, which browsers also fire when content
  moves under a still pointer) and are reported as `POST /api/auth/activity`, at most once a minute. When a tab has
  seen no input for the limit — or the absolute end (`SESSION_TTL_HOURS`) is reached — it asks the server; if another
  tab of the same browser kept the session alive it waits, otherwise it calls `POST /api/auth/logout {reason:"idle"}`
  (session revoked, cookie cleared) and shows the sign-in page with «انتهت الجلسة بسبب عدم النشاط» / "Your session
  ended after a period of inactivity". A hidden tab or a sleeping PC is checked as soon as the tab is visible again.

### Added
- **Backend:** `POST /api/auth/activity` (any session; `401` without one — an ended session is never revived) →
  `{idle_minutes, idle_expires_at, expires_at, server_now}`; written to the file access log only.
- **Backend:** `GET /api/auth/me` returns `session: {idle_minutes, idle_expires_at, expires_at, server_now}`;
  `POST /api/auth/logout` takes `{reason: "idle"}` → `revoke_reason = 'idle_timeout'`, `auth_log` `logout` with
  `detail.reason = "idle"`.

### Fixed
- **Frontend:** a session check that could not reach the server (network error, 5xx, 429) showed the sign-in page
  although the session was still valid — a reload then showed the user signed in again. A failed check now keeps the
  signed-in state (the server still refuses an ended session on the next request), and when several checks run at
  once only the latest answer is applied, so an older answer can no longer overwrite a newer one (`lib/auth.jsx`).
  Session checks (`/auth/me`) are sent as automatic requests.
- **Mobile:** the app sends `X-ETS-Activity: 1` on the requests a person starts and `X-ETS-Live: 1` on its automatic
  ones, session checks included (`mobile/src/lib/api.ts`, `session.tsx`), so an app in use stays signed in and an app
  left open signs out after the idle limit, as on the website.

### Tests
- **Tests:** `backend/test/session-expiry.test.js` — background traffic (the backups poll, data loads, `/auth/me`,
  live reloads, presence, the stream) never extends the idle timeout; an idle-expired session is refused on every
  route and for good (cookie cleared, reloads stay signed out); `X-ETS-Activity` and `POST /auth/activity` extend it;
  the absolute limit; the idle sign-out; `/auth/me` timing. `presence.test.js`: the control request now carries the
  activity header. Mobile: `__tests__/api.test.ts` checks both headers.

### Upgrade notes
- No migration, no setting. Reload open browser tabs after the update: the previous web build does not send
  `X-ETS-Activity`, so its users are signed out after `SESSION_IDLE_MINUTES` even while working. The same applies to
  phone app builds older than this change until they are updated.
- Keep `SESSION_IDLE_MINUTES` at 5 or more: activity reaches the server at most once a minute.
- Scripts or tools that call the API with a session cookie must send `X-ETS-Activity: 1` on the requests that should
  keep the session alive.

---

## [1.12.1] — 2026-10-22 — Approvals: filters

### Added
- **Backend:** `GET /api/approvals` takes the filters of the screen as query parameters — `dept`, `app` (a move
  matches its source **or** its destination), `kind` (`function`, `bulk`, `report`, `add_function`,
  `remove_function`, `restore_function`, `move_function`), `field` (a changed field of an item; `name` = a rename,
  Arabic or English), `requester`, `decided_by` (who decided, or signed one stage of a move), `from` / `to` (day of
  the request), `q` (request number, summary, reason, departments, applications, requester, items' codes and names;
  `#12` = request 12 only; `%` and `_` are plain text) and `awaiting=1` (only what the reader may approve now). Bad
  values are refused with `400 invalid_value` and the field. Every filter only narrows the list: visibility is still
  decided per request after the query (ETS-SEC-007), so no filter reaches another department's requests. The answer
  also says `truncated` when the newest 300 matching rows were cut.
- **Backend:** `GET /api/approvals/facets?status=` — the choices of the filters (departments, applications,
  requesters, deciders, kinds, changed fields), taken only from the requests the reader may see.
- **Frontend:** «اعتماد التعديلات» / Approvals: a filter bar — search, status, department, application (follows
  the department), requester, request type, changed field, «قرّره / اعتمده» (when the status is not «pending»), date
  range, «بانتظار اعتمادي» and «طلباتي فقط» — with the count of requests, «مسح التصفية» and the filters kept in the
  address (`/approvals?app=ess&kind=report…`; no `status` = pending, `status=` = all), so `/approvals?mine=1` from a
  notification now opens filtered. The «awaiting approval» chips of an application and of the Reports screen open the
  screen filtered on that application.
- **Backend / Frontend:** the Excel export of the screen takes the same filters; the sheet names them in words
  (department, application, requester…), the audit row keeps the raw values and the Logs sentence reads them.
- **Docs:** `docs/handover/11-API-Reference.md` — the new filters of `GET /approvals` and `GET /approvals/facets`.

### Fixed
- **Frontend:** «اعتماد كل المعروض» / "Approve all shown" approved every pending request the user could approve,
  not only the ones listed. It now sends the ids of the listed requests that the user may approve
  (`POST /api/approvals/approve-all` with `ids`), shows their number when filters are on, and asks for confirmation
  with that number; the server still re-checks each one.

### Tests
- **Tests:** `backend/test/approvals-filter.test.js` — each filter, dates and free text, refused values, scope (a lead
  of one department, a member), `awaiting=1`, the facets, the export with filters and «approve all shown».

---

## [1.12.0] — 2026-10-22 — Backups: hourly, offsite, test restore, and restore from the web UI

### Added
- **Deployment:** hourly backups (`ets-backup.timer`, `Persistent=true`, `flock`): the database dump, a
  **configuration bundle** `ets-config-<time>.tar.gpg` (ets.env, install.conf, db-ca.crt, the TLS certificate **and
  key** in use — or `/etc/letsencrypt` —, the nginx site, `pg_dumpall --globals-only`, `manifest.json` with version,
  commit, PostgreSQL version, database, host name, IPs, `PUBLIC_BASE_URL`, `TLS_CERT_SHA256`, per-table counts and the
  SHA-256 of every file; made only when its content changed) and a daily **logs bundle** `ets-logs-<date>.tar.gpg`
  (ETS's own text logs incl. rotated ones); `.sha256` and a non-secret `.meta` (key id, kind, server, items) next to
  each artifact; the backup key is never put in a backup. `deploy/scripts/backup.sh`, `backup-lib.sh`.
- **Deployment:** tiered retention by the time in the file name (every backup 48 h, daily 30 days, weekly 12 weeks,
  monthly 12 months; configurable), applied locally and on each destination by one shared function.
- **Deployment:** offsite copies after each backup to any combination of **SSH** (rsync, `rrsync`-restricted
  ed25519 key `/etc/ets/backup_ssh_key`, `accept-new` + `/etc/ets/backup_known_hosts`), a mounted **NAS** (refused while
  not mounted: the root disk never fills up) and **S3-compatible cloud storage** (rclone, `/etc/ets/rclone.conf`); each
  destination on its own, temporary names, read-back verification, `backup_offsite` system-log rows.
- **Deployment:** weekly **test restore** `ets-backup-verify` (`ets-backup-verify.timer`, Friday 03:00): temporary
  database `ets_restore_check`, migrations, `verify-audit`, row counts against the live database, `backup_verify` row.
- **Deployment:** `ets-restore-server` (`deploy/scripts/restore-server.sh`): disaster recovery onto a new server from a
  directory, SSH or rclone — files back with their modes, `install.sh` non-interactively with the **same certificate**
  (`ETS_KEEP_CERT=1`), restore, migrations, verify-audit, health check, and whether the phones keep working; `--dry-run`.
- **Backend:** Settings → «النسخ الاحتياطي» API `/api/backups` (role admin + `cfg`) and the root **backup agent**
  (`ets-backup-agent.service` / `.timer` / `.path`, `backend/scripts/backup-agent.js`): the API stores the desired
  configuration (`backup_config`, cloud credentials encrypted with an APP_SECRET HKDF key, write-only) and queues
  whitelisted jobs (`backup_jobs`); the agent validates them again, renders `/etc/ets/backup.conf`, `rclone.conf` and the
  timer schedules, and runs the jobs. Migration **021_backup_center.sql**.
- **Backend / Frontend:** **restore from the web UI** — «استرجاع من نسخة»: source (this server, SSH, NAS, cloud,
  upload), items with «تحديد الكل» (database as a whole, ets.env, certificate, install.conf, db-ca.crt, logs into
  `restored-<date>/`), unavailable items with reasons, dependency warnings; **password + 2FA + backup key** every time
  (the key travels through a single-use encrypted channel, never stored or logged; 3 wrong keys → 15-minute pause);
  inspection (test restore, versions, counts) before anything changes; confirmation phrase; safety copy of exactly
  what is replaced, the API stopped only for the database or ets.env, automatic rollback on any failure; every
  session ends; audited in the restored database.
- **Frontend:** real progress for restores, test restores and «نسخ احتياطي الآن» (`ProgressPanel.jsx`,
  `backend/src/backup/progress.js`): animated bar per state, percentage with one decimal, ETA from a smoothed
  throughput («تقديري» before the first measurement), data / table / row counters, step checklist; the same bar on the
  maintenance page nginx serves while the API is stopped (`/maintenance.html`, `/api/restore-status.json`).
- **Frontend:** status panel (last local backup, each destination, last test restore, next runs, free disk), schedule
  and retention, destinations with «اختبار الاتصال» and «إنشاء مفتاح», backup files per type and destination, key /
  passphrase, escrow attestation with a yearly reminder.
- **Backend:** notifications **S9** `backup_offsite` (per destination, `notify.offsite_max_age_hours`, default 3 h),
  **S10** `backup_verify` (test restore failed / none for 8 days), **S11** `restore_event` (restore started /
  finished); administrators, critical, phone allowed, mandatory.
- **Tests:** `backend/test/backups.test.js` (rules, injection attempts, rendering, key ids, selection / warnings,
  progress math and the pg_restore parser, API permissions, re-authentication, write-only secrets, audit, jobs and
  limits, restore inspect / run, the key never persisted, wrong-key lockout, notifications),
  `backend/test/backup-agent.test.js` (agent end-to-end with the real scripts on a scratch database: wrong key,
  database + APP_SECRET, database only, certificate only without downtime, forced failure with rollback, progress
  monotonic to 100 %; `ETS_AGENT_E2E=1`), `deploy/tests/backup-retention.test.sh`, `deploy/tests/backup-e2e.sh`
  (NAS on tmpfs, SSH through rrsync, rclone, `ets-restore --yes`, `ets-restore-server --dry-run`).

### Changed
- **Deployment:** backups run from a systemd timer instead of `/etc/cron.d/ets-backup` (removed by `update.sh`).
- **Deployment:** `ets-restore` takes `--yes`, `--key FILE` and `--no-safety-backup`, refuses a backup of a newer
  version, applies the migrations on both paths, ends every session and runs `verify-audit` after the restore (exit 4
  when a chain is broken).
- **Backend:** S6 «لا توجد نسخة احتياطية» is checked every 15 minutes with the threshold
  max(`notify.backup_max_age_hours`, interval + 1 h); the default becomes **2 h** (migration 021 changes an
  installation still at the old default 26 h; a customised value is kept).
- **Deployment:** `install.sh` asks for optional offsite destinations, installs `rclone`, shows the escrow reminder
  loudly; nginx: upload, status file and maintenance page locations, 503 instead of 502 during a restore.

### Fixed
- **Deployment:** `ets-restore` / `ets-log-protect restore` failed on a backup of an older version (pg_restore
  `--clean` drops only the dump's objects; newer tables' foreign keys blocked it): schema `public` is now emptied in the
  restore transaction (`deploy/db/wipe-public.sql`).

### Security
- **Backend:** the web application never gets root: a separate root agent with strict re-validation, a fixed list
  of writable files and argument-array commands; destinations / credentials / SSH key / passphrase need the password
  and 2FA again; job, upload and restore requests are rate-limited; restore needs three factors; backup settings,
  jobs, uploads and restores are audited (secrets masked) — docs 06 §6b.

### Upgrade notes
- `sudo bash deploy/scripts/update.sh` from this version: installs the timers (`ets-backup.timer`,
  `ets-backup-verify.timer`) and the backup agent (`ets-backup-agent.timer` / `.path`), removes
  `/etc/cron.d/ets-backup`, installs `rclone`, creates **`/etc/ets/backup.conf`** (root 600; local only, hourly; the
  daily tier keeps at least your `ETS_BACKUP_KEEP_DAYS`, so the existing 30 daily backups are **not** deleted by the
  first run), applies migration **021**, then imports `backup.conf` into the database once — from then on the
  settings are managed in **Settings → «النسخ الاحتياطي»** (the agent rewrites the file).
- **Escrow the backup key now** (`sudo cat /etc/ets/backup.key`, id in `/etc/ets/backup.key.id`): password vault and a
  sealed envelope, away from the backups; then tick «تأكيد حفظ مفتاح التشفير» in Settings → «النسخ الاحتياطي». Without
  this key no backup can be restored (docs 08 §6 has a printable checklist).
- Configure the offsite destinations in Settings → «النسخ الاحتياطي» → «الوجهات الخارجية», then «اختبار الاتصال»:
  **SSH** — a dedicated user on the backup server, «إنشاء مفتاح», put the shown `restrict,command="rrsync <dir>"` line
  in its `authorized_keys`, compare the host fingerprint (08 §4a); **NAS** — mount the share under `/mnt` (fstab with
  `nofail`) and enter the mount point (08 §4b); **cloud** — provider, endpoint, region, bucket, path and keys (stored
  encrypted, never shown again), or an rclone remote of `/etc/ets/rclone.conf` (08 §4c).
- Check: `systemctl list-timers 'ets-backup*'`, «نسخ احتياطي الآن» and «تحقق الآن» succeed, every destination is green.
- Phones reach the server by IP: a replacement server keeps them paired only with the same IP and the restored
  certificate — consider an internal DNS name (08 §11).

---

## [1.11.0] — 2026-10-21 — Online users

### Added
- **Frontend:** «المستخدمون المتصلون الآن» / "Online users" (`/online`, Administration → «المتصلون الآن»; system
  administrators only): one row per signed-in session — user and role, status (**online**: last report ≤ 2 minutes;
  **idle**: 2–15 minutes while the session is valid), the current screen as a readable label with the name of what is
  open, linked (e.g. «وظائف التطبيق — شؤون العاملين»), time on that screen, session duration and sign-in time, last
  activity, active time today, client (browser / phone app), browser / system and IP. Counts of online / idle / open
  sessions; filters by role, department (scope) and screen; refreshes every 15 s while visible (polling, with
  `X-ETS-Live: 1`); a table on wide screens, cards under 640 px. Row action **«إنهاء الجلسة»** with confirmation.
  The Users page shows «متصل الآن (n)» linking to it. Arabic / English (`// Online users (1.11.0)` blocks).
- **Frontend:** `lib/presence.js` — every tab reports its screen (`POST /api/presence`, screen key + id) on every
  screen change, every 60 s while visible and once when it becomes visible again; nothing while hidden.
- **Backend:** `POST /api/presence` (signed in; the caller's own session only) → 200 / 202 coalesced;
  `GET /api/presence` and `GET /api/presence/count` (administrators: `usr` + admin role);
  `backend/src/services/presence.js`, `backend/src/routes/presence.js`. Labels and links are built on the server from
  a whitelisted screen key and an id checked to exist (else «غير معروف» / `unknown`). Session duration counts from the
  password step (`sessions.login_at`, kept when 2FA replaces the session). Active time today: the time between two
  reports of any of the user's sessions when ≤ 90 s apart (local day of `notify.timezone`), never counted twice.
- **Backend:** `POST /api/users/:id/revoke-sessions` takes `{session_ref}` to end one session (errors
  `cannot_end_own_session`, `session_not_found`); audit `revoke_sessions` with `session_ref` and
  `source: "online_users"`.
- **Backend:** clean-up of presence rows every 5 minutes (one API process at a time, advisory lock
  `ets_presence_cleanup`): rows older than 15 minutes or of a session no longer valid, daily activity older than 7 days.
- **Tests:** `backend/test/presence.test.js` (upsert, `screen_since`, coalescing, idle timeout untouched, 403 for
  non-administrators, list and thresholds, labels of invalid ids, sign-out / revocation / deleted user, clean-up and
  its lock, ending one session and its audit, view audit throttle, `login_at` across 2FA).
- **Mobile:** new cross-platform app in `mobile/` (React Native 0.88 / Expo SDK 58, TypeScript, `ly.ets.mobile`), phase 1:
  server address (https only), sign-in with 2FA, forced password change, dashboard with the ERP wheel, departments,
  read-only applications, alerts, profile; Arabic / English with RTL; built by `.github/workflows/mobile.yml` (APK
  artifact). No server change: it uses the web session cookie. See [mobile/README.md](mobile/README.md) and
  [mobile/CHANGELOG.md](mobile/CHANGELOG.md).
- **Mobile:** phase 2 (app 0.2.0): editing of application items by permission (progress, statuses, note, weight,
  type, include / exclude with reason and duplicates, rename, move with impact, add / remove / restore, bulk set),
  202 «sent for approval» handling, an approvals screen (approve / reject / withdraw / approve all), live updates over
  `GET /api/events` (sse.js 2.8.0) instead of polling, notification preferences, alert links, presence reports
  (`POST /api/presence`, client `mobile`). No server change.

### Changed
- **Backend:** a successful presence report is written to the file access log only, not to `access_log`
  (one per minute and open tab).
- **Frontend:** small dependency-free pieces moved out of components so the mobile app can import them:
  `lib/iconPaths.js` (from `Icon.jsx`), `lib/wheelGeometry.js` (from `ErpWheel.jsx`), `lib/equation.js` (from
  `PctEquation.jsx`), `lib/notifyTabs.js` (from `NotificationBell.jsx`). No behaviour change.
- **Frontend:** the edit, approval and live-update rules shared with the mobile app moved into `lib/itemRules.js`
  (from `Application.jsx`, `DisableReason.jsx`, `RenameDialog.jsx`, `MoveDialog.jsx`, `ItemType.jsx`),
  `lib/approvalRules.js` (from `Approvals.jsx`), `lib/liveRules.js` (from `lib/live.js`) and `lib/notifyTabs.js`
  (preferences, from `ProfileNotify.jsx`). No behaviour change.
- **CI:** Android workflow (`.github/workflows/android.yml`) actions updated to their Node 24 majors (checkout v7,
  setup-java v6, upload-artifact v7, download-artifact v8, setup-android v4, gradle wrapper-validation v6,
  action-gh-release v3); runner pinned to `ubuntu-24.04` instead of `ubuntu-latest`.

### Removed
- **Code:** dead code with no caller: `Ring` (`ui.jsx`) with its `.ring-text` and `.number-card.hero` styles,
  `COLUMNS` (`userImport.js`), `EXPORT_LABELS` and the `move_to` label (`export-labels.js`), `ALL_TYPES`,
  `JOB_NAMES`, `DIGEST_TYPES` (notifications), and the unused messages `mv_items_n`, `mv_items_col`. No behaviour
  change.

### Security
- The online users list is a privacy-sensitive view: administrators only (same guard as Users, ETS-SEC-004; 403 for
  everyone else, an `usr` override on another role never opens it), viewing it is recorded (`view` / `presence`, at
  most once per 15 minutes per administrator, as ETS-SEC-050), ending a session from it is audited. Nobody else can
  learn who is online. See `docs/handover/06-Security.md` §3a.
- `POST /api/presence` changes only the row of the session whose cookie it carries; path, screen key and id are
  validated (length and characters), only a whitelisted key and an existing id are stored, and nothing the browser
  sends is displayed as text. One write per session per `PRESENCE_MIN_INTERVAL_SECONDS` (10 s), the rest coalesced.
- A presence report never counts as activity for the idle timeout (`POST /presence` is excluded in
  `sessionMiddleware`, whatever its headers); a revoked session's row is deleted at once by a trigger.

### Upgrade notes
- Run the migrations (`update.sh` does it): **`020_user_presence.sql`** adds `sessions.login_at`, the tables
  `user_presence` and `user_activity_daily`, and the trigger `sessions_presence_end`. Existing sessions keep working
  (their duration counts from `created_at`). Nothing else to do: the clean-up starts with the service.
- Optional: `PRESENCE_MIN_INTERVAL_SECONDS` (default 10) in `backend/.env`.
- Tell staff that system administrators can see who is signed in, the screen in use and active time (internal
  policy / notice); see `docs/handover/06-Security.md` §3a.
- `deploy/db/schema-reference.sql` regenerated after migration 020.

---

## [1.10.0] — 2026-10-20 — Moving items to another application

### Added
- **Backend:** moving a function / report item to another application, also of another department
  (`backend/src/services/move.js`). Endpoints (`/api/tracker`): `GET /move-targets?function_id=` (departments →
  applications in the reader's scope, the current one left out), `POST /functions/:id/move/preview`,
  `POST /functions/:id/move` `{to_app_id, reason}`, `POST /applications/:id/bulk-move/preview`,
  `POST /applications/:id/bulk-move` `{function_ids, to_app_id, reason}` (1–200 items, one transaction, all or none).
  200 when direct, 202 `{pending, request_id, impact}` when it needs approval. The item keeps its id, values,
  exclusion reason and duplicate links; it gets the next `C<n>` code of the destination and goes to the end of its
  list. The preview / answer carries before → after for both applications, their department(s) and the project,
  and the weight that moves.
- **Backend:** permission `mov` («نقل البنود» / "Move items") in `PERMISSIONS` (`backend/src/routes/users.js`),
  offered for per-user overrides; `can.mov` in `GET /api/tracker/applications/:id`.
- **Backend:** edit request kind `move_function` with **two approvals**: a team lead of the source application
  («اعتماد (المصدر)»), then one of the destination («اعتماد (الوجهة)»); one approval when the same lead covers both;
  never the requester; either lead may reject. `GET /api/approvals` adds the destination, both approvals, `meta`
  (reason, weight share and impact when requested), `move_now` (the share if approved now) and
  `can.stage` / `can.approve_as`; audit action `edit_approve_source` for the first approval. *Approve all* signs the
  stage the user may approve.
- **Backend:** `GET /api/tracker/applications/:id` — a moved item carries `moves` (its history) and `moved_from`
  (names only within the reader's scope). `GET /function-options` takes `with_off=1` (excluded items too).
- **Backend:** notification type `moved_in` (T8, «نقل بنود إلى تطبيقات في نطاقي»): items moved into an application →
  its users with `pct` / `tst` / `tog` (not who moved / approved them); same roles, policy defaults and phone rule as
  T7. A move request's A1 alert goes to the approvers of both applications.
- **Backend:** Excel exports — the functions sheet ends with «منقول من» (`application/old code`); the approvals sheet
  lists move requests (kind «نقل بنود», field «نقل», «الوزن المنقول», «سبب النقل») and ends with «التطبيق المنقول إليه».
- **Database:** migration `019_move_items.sql` — table `function_moves`, the `edit_requests` move columns
  (`target_app_id`, `target_department_id`, `source_approved_by/at`, `target_approved_by/at`, `meta`), the kind
  `move_function`, and `mov` for admin, mgr, pm, tm, lead.
- **Frontend:** «نقل» (two arrows) on each item row with `mov` (not on removed items): module (department, with
  its ERP module name), then application, a required reason with a counter (3–500 characters, spaces not counted),
  the impact table (both applications, department(s), project, both weights and «الوزن المنقول») and «تأكيد النقل»,
  disabled until all is valid (`components/MoveDialog.jsx`). «تعيين جماعي» → «نقل بنود إلى تطبيق آخر». The badge
  «منقول من <app> / <code>» (tooltip: reason, who, when) opens the item's move history. A pending move shows on the
  row («⏳ بانتظار الاعتماد: نقل إلى …»). The Approvals screen shows «نقل: من … ← إلى …», the reason, which
  approval is done / pending, the share when requested and now, and the impact. RTL / LTR, keyboard accessible,
  phone width.
- **Frontend:** Logs sentences — «نقل أحمد البند D7 من «شؤون العاملين» (…) إلى «المحاسبة» (…) برمز C12 — نُقل
  وزن 0.20 — السبب: «…»» (and «لم يُنقل وزن» for an excluded item / automatic weights), the two weight rows with the
  reason «نقل البند …», the move request and its source approval.
- **Tests:** `backend/test/move.test.js` (21) — `mov` 403, scope of source and destination 403, reason / destination
  400, direct move with exact numbers (share 2.00: 7 → 5 and 10.5 → 12.5, total conserved), new code and
  `function_moves`, excluded item (share 0, reason and duplicate link kept), auto mode, 409 blocks (pending request,
  pending import, removed), the two-lead flow (wrong stage / requester 403, share recomputed at approval, alerts),
  one approval by a lead of both, re-checks at approval (`mov` revoked, destination out of scope, item removed) and
  rejection, bulk all-or-nothing / shares / 200 limit / order independence, bulk request, seed guard, no code reuse,
  Logs of the old department, audit sentences (ar / en), badge data and scope, live events for both applications,
  both exports, approvals off. `backend/test/mov-permission.test.js` (2) — migration 019 on a 1.9.2 fixture.

### Changed
- **Backend:** the catalog seed no longer re-creates a catalog item in the application it was moved out of
  (`function_moves.from_app_id / from_code`); the seed's system-log row counts them (`movedOut`).
- **Backend:** `nextCode` (`services/functions.js`) also skips the `C<n>` codes of items moved out of the
  application, so a code is never reused after the item with the highest code leaves.
- **Backend:** Logs (`routes/logs.js`) — an audit row of a moved item shows the application and code the item had
  when the row was written; a scoped reader keeps the rows of an item moved out of their application up to and
  including the move, and sees move requests of either application.
- **Backend:** `requestsSettled` and the A2 reminder count a move request for its source until the source lead
  approved it, then for its destination.
- **Docs:** handover 01, 03 (permission table, section 1e), 04 (Arabic guide: moving items, weights with an
  example), 05 (migration 019, `function_moves`, request columns), 06 (authorisation), 11 (API); schema reference
  regenerated (`deploy/db/schema-reference.sql`).

### Security
- A move needs `mov` **and both applications in scope** on the server; nobody moves an item into or out of an
  application they cannot see. It is direct only for an approver of both applications, `cfg` / `apv_final`
  holders, or with approvals off. Each approval re-checks the requester (active, `mov`, both applications in
  scope — ETS-SEC-027) and the items (still in the source, not removed, nothing else pending), so a request cannot
  be used after the requester's rights changed. The two applications are locked in id order (no deadlock), every
  move writes strict audit rows, and an application outside the reader's scope is never named in the badge or the
  T8 alert.

### Upgrade notes
- Run the migrations (`update.sh` does it): **`019_move_items.sql`** creates `function_moves`, adds the move columns
  and the kind `move_function` to `edit_requests`, and gives `mov` to admin, mgr, pm, tm and lead. Existing requests
  are untouched.
- **`mov` defaults:** admin, mgr (department manager), pm, tm and lead get it; member, ed, qa and obs do not. It is
  a new capability, so — unlike `ren` in 1.9.2 — no per-user override is copied from another permission: nobody
  gains anything through an override, and an administrator grants it per user where wanted (Users → «نقل البنود»).
- **Weight share rule (fixed mode):** the item takes `weight(source) × item weight ÷ Σ weight of the source's counted
  items` of the source application's weight (0 for an excluded item; rounded to 0.01; never more than the source
  weight; the sum of the two weights is unchanged). Automatic mode transfers nothing. Check the Weights screen after
  large moves if the fixed weights were tuned by hand.
- **Seed guard:** after a move the seed (run at every start) no longer re-creates the item in its old application;
  nothing to do.
- A department without a team lead cannot sign its side of a move request: have a project / technical manager or an
  administrator move the item directly, or give the department a team lead.

---

## [1.9.2] — 2026-10-20 — Renaming items is its own permission

### Added
- **Backend:** permission key `ren` («تعديل اسم البند» / "Rename items") in `PERMISSIONS`
  (`backend/src/routes/users.js`), offered for per-user overrides and listed by `GET /api/users/meta`. The seed
  (`backend/src/db/seed.js`) gives it to every role that has `tog`: admin, pm, tm, mgr, lead, member.
- **Backend:** `GET /api/tracker/applications/:id` adds `can.ren`.
- **Frontend:** `perm_ren` labels (ar / en). The permissions list of a user (Users → user) shows the new row
  and its grant / revoke selector. Roles have no edit screen; they are defined in the seed.
- **Tests:** `backend/test/rename.test.js` (+4): `tog` without `ren` → 403 on rename while adding still works;
  `ren` without `tog` → rename allowed (sent to the team lead, then approved) while add / remove / exclude / item type
  / bulk exclude stay 403 `tog`; approving a member's rename after `ren` was revoked → 409
  `requester_not_allowed` (`requester_lacks_permission`), then approved once `ren` is back; seed roles and `can.ren`.
  `backend/test/ren-permission.test.js` (3): migration 018 on a 1.9.1 fixture (roles, copied overrides, audit
  rows, intact audit chain).

### Changed
- **Backend:** renaming an item (`PATCH /api/tracker/functions/:id` with `name_ar` / `name_en` and
  `rename_reason`) needs `ren` instead of `tog`: without it 403 `forbidden` with `permission: "ren"`. The scope check,
  the reason rules and the team-lead approval for members are unchanged. `tog` still covers include / exclude, add,
  remove, restore and the item type.
- **Backend:** `services/edits.js` — request items `name_ar` / `name_en` need `ren`, so approving a member's rename
  re-checks the member's `ren` (ETS-SEC-027). The approving team lead needs `apv_dept` and the scope, as for any field.
- **Frontend:** the rename pencil on the functions page shows only with `ren`.
- **Frontend:** Logs — permission overrides in a user's change history read with their labels
  («تعديل اسم البند +، تفعيل البنود وإضافتها −») instead of raw keys.
- **Docs:** handover 01, 03 (permission table by role), 04 (Arabic user guide), 05 (migration 018), 06 (permission
  list), 11 (API).

### Upgrade notes
- **Migration `018_rename_permission.sql`** (data only, applied by `update.sh` / at API start): every role with `tog`
  gets `ren`, and every per-user override of `tog` is copied to `ren` with the same value (one `audit_log` row per
  user concerned). **Nothing changes for anyone** until an administrator grants or revokes `ren` for a user in Users.
  No schema change (`deploy/db/schema-reference.sql` unchanged). Restart the API after updating.

---

## [1.9.1] — 2026-10-20 — Rename an item with a mandatory reason

### Added
- **Backend:** rename of a function / report item — `PATCH /api/tracker/functions/:id` with `name_ar` and / or
  `name_en` and a required `rename_reason` (permission `tog`; `backend/src/services/rename.js`). The reason follows the
  exclusion-note rule: trimmed, 3–500 characters, whitespace not counted. `name_ar` is trimmed, not empty, ≤ 500
  characters; `name_en` may be cleared (`null` / empty). The `code` never changes. The rename is sent on its own.
  Errors: 400 `rename_reason_required` (`min: 3`), `invalid_value` (`field`), `name_unchanged`,
  `rename_must_be_separate` (`fields`); 409 `function_removed` for a removed item; 403 without `tog` or out of scope.
  A name already used by another item of the application is allowed and answered with `warning: "duplicate_name"`.
- **Backend:** a data-entry user's rename waits for the team lead (202): one request item per changed name, the reason
  in `edit_request_items.meta.rename_reason` (the column of migration 013). On approval the current name must still be
  the name the request was made against, else 409 `name_changed` — nothing applied, the request stays pending;
  `approve-all` counts it in `blocked_requests`. `name_ar` added to the columns an approved request may set.
- **Backend:** strict audit row `update` / `function` with `old_value: {name_ar?, name_en?}` and
  `new_value: {name_ar?, name_en?, rename_reason}`; an approved rename is audited in the author's name with the
  reason. Live update `tracker_changed` after commit. The approvals Excel export adds «سبب تعديل الاسم: …» to the
  «بعد» cell of a rename.
- **Frontend:** functions page — a pencil button «تعديل الاسم» next to each item's title (with `tog`, not removed)
  opens «تعديل اسم البند» (`frontend/src/components/RenameDialog.jsx`): read-only code, current name, new Arabic name
  (required), English name, required reason with a counter; «حفظ الاسم» stays disabled until a name changes and the
  reason is valid; a non-blocking notice when another item already has the name. A pending rename shows on the row
  as «بانتظار الاعتماد: تعديل الاسم إلى «…»»; the Approvals page shows «الاسم: قديم ← جديد» and «سبب التعديل».
- **Frontend:** Logs — «غيّر أحمد اسم البند D7 في تطبيق … من «…» إلى «…» — السبب: «…»» (ar / en), field labels
  `au_f_name_ar` / `au_f_rename_reason`.
- **Tests:** `backend/test/rename.test.js` (12) — reason rules, empty / long / unchanged names, mixing fields, removed
  item, no `tog`, out of scope, direct rename and its audit row, clearing `name_en`, the duplicate-name warning, a
  member's request with its reason and its approval, the stale-name 409 (approve and approve-all), the live event.
- **Docs:** handover 04 (Arabic user guide: renaming an item) and 11 (API: the rename fields and errors).

### Changed
- **Backend:** `name_en` is no longer a plain field of the PATCH: changing it needs `rename_reason` like `name_ar`.
- Screens, search and the Excel exports already read the current name: they show the new name with no change.

### Upgrade notes
- No migration (the reason uses `edit_request_items.meta` from migration 013). Restart the API after updating.

---

## [1.9.0] — 2026-10-19 — Notifications, the bell and the phone API

### Added
- **Backend:** notifications (`backend/src/services/notify*.js`): the alert catalogue of the approved proposal —
  approvals A1 `approval_pending`, A2 `approval_overdue` (reminder after 48 h, escalation to PM / TM after 5 days),
  A3 `request_decided`, A4 `import_pending`, A5 `import_result`, A6 `import_overdue`; tracking T1 `stuck` (0 < % < 100,
  no progress change for N days, critical after 2N), T2 `untested` (100 %, not tested), T3 `failed_retest`, T4
  `pass_conflict`, T5 `not_started`, T6 `quality` (weekly), T7 `excluded`; plan P1 `dept_behind` (on a status change
  only), P2 `dept_stalled` (weekly), P3 `project_status`, P4 `close_approaching`; security / system S1
  `account_locked`, S2 `failed_logins`, S3 `audit_integrity`, S4 `email_index`, S5 `access_denied`, S6
  `backup_missing` (no `backup` row in `system_log` for 26 h), S7 `retention_reduced`, S8 `server_errors`.
  Stuck / untested / failed are three types with their own thresholds. Team members get the summaries of every
  application in their scope (full-scope users one per department).
- **Backend:** receiving = eligibility in code (effective permission + `canSeeApp` / `coversDept` / full scope /
  approver rules; security and system types for the `admin` role only) ∧ the policy `notify.policy` (type × role,
  phone allowed, mandatory) ∧ per-user restrictions (administrator blocks, then the user's muting) ∧ an active
  account. Checked when an alert is created **and whenever it is read** (list, count, phone).
- **Backend:** event alerts are created after `COMMIT` (`onCommit` in `db/pool.js` `tx`), never failing the action;
  periodic checks every 15 minutes in the API under a PostgreSQL advisory lock (`services/notify-scan.js`:
  security every run; system daily from the summary hour; summaries on work days; weekly T6 / P2), written to
  `system_log` (`notify_scan`). Summaries are one open row per user and key, updated in place; a read summary comes
  back only when it grows or gets worse, or after 7 days (1 day when critical); a summary whose condition is gone
  is closed. At most `notify.rate_cap_per_hour` new alerts per user per hour, the rest folded into one
  `rate_capped` alert (mandatory types are never held back). Read alerts are deleted after
  `notify.retention_days`, unread ones after twice as long.
- **Backend:** `GET /api/notifications` (filters, paging, `lang`), `/count`, `POST /:id/read`, `/:id/unread`,
  `/read-all`, `GET|PUT /prefs`, `GET /policy-meta`; titles and bodies rendered by the server in Arabic / English
  (`services/notify-text.js`). The live stream sends `notif_changed` `{unread, top_severity}` (no content).
- **Backend:** phones (Android app): `POST /api/devices/pair-code` (session + re-authentication; 10-character
  one-time code valid 10 minutes, stored as HMAC; QR payload `{"v":1,"url","code","cert_sha256"}`),
  `POST /api/devices/pair` (no session; `PAIR_RATE_LIMIT` per IP per 15 min; token of 32 random bytes returned once,
  stored as HMAC), `GET /api/devices`, `DELETE /api/devices/:id`; with the Bearer device token only:
  `GET /api/m/me`, `GET /api/m/notifications` (`after_id` → ascending, oldest first; without it the newest first),
  `POST /api/m/notifications/:id/read` (204), `GET /api/m/events` (SSE: `notification` `{id}`, `unread`
  `{unread}`, heartbeat every 25 s; closes when the device is revoked), `DELETE /api/m/device` (the phone unpairs
  itself, 204). Administrators: `DELETE /api/users/:id/devices/:deviceId`, `PUT /api/users/:id/notify-blocks`;
  `GET /api/users/:id` lists the user's devices and blocks.
- **Backend:** the project-health calculation moved to `backend/src/services/health.js` (schedule model and health,
  also used for P1–P4) — the browser uses an identical copy (`frontend/src/lib/health.js`, compared by a test);
  department thresholds come from `notify.dept_risk_gap` / `notify.dept_delay_gap` (`health_gaps` in
  `GET /api/tracker/project-status`), so the status page and the alerts agree.
- **Frontend:** the bell in the top bar (unread badge, «99+», red when a critical alert is unread; dropdown with the
  latest 20, category tabs, read / unread, mark all read, click to open; Escape / arrow keys; live count); the
  `/notifications` history page; Profile → «التنبيهات» (mute non-mandatory types in the app / on the phone, periodic
  summaries on / off; mandatory types locked) and «أجهزتي» (pairing QR drawn in the browser with
  `qrcode-generator` 2.0.4 — MIT, pinned exactly —, list, revoke); Settings → «الإشعارات» (on / off, summary hour,
  work days, time zone, every threshold, the type × role matrix with «الجوال» and «إلزامي»); the user page:
  notification blocks and the user's phones. Readable change-history sentences for the policy, blocks, device
  pairing and revocation. ar / en messages with identical key sets.
- **Database:** migration `017_notifications.sql` (see Upgrade notes).
- **Deployment:** nginx `location = /api/m/events` (streaming like `/api/events`) and `location = /api/devices/pair`
  (login rate zone); `install.sh` / `update.sh` write `PUBLIC_BASE_URL` and `TLS_CERT_SHA256` into `ets.env`
  (`set_mobile_env` in `deploy-lib.sh`).
- **Tests:** `backend/test/notifications.test.js` (22) and `backend/test/devices.test.js` (11).
- **Docs:** handover 03 (§3a notification policy), 04 (§6هـ the bell, preferences, pairing a phone), 05 (§3e
  migration 017, settings), 06 (§4b notification policy and phone devices), 10 (§1b notifications, phones, VPN),
  11 (`/notifications`, `/devices`, `/m/*`); `deploy/db/schema-reference.sql` regenerated.

### Changed
- **Backend:** settings `notify.*` added to `DEFAULT_SETTINGS` / `SETTING_RULES` with validation (ranges, work days,
  IANA time zone, risk gap < delay gap, escalation after the reminder, policy cells); `notify.policy` is stored and
  audited complete (old and new matrix).
- **Backend:** `routes/imports.js` exports `importAbilities`, `loadImportMeta`, `batchApps`; `routes/auth.js` exports
  `reauth`. `services/lockout.js` alerts the administrators when an account is paused; lowering a log retention
  also creates an S7 alert.
- **Frontend:** `components/SCurve.jsx` re-exports the schedule model from `lib/health.js`; the live stream stays
  open on every screen while signed in (the bell listens to it).

### Security
- Device tokens are valid **only** on `/api/m/*` (Bearer, no cookie) and never on the web API; session cookies are
  ignored on `/api/m/*`. Unknown / revoked tokens, and accounts that are inactive, deleted, paused or must change
  their password are refused (401 `invalid_token`, `mobile_token_rejected` in `auth_log`, 429 after 30 refusals per
  IP per 15 min). Pairing and revocation are recorded in `auth_log` (`mobile_device_paired`,
  `mobile_device_revoked`, `mobile_pair_code_issued`, `mobile_pair_rejected`) and the change history (`pair:device`,
  `revoke:device`). Phones are revoked in the same transaction as deactivation, deletion and an administrator
  password reset (06 §4b).
- Security / system alerts are for the `admin` role only; on phones they carry no body (no names or IP addresses),
  and S1, S2, S5, S8 are in-app only by default. A mandatory type kept off the phone appears there only as
  «لديك تنبيه جديد».

### Upgrade notes
- **Migration 017** (`017_notifications.sql`, applied by `update.sh`): new tables `notifications`,
  `notification_prefs`, `notification_user_blocks`, `notify_state`, `mobile_devices`, `device_pair_codes`; columns
  `functions.progress_changed_at` / `test_changed_at` with the trigger `ets_function_change_times`, filled once from
  the change history (newest `audit_log` row carrying the value, or a bulk-set row listing the function), otherwise
  from `updated_at`. No existing data changes. Checked on a copy of a 1.8.1 database: every function filled, audit
  chains intact.
- **New settings** (Settings → «الإشعارات»), with these defaults the administrator can change: thresholds stuck
  14 days, done-untested 7, failed-not-retested 7, not started 30, approval reminder 48 h / escalation 5 days, import
  waiting 3 days, department −5 / −15 points, stalled 0.5 point / 30 days, close date 30 days, failed sign-ins 20 /
  15 min, refusals 30 / h, server errors 10 / h, backup 26 h; summaries at 08:00 Sunday–Thursday, time zone
  `Africa/Tripoli` (the application had no time-zone setting; the installer only sets the server clock);
  50 new alerts per user per hour; read alerts kept 180 days; phones unused for 90 days revoked.
- **Other defaults the administrator can change:** the policy matrix of the proposal (§3.1); mandatory types A1 and
  A4 (approvers), A2 and A6 (team lead), S3, S6 and S7 (administrator); per-user blocks set by administrators only;
  alerts **hidden, not deleted,** when a permission or scope is removed; phones **revoked on an administrator
  password reset** (and on deactivation / deletion); **automatic revocation after 90 days** without use.
- **New environment variables** (`/etc/ets/ets.env`, `backend/.env.example`): `PUBLIC_BASE_URL` (the address in the
  pairing QR; default: the browser's address) and `TLS_CERT_SHA256` (SHA-256 of the server certificate, 64 hex
  digits, colons allowed; `null` in the QR when empty), both filled by `update.sh` from the nginx address and
  certificate (a hand-set `PUBLIC_BASE_URL` is kept; empty fingerprint for Let's Encrypt); `PAIR_RATE_LIMIT`
  (default 5). An invalid value stops the API at start with a message. After renewing the certificate run
  `update.sh` again; paired phones then pair again.
- **nginx:** `update.sh` re-renders the site with `location = /api/m/events` (`proxy_buffering off`, 1 h timeouts) and
  `location = /api/devices/pair`.
- **VPN:** phones reach the server inside the network or over the organisation's VPN — never open the HTTPS port to
  the internet. Nothing else is needed on the server; if the phones use another name over the VPN, set
  `PUBLIC_BASE_URL` to it (with a self-signed certificate that name must be in the certificate) — 10 §1b.
- The Android app itself is built and distributed separately (GitHub Actions).

---

## [1.8.1] — 2026-10-19 — «نجح» requires 100% progress

### Changed
- **Backend:** the test status «نجح» (plain pass, `test_status = 2`) is accepted only with progress 100, and the
  progress of a passed item cannot go below 100. «نجح مع ملاحظة» (pass with note, `1`) has no progress rule. Only a
  change of `test_status` or `progress` is checked (`backend/src/services/passRule.js`). Applies to function and
  report items alike, on every path:
  - `PATCH /api/tracker/functions/:id` → 400 `pass_requires_100` (unless the same request sets `progress: 100`) or
    400 `progress_below_100_while_passed` (unless the same request moves the status away from «نجح»); the saved row
    is checked again (409, rolled back) against a change made at the same moment;
  - bulk `POST /api/tracker/applications/:id/bulk` (`progress` / `test_status`): all or nothing, 400 with `count`,
    `items` (each blocking item with its progress) and `list`;
  - edit requests: refused at submit with the same 400; checked again on approval against the current values →
    409 with the same code, nothing applied, the request stays pending; `approve-all` counts it in
    `blocked_requests`;
  - team result imports: `POST /api/imports/preview` options carry `errors` (row errors); `POST /api/imports` refuses
    a part with errors (400 `import_has_row_errors`, no batch); when a batch is applied, a change that would now
    break the rule is put back and listed as skipped with the rule's code;
  - legacy tracker import `POST /api/tracker/import` and `npm run import-legacy`: refused as a whole with
    `import_has_row_errors` and the rows.
  - Add-function takes no test status (a new item is «لم تُختبر»): nothing to check there.
- **Frontend:** functions page — choosing «نجح» below 100 % is not saved: the list goes back to its value and a red
  alert explains why («… النسبة الحالية: 80%. أدخل نسبة الإنجاز 100% أولاً ثم اختر «نجح».»); typing a progress
  below 100 on a passed row is not saved either («الحالة «نجح» تتطلب 100%. غيّر حالة الاختبار أولاً.»). Nothing is
  filled in automatically. Server refusals (bulk, approvals, imports, legacy import) show the same ar / en messages.
- **Tests:** three `api.test.js` fixtures that set «نجح» below 100 % now set 100 % first (or «فشل» in the import file).

### Added
- **Frontend:** a warning icon ⚠ «نجح والنسبة أقل من 100%» beside the test status of items passed below 100 %
  before 1.8.1; a chip «تعارض الحالة والنسبة: N» and a test-status filter option of the same name that list them;
  the bulk dialog lists the blocking items one by one; the import preview shows the row errors of each part and
  does not let it be chosen; a batch's skipped changes give the rule's message.
- **Backend:** Excel functions export filter `test=conflict` («تعارض الحالة والنسبة»).
- **Tests:** `backend/test/pass-rule.test.js` — single edit both ways, «نجح مع ملاحظة» at 80 %, report items, bulk,
  approval submit and re-check, import preview row errors and apply-time re-check, legacy import, legacy items fixed
  either way, the export filter.
- **Docs:** handover 04 (Arabic user guide: the rule, the alerts, the flagged items and the filter) and 11 (API:
  `pass_requires_100`, `progress_below_100_while_passed`, `import_has_row_errors`, preview `errors`, `test=conflict`).

### Upgrade notes
- No migration. **Existing data is not changed:** items already «نجح» with progress below 100 % stay as they are and
  are flagged on the functions page (icon, «تعارض الحالة والنسبة» count and filter); every other edit of them still
  works, and each is fixed by setting progress 100 or changing the test status.
- Pending edit requests and import batches made before the upgrade are checked by the rule when approved.
- A team result file or legacy tracker file that sets «نجح» below 100 % is now refused: fix the file first.

---

## [1.8.0] — 2026-10-19 — Mark each item as a function or a report

### Added
- **Database:** `functions.item_type` — `function` (default) or `report` (migration 016).
- **Backend:** the type of an item can be changed by whoever can add and remove items (permission `tog`):
  - `PATCH /api/tracker/functions/:id` `{item_type}` (400 `invalid_value` for anything but `function` / `report`);
  - bulk `POST /api/tracker/applications/:id/bulk` `{field: 'item_type', value, function_ids}` (1–500 items of the
    application, not removed; excluded ones allowed), one audit row per item with `context.bulk`;
  - add-function `POST /api/tracker/applications/:id/functions` `{…, item_type}`, also in the impact preview.
  - With `approval.edits_need_lead` on, a data-entry user's change waits for the team lead
    (`edit_request_items.field = 'item_type'`) and is applied in their name. Every change has its `update` /
    `function` audit row `{item_type}` old → new; live updates fire after COMMIT.
- **Backend:** `summary`, `departments/:id`, `applications/:id` → `calc.fnShare`, `reportShare`,
  `items {function, report}`, `typeWeight`, `reportItems`, `reportTrack`, `reportWeight`; `summary.counts.report_items`;
  `reports` → `report_pct`, `report_items`; `project-status` → `report_items`, `report_tracks`; `search` →
  `item_type`.
- **Backend:** Excel — functions export: column «النوع» / “Type” and the filter `item_type=function|report`;
  department export: «بنود التقارير» and «إنجاز التقارير»; reports export: the application's report items and
  reports %; project status: «بنود مصنّفة تقارير».
- **Frontend:** functions page — every row shows its type beside the name:
  - a navy cog chip «وظيفة» or a teal document-chart chip «تقرير», plus a teal line on the start edge of report rows
    (colours outside the red → green progress scale and the pass / fail test colours);
  - for users with `tog` the chip is a menu button (`aria-haspopup="menu"`, `menuitemradio` options; Enter / Space /
    ↓ open, ↑ ↓ Home End move, Esc closes); read-only otherwise;
  - a type filter «النوع: الكل / وظائف / تقارير» (also passed to the Excel export) and a legend «دليل الأنواع».
- **Frontend:** «تعيين جماعي» → «تعيين النوع لبنود محددة»; a type choice in «إضافة وظيفة»; the header counts
  «وظائف 31 · تقارير 2»; the reports ring shows what it is made of («2 بند تقرير + متابعة التقارير»); pending chips
  and the approvals screen show the type old → new.
- **Frontend:** audit sentence «غيّر أحمد نوع البند «D7 …» من وظيفة إلى تقرير» (bulk: «ضمن تعيين جماعي (n بند)»).
- **Frontend:** the dashboard card «وظيفة داخلة في الحساب» adds «+ n بند تقرير»; the department table shows the
  report items next to the functions; the reports screen adds «بنود التقارير» and «نسبة التقارير المحتسبة» (its
  top card uses the latter); search results show the type icon.
- **Tests:** `backend/test/item-type.test.js` (default type and constraint, exact figures before / after on a
  fixture, excluded / removed report items, base department and all-report application, PATCH audit, approval flow
  and the approvals export, bulk, add-function and its impact preview, scope, Excel column and filter, project status
  and reports agree); `calc.test.js` (5 tests: the move between parts, 1.7.0 figures without report items, base
  department, notification blending, counts); `live.test.js` (type change → `tracker_changed` after commit).

### Changed
- **Backend:** the calculation (`backend/src/services/calc.js`, the only copy of the formula — screens, Excel,
  snapshots, schedule current %, import impact all use it; the function columns it reads are one constant,
  `CALC_FUNCTIONS_SQL`):
  - **functions %** = weighted average of the enabled items of type `function`;
  - **reports %** = weighted average of the enabled items of type `report` (same weight, progress and notification
    rules) **together with** the application's reports track (`app_reports`, non-base departments) counted as one
    more item of weight 1 — null when the application has neither;
  - **application %** = functions % × (1 − reports share) + reports % × reports share (15 %); functions % × 100 %
    when there are no reports (as before); reports % × 100 % when every counted item is a report;
  - department and project “functions only” figures leave out applications whose % has no functions part;
  - an application's weight in `auto` mode stays the sum of all its enabled items (both types).
- **Backend:** `counts.functions` / `done` (dashboard, project status, snapshots) count function items only;
  `project-status` `reports` / `reports_done` / `reports_pct` pool report items and reports tracks (with no report
  items, identical to 1.7.0).
- **Frontend:** `PctEquation` takes the shares from the API (`calc.fnShare` / `reportShare`) instead of re-deriving
  them; the share shown under each item is its share of its own part (functions or reports), as in the export.
- **Docs:** 04 (Arabic user guide: the item type, how to change it, how the percentages are computed, an example),
  05 (column, migration 016, the calculation table), 11 (fields, bulk, add-function, exports);
  `deploy/db/schema-reference.sql` regenerated (migration 016).

### Fixed
- **Tests:** `audit-log.test.js` waits for the asynchronous `csrf_rejected` auth-log row before counting it
  (intermittent failure).

### Upgrade notes
- **Migration `016_item_type.sql`** (applied by `update.sh`): `functions.item_type text NOT NULL DEFAULT 'function'`
  with `CHECK (item_type IN ('function','report'))`.
- **Percentages change only for items marked as reports.** On upgrade every item is a function, so every application,
  department and project figure stays exactly as in 1.7.0 until someone marks an item «تقرير»; then only that
  application's figures (and through it its department and the project) move. Re-seeding the catalog keeps the types.
- Import files (the original tracker JSON) have no type column: imports never change an item's type.

---

## [1.7.0] — 2026-10-19 — Deleting users (one or several), with the history kept

### Added
- **Backend:** deleting users is a **soft delete** — the row stays, so every name in the history still resolves;
  `audit_log` / `auth_log` (hash chains, migration 012) only receive new rows.
  - `DELETE /api/users/:id` `{reason}` and `POST /api/users/bulk-delete` `{ids, reason}` (1–200 ids, one
    transaction, **all or nothing**: 400 `bulk_delete_refused` with `errors: [{id, username?, error}]` —
    `not_found`, `already_deleted`, `cannot_delete_self`, `last_admin`).
  - System administrators only; reason required (3+ characters without spaces, at most 500:
    `delete_reason_required` / `delete_reason_too_long`).
  - In the same transaction: every session revoked (`revoke_reason='user_deleted'`), authenticator and recovery
    codes removed, the user's pending edit requests **withdrawn** and pending import files **rejected** (each with
    its own `edit_withdraw` / `import_reject` audit row, `context.user_deleted`), one strict `delete` / `user` audit
    row per user (reason, target, by, scopes and overrides before, sessions / requests closed) plus `bulk_delete` /
    `user` for a bulk request, and an `auth_log` row `user_deleted_by_admin`. After COMMIT the user's live streams
    close (`session_check`).
- **Backend:** `POST /api/users/:id/restore` `{reason}` — the account comes back with its role, scopes and
  overrides, a new random temporary password (returned once, `must_change_password: true`) and no authenticator;
  409 `username_taken` / `email_taken` when another account now uses them. Audit `restore` / `user`, auth
  `user_restored_by_admin`.
- **Backend:** `GET /api/users?deleted=1` lists the deleted accounts (who, when, why, whether the name / address
  are taken); the users Excel export with `?deleted=1` exports them (deleted on, by, reason).
- **Frontend:** Users screen tabs «المستخدمون» / «المستخدمون المحذوفون»:
  - row checkboxes with select-all (own account and the last active administrator disabled, with a tooltip),
    «حذف المحدد (n)», and a delete button on each row and on the user page;
  - red confirmation dialog listing the names, a warning that the history is kept and a required reason with a
    counter (Confirm disabled until valid, per-id errors shown); toast and refresh after;
  - deleted-users tab with «استعادة» (disabled when the name / address is taken), showing the temporary password
    once.
- **Frontend:** audit sentences «حذف أحمد المدير المستخدم «سالم» — السبب: …», bulk delete and restore; a request or
  import file closed by a deletion says so; the author of a history row is marked «(محذوف)».
- **Tests:** `backend/test/user-delete.test.js` — 403 for non-administrators, self / last administrator refused,
  reason rules, single delete (sign-in refused, sessions and live stream closed, hidden, history names intact,
  audit row, `verifyAll()` intact), sessions of a deleted user refused on every auth path, pending requests /
  imports closed, bulk all-or-nothing, username and e-mail reuse, restore (409 while taken, temporary password,
  scopes back), and the partial e-mail index (rebuilt from the 1.6.0 shape, kept by later calls).

### Changed
- **Backend:** a deleted account is inactive everywhere (`loadUserContext`): no session, no 2FA step, no
  re-authentication, no live stream, no approval of its old requests; sign-in by username or e-mail never finds
  it. It is left out of the Users list, `GET /users/:id` and the actions (404), the bulk 2FA change, the bulk
  import's "taken" checks, the administrator count (`last_admin`), `create-admin` and the system user count.
- **Backend:** the username and e-mail of a deleted account are free for a new account. The users Excel export
  leaves deleted accounts out by default; audit log rows carry `user_deleted` (also a column of the audit log
  export).
- **Docs:** 04 (Arabic user guide: deleting and restoring users), 05 (columns, migration 015, partial unique
  indexes, FK inventory), 06 (deletion rules), 11 (endpoints and errors); `deploy/db/schema-reference.sql`
  regenerated (migration 015).

### Upgrade notes
- **Migration `015_user_delete.sql`** (applied by `update.sh`): `users.deleted_at`, `deleted_by` (→ users,
  `ON DELETE SET NULL`), `delete_reason` (≤ 500 characters).
  - The username unique constraint becomes the partial index `users_username_live_key … WHERE deleted_at IS NULL`.
  - `ets_ensure_email_unique_index()` (migration 014) is replaced so that `users_email_lower_uniq` also carries
    `AND deleted_at IS NULL` — rebuilt from the 1.6.0 shape by the migration, and built that way by every later
    call from `migrate.js`.

---

## [1.6.0] — 2026-10-19 — Sign in with the username or the e-mail address

### Added
- **Backend:** `POST /api/auth/login` accepts the **username or the e-mail address** in `username`. The value is
  trimmed; one containing `@` is matched to `lower(email)`, anything else to the username (case-insensitive, as
  before). With `@` and no e-mail match it falls back to an exact username match, so an older account whose
  username contains `@` (command line only) keeps signing in. An address shared by several accounts signs nobody
  in.
- **Frontend:** login field «اسم المستخدم أو البريد الإلكتروني» / "Username or email" — plain text input (not
  `type=email`), `autocomplete="username"`, `dir="ltr"`, placeholder `ahmed.ali / ahmed@example.ly`; the sub-title
  and credential error texts mention the e-mail; new messages for `email_taken` / `duplicate_email_in_file`.
- **Tests:** `backend/test/login-email.test.js` — login by username; by e-mail in mixed case and with spaces;
  identical answers for wrong password by e-mail / username, unknown name / address and inactive user; lockout
  across both names; per-name rate limit across case and spaces; 2FA step and forced change after an e-mail
  sign-in; shared address refused while usernames work; migration 014 on duplicates (no failure, NOTICE, warning
  row, no index, index on a later run) and on a clean database; users create / update / import refuse duplicates
  and `@` in usernames; legacy `@` username still signs in and can be edited. `users-import.test.js` expects
  `email_taken` on re-import (136 tests in total).

### Changed
- **Backend:** users create / update / import and `create-admin` store the e-mail trimmed in lower case; a
  duplicate address (any case, or equal to an older username with `@`) is refused — `400 email_taken`, import row
  codes `email_taken` / `duplicate_email_in_file` with `details` (`field: "email"`). `@` stays refused in new
  usernames; `PATCH` accepts an older username sent back unchanged and checks the address only when it changes.
- **Deployment:** the installer's final summary and `create-admin` say the administrator can sign in with the
  username or the e-mail address.
- 2FA, the forced password change, session rotation and the `__Host-ets_sid` cookie are unchanged.
- **Docs:** user guide 04 (sign-in name, lockout note), administrator guide 03, database design 05 (§3b migration
  014), security 06 (sign-in name, enumeration, lockout across names), logging 07 (`detail.via`,
  `login_ambiguous_email`), test plan 09 (A-02b, A-02c), API reference 11; `deploy/db/schema-reference.sql`
  regenerated with pg_dump after migration 014.

### Security
- No enumeration through the second name: every failure (unknown username or address, shared address, wrong
  password, disabled or paused account) gives the same `401 invalid_credentials` without a cookie, and the unknown
  / shared / paused cases still run the dummy bcrypt check of the same cost.
- The per-account serialisation of password and code checks is keyed on the resolved user id (login, 2FA verify /
  enable, re-authentication), so failures through the username and the e-mail address add up on one account
  counter (e.g. 1 + 1 + 1 with `MAX_FAILED_LOGINS=3` pauses the account) and a pause applies to both names. The
  per-name rate limit keys on the trimmed, lower-case typed name.
- `auth_log` login rows carry `detail.via` (`username` | `email`) and, for a known account, `detail.identifier`
  (trimmed, lower case) next to the resolved `user_id` / `username`; unknown names stay masked (ETS-SEC-051); new
  event `login_ambiguous_email`.

### Upgrade notes
- **Migration `014_login_email.sql`:** unique index `users_email_lower_uniq` on `lower(email)` where set, built by
  `ets_ensure_email_unique_index()`.
  - On a database **without** shared e-mail addresses it creates the index.
  - **With** shared addresses the update does not fail: the index is skipped with a `NOTICE` and a `system_log`
    warning **`email_index_skipped`** (the addresses and any usernames with `@`). Sign-in by those addresses is
    refused until each account has its own (Users screen); the next service start or `npm run migrate` creates
    the index (`migrate.js` calls the function again and prints the migrations' own `ETS:` notices).
  - On a local install `ets-log-protect migrate` runs with `client_min_messages = warning`, so the NOTICE is **not**
    printed by `update.sh`: check Logs → System (`email_index_skipped`) or `app.log` (`notice: ETS: …`). Manual
    check: [05 §3b](docs/handover/05-Database-Design.md).

---

## [1.5.1] — 2026-10-19 — Exclusion note required for every reason

### Changed
- **Backend:** «الملاحظات لسبب الإلغاء إلزامية» — `disabled_note` is now required for every reason (`duplicate`,
  `out_of_scope`, `not_required`, `other`), not only `other`: at least 3 non-whitespace characters after
  trimming, still ≤ 500.
  - A missing, empty, whitespace-only or shorter note → 400 `disable_note_required` (`min: 3`) on every path that
    turns a function off: `PATCH /api/tracker/functions/:id`, bulk `enabled: false`, and requests that wait for
    the team lead (checked when submitted, `backend/src/services/disable.js` `NOTE_MIN`).
  - Approval does not check it again, so requests submitted before 1.5.1 without a note are still approved as
    they are. The `import` reason keeps its generated note (`#<batch id> <file name>`).
- **Frontend:** the exclusion dialog and the bulk exclusion mark «ملاحظة الإلغاء» as required (*); the helper text
  says it is required for every reason (at least 3 characters), a live counter shows the length, an inline error
  appears once the field is typed in or left, and the confirm button stays disabled until the note is valid
  (`frontend/src/components/DisableReason.jsx` `noteProblem`, `frontend/src/pages/Application.jsx`).
- **Frontend:** messages `dr_note_hint`, `dr_note_placeholder`, `dr_note_required`, `err_disable_note_required`
  updated in ar + en.
- **Tests:** `backend/test/disable-reason.test.js` — each of the 4 reasons without a note, with an empty, `null`,
  whitespace-only or too short note → 400 `disable_note_required`; 3 and 500 characters accepted; bulk without a
  note (every reason) → 400; a request submitted without a note → 400 and no request created (single and bulk); a
  pending request whose item has no note is still approved and applied (124 tests in total).
- **Docs:** user guide (required note, disabled confirm button), API reference (PATCH / bulk / approvals), database
  design; version 1.5.1 in both `package.json` and lockfiles.

### Removed
- **Frontend:** messages `dr_note_placeholder_required` and `dr_note_required_hint` (ar + en; key sets identical).

### Fixed
- **Frontend:** `.field-hint.red-text` is red again (`.field-hint` came later in `app.css` and turned inline
  errors grey).

### Upgrade notes
- No migration.

---

## [1.5.0] — 2026-10-18 — Required reason when a function is excluded (duplicates)

### Added
- **Backend:** **excluding a function needs a reason** on every path that turns one off
  (`backend/src/services/disable.js`).
  - `PATCH /api/tracker/functions/:id` with `enabled: false` takes `disabled_reason`, `disabled_note` (required
    for `other`) and, for `duplicate`, `duplicate_of` (function ids in the user's scope, not the function itself,
    not removed) — otherwise 400 `disable_reason_required`, `disable_note_required`, `duplicate_of_required`,
    `invalid_duplicate` (`self` / `unavailable` / `removed`) or `invalid_value`.
  - Including again needs no reason and clears it; the audit row keeps the previous reason as its old value.
- **Backend:** bulk exclusion — `POST /api/tracker/applications/:id/bulk` with `{field: 'enabled', value: false,
  function_ids, disabled_reason, …}` (permission `tog`): one reason for the chosen functions (the duplicated
  functions may not be among them), one audit row per function; `value: true` includes them again.
- **Backend:** approval flow — a data-entry user's exclusion (single or bulk) carries its reason and links in the
  request item (`meta`); the approver sees them (`GET /api/approvals`, Excel export of the approvals) and approval
  applies them in the requester's name. The requester's scope is checked again for the duplicated functions
  (409 `requester_not_allowed`); an exclusion whose duplicated function was removed meanwhile is skipped.
- **Backend:** imports — a function an approved team-result batch turns off gets the reason `import` with the note
  `#<batch id> <file name>`; the full legacy import marks the functions it turns off `import` too; functions turned
  on by an import lose their reason. Restoring a removed function clears it.
- **Backend:** `GET /api/tracker/function-options` (`app_id`, `all=1`, `q`, `exclude`) — the counted functions a
  duplicate can point at, within scope; the application data lists `duplicate_of` (codes, application, names only
  in scope) and `disabled_by_name`.
- **Backend:** functions Excel export — columns «سبب الإلغاء», «مكررة مع», «ملاحظة الإلغاء» (after the existing
  columns, whose positions do not change) and the `reason` filter; the approvals export adds the reason to an
  exclusion.
- **Frontend:** unticking a function opens the exclusion dialog (`frontend/src/components/DisableReason.jsx`,
  `frontend/src/components/MultiSelect.jsx`):
  - reason category (radio cards) and a note with a counter; Cancel leaves the box ticked;
  - for «مكررة» a **searchable multi-select** of the functions it duplicates (code + name + application; this
    application by default, «البحث في كل التطبيقات» for every application in scope; the function itself, excluded
    and removed ones are not offered); chips with ×;
  - keyboard: arrows, Home/End, Enter, Esc (closes the list, a second Esc the dialog), Backspace removes the last
    chip; combobox / listbox roles, `aria-activedescendant`, `aria-selected`, a live result count; RTL and LTR.
- **Frontend:** «تعيين جماعي» gains «إلغاء احتساب وظائف محددة»: pick the functions, then one reason.
- **Frontend:** an excluded row shows its reason as a badge — «مكررة مع: D3، D5» (each code opens and highlights
  that function, also in another application, `#fn-<id>`), «خارج النطاق», «استيراد», «بدون سبب مسجّل» …; a click
  shows the note, who excluded it and when. New filter «سبب الإلغاء» (also sent to the export).
- **Frontend:** the approvals screen and the "awaiting approval" chips show the reason of a pending exclusion.
- **Frontend:** audit sentences — «ألغى أحمد سالم احتساب الوظيفة «D7 …» في تطبيق شؤون العاملين (مكررة مع D3، D5):
  «…»» / "… excluded function … from the calculation (duplicate of D3, D5): …" with the reason, duplicates and note
  as before → after lines; «أعاد … احتساب الوظيفة …» with the previous reason; requests list the reason (ar + en,
  messages `dr_*`, `ms_*`, `au_disable_*`, `au_enable_*`, `err_disable_*`, `err_duplicate_of_required`,
  `err_invalid_duplicate`).
- **Tests:** `backend/test/disable-reason.test.js` — 400 without / with an invalid reason, `other` without a note,
  duplicate without ids, pointing at itself, out of scope, unknown or removed; a valid exclusion stores reason,
  note and links and writes them in the audit row; including again clears them (history kept); restore clears;
  bulk exclusion and inclusion; approval carries the reason (single and bulk) and skips a removed duplicate; picker
  options; export columns and reason filter; import batch and legacy import set `import` (124 tests in total).

### Changed
- Removal («إزالة») already required its own reason since 0.8.0 and is unchanged. Adding a function with
  «تضمينها في حساب النسب» unticked records no exclusion reason (shown as «بدون سبب مسجّل»).
- **Docs:** user guide (exclusion dialog, badge, filter, approvals), API reference (PATCH / bulk / function-options
  / approvals / imports / export), database design and `deploy/db/schema-reference.sql` (migration 013).

### Upgrade notes
- **Migration `013_disable_reason.sql`:** `functions.disabled_reason` (`duplicate`, `out_of_scope`,
  `not_required`, `other`; `import` set by imports), `disabled_note` (≤ 500), `disabled_by`, `disabled_at`; table
  `function_duplicates(function_id, duplicate_of_id)` (FKs ON DELETE CASCADE — functions are only soft-removed —,
  no self link, index on the target); `edit_request_items.meta` (the reason of a pending exclusion).
- Safe on an existing database: functions excluded before 1.5.0 keep an empty reason («بدون سبب مسجّل» / "No reason
  recorded"); `audit_log` / `auth_log` and their hash chains are untouched.

---

## [1.4.0] — 2026-10-18 — ERP module wheel and live updates

### Added
- **Frontend:** **ERP module wheel** at the top of the dashboard (`frontend/src/components/ErpWheel.jsx`,
  `frontend/src/lib/erpModules.js` — the editable module list and mapping):
  - a circle of the 8 standard ERP modules (Production, Human Resources, Planning, Inventory Management,
    Reporting, CRM, Sales & Marketing, Finance & Accounting) around a hub with the overall progress «إجمالي
    الإنجاز» / "Overall progress"; the hero ring card is replaced by the hub, the other cards stay below;
  - a module fed by a department is **active**: navy / blue segment with its line icon, name and the department %
    on a white chip, plus a thin progress arc on the outer rim, in the continuous tone of `pctTone` (critical →
    good); click / Tab + Enter opens the department page;
  - modules without a department are **faded** («غير مفعّل» / "Not activated", not clickable); for a scoped
    reader a department outside the scope is faded «خارج نطاقك» / "Outside your scope" with no % (only
    `/api/tracker/summary` data is used);
  - mapping by department id: `hr` → Human Resources, `fin` → Finance & Accounting, `com` → Sales & Marketing;
    `inf` (Infrastructure) and any other department get a segment of their own after the standard ones;
  - pure inline SVG, constant-width white gaps, mirrored in Arabic, values glide to the new level (none with
    `prefers-reduced-motion`), responsive (≈520 px on desktop, full card width on phones, no horizontal scroll);
    beside it the active modules with their %, a legend (active / not activated / outside scope) and the tone
    scale;
  - new icons `factory`, `planning`, `chart`, `crm`, `megaphone`; messages `erp_*`, `live_*`.
- **Backend:** **live updates** — `GET /api/events` (signed in), Server-Sent Events (`backend/src/services/live.js`,
  `backend/src/routes/events.js`):
  - events `ready`, `tracker_changed` (`{type, dept_id?, app_id?}` — ids only, never values), `session_ended`;
    heartbeat comment every 25 s (`LIVE_HEARTBEAT_SECONDS`); at most 5 streams per user
    (`LIVE_MAX_STREAMS_PER_USER`, `429 too_many_streams`); `X-Accel-Buffering: no`;
  - every change is announced **after its transaction committed** with `pg_notify` on channel `ets_live`; each API
    process keeps one dedicated `LISTEN` connection (opened with the first stream, reconnects with backoff and then
    tells its streams to reload once), so it also works with several processes (the systemd unit runs one);
  - events go only to streams whose user has that department / application in scope;
  - announced changes: function edits (%, weight, statuses, note, include / exclude), bulk set, add / remove /
    restore (direct or sent for approval), edit requests approved / rejected / withdrawn / approved in bulk,
    application weights and calculation parameters, weights reset, reports track, schedule and timeline,
    team-result imports (submitted, signed, applied, rejected), the full tracker import, and settings that change
    the calculation or the approval rule.
- **Frontend:** **screens update without reloading the page** — dashboard (wheel, cards, notices, curve),
  department, application, project status, reports and weights reload through their usual scoped endpoints
  (`useLiveUpdates`, `frontend/src/lib/live.js`):
  - one `EventSource` per tab, reloads debounced 400 ms, filtered by department / application hints, reconnection
    with backoff, paused while the tab is hidden and reloaded when shown again, polling every 30 s after repeated
    failures; badge «تحديث مباشر» / "Live" (or "Every 30 s");
  - `useLoad()` gained a silent `refresh()` that keeps the screen while loading and drops out-of-order answers;
  - a live reload never overwrites what the user is typing: the application table keeps a number cell being edited
    and rows whose save is in flight; the weights page keeps unsaved weights / parameters; open edit windows keep
    their own values.
- **Deployment:** new optional settings `LIVE_HEARTBEAT_SECONDS`, `LIVE_MAX_STREAMS_PER_USER`
  (`backend/.env.example`); graceful shutdown closes the open streams first (`backend/src/server.js`).
- **Tests:** `backend/test/live.test.js` — `/api/events` requires a session; a function % update sends
  `tracker_changed` after commit with ids only and no values; a scoped user hears only about their scope; sign-out
  and an expired session close the stream; the stream is not activity; the per-user cap; the stream opening is
  logged once (116 tests in total).

### Changed
- **Docs:** user guide (dashboard wheel, live updates), API reference (`/events`), security (sessions and live
  updates), installation guide (nginx step), operations runbook (live updates not arriving).

### Security
- The stream's session is re-checked on every heartbeat (revoked, expired, idle, user disabled, password change
  required) and at once on sign-out, re-sign-in, password change / admin reset, 2FA reset / disable, *End
  sessions*, deactivation and scope / role / permission changes (`session_check` notification to every process);
  the stream then closes with `session_ended` and the app shows the sign-in page. A scope change applies to the
  next events at once.
- The stream and the reloads it triggers (header `X-ETS-Live: 1`) are not counted as activity for the idle
  timeout, so an open dashboard does not keep a session alive; opening a stream counts as one request for the
  general rate limit; the access log records the stream opening once, not its heartbeats. CSP unchanged
  (`connect-src 'self'` covers the stream).

### Upgrade notes
- **nginx:** new `location = /api/events` — `proxy_buffering off`, `proxy_cache off`, `gzip off`,
  `proxy_read_timeout` / `proxy_send_timeout` 1 h, HTTP/1.1 keep-alive to the API
  (`deploy/nginx/ets-app.conf.tpl`). `update.sh` re-renders the snippet and runs `nginx -t`; after a manual change
  run `sudo nginx -t && sudo systemctl reload nginx`.
- A proxy / load balancer in front of nginx must not buffer `text/event-stream` (see the operations runbook if the
  badge shows "Every 30 s" instead of "Live").

---

## [1.3.0] — 2026-10-18 — Excel exports and the export policy

### Added
- **Backend:** **Excel (xlsx) exports generated on the server** — `GET /api/export/<report>.xlsx`
  (`backend/src/routes/export.js`, `backend/src/services/xlsx.js`, `backend/src/services/export-labels.js`):
  - reports: dashboard summary (`summary`), project status (`project_status`), department page (`department?id=`),
    application functions (`functions?id=` with the screen's `q, source, test, show_off, show_removed`), weights,
    reports (`dept`), the schedule table (period, period end, planned, actual, deviation), edit requests with their
    items (`approvals`: `status, mine`), import batches (`imports`: `status`) and one batch's changes
    (`import_detail?id=`), users (`users`) and logs (`log?type=` with the Logs filters, beside the CSV);
  - one sheet per file: title row, exporter / UTC time / filters, bold frozen header with an autofilter, sensible
    column widths, numbers as numbers, percentages with a `0.0%` format, dates as dates, right-to-left sheet in
    Arabic; headers and values translated (`lang=ar|en`, default: the user's language);
  - `Content-Disposition` with an ASCII `filename` and the translated name as RFC 5987 `filename*`; at most 100,000
    rows.
- **Frontend:** «تصدير إلى إكسل» / "Export to Excel" button on the dashboard, project status, department,
  application, weights, reports, curve, approvals, imports (list and batch), users and logs pages, sending the
  filters applied and the UI language; shown only with `exp` (users: administrator with `usr` too). The file is
  fetched with the session cookie and the `X-Requested-With` header; an error is shown as a message instead of a
  JSON page (`frontend/src/components/ExportButton.jsx`, `downloadFile()` in `frontend/src/lib/api.js`, new
  `sheet` icon). New messages `export_xlsx`, `exporting`, `au_export_report`, `au_export_report_of`,
  `au_export_filters`, `au_export_truncated`, `xr_*`, `xf_*` (ar + en).
- **Frontend:** export rows read as sentences in the audit trail — «تصدير تقرير «وظائف التطبيق» — «…» إلى ملف إكسل
  (33 صف)» with the filters on a second line; the log export sentence names the format (CSV / Excel) and the row
  count (`frontend/src/lib/audit.js`).
- **Backend:** dependency `exceljs ^4.4.0` (with the `uuid ^11.1.1` override, as in the frontend; `npm audit`: 0).
- **Tests:** `backend/test/export.test.js` — 403 without `exp` for every report and for the CSV log export (also
  when `exp` is removed by an override), scope (another department / application → 403, summary / weights /
  approvals limited to the scope, security logs and IP column for administrators only), users export
  administrators only with exactly the listed columns and nothing sensitive, xlsx parsed back with exceljs
  (headers, rows, RTL, frozen header, autofilter, `0.0%` format, filename headers), audit row contents, refusal
  when the audit row cannot be written, formula neutralisation and no formula cells.

### Changed
- **Backend (refactoring):** the tracker, approvals, imports and users list handlers call exported data functions
  shared with the exports; `exportRows()` in `routes/logs.js` serves the CSV and the Excel log export (the CSV
  header line is now written also when no row matches).
- **Docs:** *06-Security.md → 4a. Export policy / سياسة التصدير* with the report × permission × scope × sensitivity
  × audit matrix; API reference (`/export`), Logging and Audit, Administrator Guide and the Arabic user guide.

### Security
- **Export policy:** every export needs `exp` — the Excel exports and now also the CSV log export (`log` **and**
  `exp`; the Logs screen itself still needs `log` only).
  - Each Excel export reads its rows through the same function as its screen (`summaryData`, `departmentData`,
    `applicationData`, `weightsData`, `reportsData`, `scheduleData`, `projectStatusData` in `routes/tracker.js`;
    `listRequests`, `listBatches`, `batchDetail`, `listUsers`, `exportRows`), so it never holds more than the
    reader's scope.
  - The users export needs `usr` + the administrator role + `exp` and contains only full name, username, role,
    status, 2FA on/off, scope summary, last login and email (never password hashes, recovery codes, sessions, IPs,
    user agents, failed attempts or lock times); log exports keep the admin-only security logs, the scope filter
    and the IP / device removal.
- Every export writes a strict audit row (`action=export`, `entity=<report key>`, `entity_id`,
  `new_value={format, rows, truncated, filters, lang, target}`) before the file is sent; no row, no file
  (ETS-SEC-049).
- Strings in the sheets are plain values (never formulas), neutralised with the CSV rule (ETS-SEC-059,
  `neutralise()` from `utils/csv.js`); characters XML cannot carry are dropped.

### Upgrade notes
- Users who export logs as CSV now need `exp` as well as `log`.
- New backend dependency (`exceljs`): installed by `update.sh`.

---

## [1.2.0] — 2026-10-18 — Application progress as an equation of rings

### Added
- **Frontend:** the application page header shows the application % as a **visible weighted equation**
  (owner-approved design "B") (`frontend/src/components/PctEquation.jsx`, `frontend/src/pages/Application.jsx`,
  `frontend/src/styles/app.css`):
  - two small input rings — functions % and reports % — whose connectors carry «× share = contribution» (e.g.
    «× 85% = 14.7%», «× 15% = 0.0%»), then «=» and one large result ring with the application %;
  - every number comes from the API (`application.calc` and `settings.reports_share`): reports count only when
    `calc.reportPct != null` and `reports_share > 0` (same rule as `services/calc.js`), the functions share is
    `1 − reports_share`, the result ring shows `calc.pct`;
  - base (requirements) departments / no reports: one connector «× 100%» and the note «قسم متطلبات: التقارير لا
    تدخل في نسبة التطبيق»;
  - the formula line (`app_pct_note`) stays, small and muted, beside the pills row (weight, functions, passed in
    green, failed in red); phone: the equation stacks with no horizontal scroll at 390 px; RTL and LTR.
- **Frontend:** **continuous criticality colour** for the three rings — `pctTone(v) → {stroke, text, bg}` in
  `frontend/src/lib/format.js`:
  - OKLCH hue interpolated without steps from 25° (red, ≤ 20 %) via 55° (orange, 40 %) and 85° (amber, 60 %) to
    145° (green, ≥ 80 %), fixed lightness per role (stroke L 0.635, text L 0.47, bg L 0.955), chroma reduced to fit
    sRGB;
  - ring strokes ≥ 3:1 on white, the result number uses the darkened `text` tone (≥ 6.4:1, WCAG AA), input numbers
    stay in the normal text colour, the track uses the pale `bg` tint;
  - `pctHue()` and `pctGradient()` helpers; a gradient legend (0 % «حرج / Critical» … «متوسط / Fair» … «جيد / Good»
    100 %), right-to-left in Arabic. The discrete `pctColor()` used elsewhere is unchanged.
- **Frontend:** the **progress header stays visible** while the functions table scrolls (owner request):
  - the equation card is `position: sticky` under the top bar (`--navbar-h`) on a page-coloured band; once stuck it
    gets a shadow and a compact layout (smaller rings, legend and formula line hidden, pills kept);
  - the page title, breadcrumb and the «تعيين جماعي» / «إضافة وظيفة» buttons scroll away with the page;
  - only on screens ≥ 900 px wide **and** ≥ 500 px high; the compact look switches on only when the page is long
    enough to stay scrolled after shrinking (no flicker on short lists).
- **Frontend:** the **functions table is paginated** (`frontend/src/pages/Application.jsx`,
  `frontend/src/styles/app.css`, new icons `chevron_back`, `chevrons`, `chevrons_back` in
  `frontend/src/components/Icon.jsx`):
  - 10 rows per page by default, «صفوف في الصفحة» 5 / 10 / 15 / 20 / 25 (remembered per browser in `localStorage`
    `ets.fnPageSize`), first / previous / next / last buttons (mirrored in Arabic: «التالي» points left), «صفحة X
    من Y» and «عرض a–b من N»;
  - pagination applies after the filters (search, source, test status, disabled / removed items); any filter
    change goes back to page 1; the «33 / 40» counter is unchanged;
  - saving a cell, a note or a toggle **keeps the current page** (clamped if the list got shorter); changing the
    page size keeps the first visible row on screen; a page change from the bottom pager brings the top of the
    table back under the sticky header; an empty result shows «لا توجد وظائف تطابق التصفية»;
  - no row-selection column (the ✓ column is the per-function «included in the calculation» toggle) and no column
    sorting, so nothing else changes. Only the application page uses this table.
- **Frontend:** new messages `app_progress`, `eq_no_reports`, `eq_critical`, `eq_fair`, `eq_good`,
  `rows_per_page`, `showing_range`, `first_page`, `last_page`, `previous_page`, `next_page`, `fn_no_matches`
  (ar + en).

### Changed
- **Docs:** User Guide (AR) §5 describes the new header; STRUCTURE.md; version 1.2.0.

### Removed
- **Frontend:** the old horizontal progress bar and stats grid of the application header.

### Fixed
- **Frontend:** the sticky header now also sticks on short desktop windows (≥ 900 px wide, ≥ 500 px high, was
  700 px — e.g. 1646 × 566); its stuck look is one line (equation | pills, ~116 px visible) so the table keeps
  room; the weight chips hide in that line below 1200 px wide (`STICKY_MQ` and the `.app-sticky` media rule kept in
  sync).
- **Frontend:** pager arrows are chosen by direction, and the range is shown in an LTR span (from git, `5d53272`).

---

## [1.1.1] — 2026-10-16 — Bulk import: dropdown lists and names

### Added
- **Frontend:** the Excel template has **drop-down lists** built from the live roles, departments and applications
  (`GET /users/meta`):
  - Excel data validation of type *list* on `role`, `language`, `departments`, `department_2`, `department_3`,
    `applications`, `application_2`, `application_3` for rows 2–501, pointing to ranges on a hidden `lists` sheet
    (no 255-character inline-list limit, safe with Arabic and commas);
  - names in the interface language («عضو فريق», «العربية», «إدارة الموارد البشرية والخدمات», «شؤون العاملين» /
    English); an input message on every list column and a *warning* (not stop) alert, so several comma-separated
    values can still be typed;
  - frozen header `id / readable name` (e.g. `role / الدور`), column widths, right-to-left sheet in Arabic; the
    `help` sheet is kept. New optional columns `department_2/3`, `application_2/3`; files from 1.1.0 (ids, seven
    columns) are read as before.
- **Frontend:** the import preview shows what will be created in names (role, language, departments,
  applications) and quotes the unrecognised value in each message, e.g. «الدور غير موجود: مدير قسم», «الإدارة غير
  موجودة: …»; the error report carries the same messages and the new columns.
- **Backend:** `POST /api/users/import[/preview]` answers per error row `details: [{code, field, value, matches?}]`
  — the value that was not recognised (the administrator's own text, shortened, and catalog ids only).
- **Frontend (dependency):** `exceljs` 4.4.0, used only to write the template and loaded on demand (own chunk, not
  in the main bundle; works under the production CSP — no `eval` / `new Function` on the paths used).
  `read-excel-file` (reading) and `write-excel-file` (error report, passwords file) stay.
- **Tests:** `users-import.test.js` — roles / languages / departments / applications by Arabic and English name with
  tatweel, hamza, taa-marbuta, diacritic and ؤ/ئ variants, `,` `،` `;` separators and the extra columns; unknown
  values named in `details`; `ambiguous_value` (and its resolution by id or «name (id)»); ids still work; the
  browser and server matching files are identical.

### Changed
- **Docs:** Administrator Guide §1 (drop-down lists, names accepted, several values, matching rules), API Reference
  (`details`, `ambiguous_value`, names), STRUCTURE.md; version 1.1.1.

### Fixed
- **Backend:** the bulk user import accepts **names as well as ids** (reported on the live server: a template filled
  in Arabic — «عضو فريق», «عربي», Arabic department / application names — failed on every row with «الدور غير
  موجود», «لغة غير مدعومة», «نطاق غير صالح») (`backend/src/utils/importMatch.js`, same file as
  `frontend/src/lib/importMatch.js`):
  - roles by id, `name_ar` or `name_en`; languages by `ar`/`en`, العربية, عربي, Arabic, الإنجليزية, انجليزي, إنجليزي,
    English; departments by id, name or short name; applications by id or name;
  - matching ignores case, extra spaces, tatweel, diacritics, أ/إ/آ vs ا, ؤ/ئ, ى/ي and ة/ه; `,` `،` `;` separate
    several values, and a name that itself contains a comma is still recognised;
  - an exact id wins; a name fitting several items is refused with the new row code `ambiguous_value` (ar + en);
    the server stays authoritative; existing error codes and the all-or-nothing behaviour are unchanged.

### Security
- **Frontend:** `overrides.uuid ^11.1.1` for exceljs' `uuid` (GHSA-w5hq-g745-h8pq); `npm audit --omit=dev`: 0
  vulnerabilities.

---

## [1.1.0] — 2026-10-15 — Bulk user import

### Added
- **Backend:** bulk user import for System Administrators:
  - `POST /api/users/import/preview` checks every row (up to 500) without writing and answers per row `ok` or error
    codes (`username_taken` case-insensitive, `duplicate_in_file`, `invalid_username`, `full_name_required`,
    `invalid_email`, `invalid_role`, `invalid_language`, `invalid_scope`, `scope_required`, `usr_admin_only` …);
  - `POST /api/users/import` checks again and creates every row in one transaction or nothing
    (`400 import_has_errors`, also on a username taken meanwhile); more than 500 rows → `400 too_many_rows`.
- **Backend:** each imported account gets a random temporary password (`crypto.randomBytes`, 16+ letters and digits
  without look-alikes, passes the password policy incl. 12+ for administrators) and must change it at first
  sign-in; the passwords are returned once in the import answer only — never stored in clear, never logged; the
  bcrypt hashes are computed in short-lived worker threads before the transaction opens.
- **Backend:** audit — one `create` / `user` row per imported user (same values as a single create, no password,
  `context.via = "bulk_import"`) and one `bulk_create` / `user` summary row `{count, usernames}`, all in the import
  transaction.
- **Frontend:** Users → «استيراد مستخدمين / Import users»:
  - template download (.xlsx with a «help» sheet listing the columns and every role / department / application id
    in Arabic and English, or .csv);
  - file read in the browser (.xlsx via `read-excel-file`, .csv parsed in-house: UTF-8 BOM, quotes, commas and line
    breaks in quotes, CRLF, `;` separator);
  - preview with per-row status and messages, error report (.xlsx / .csv, formula-safe), "Create N users" only
    when no row has an error;
  - result screen with the one-time passwords (copy, download .xlsx / .csv, warning before closing without saving
    them).
- **Frontend:** readable change-history sentences for `bulk_create` and for users created by an import (ar + en).
- **Frontend (dependencies):** `read-excel-file` 9.3.10 and `write-excel-file` 4.1.1 (loaded on demand, not in the
  main bundle); `npm audit --omit=dev`: 0 vulnerabilities.
- **Tests:** `backend/test/users-import.test.js` — every row error code, size limits, admin-only, all-or-nothing
  (also on a unique-key failure inside the transaction), passwords returned once / policy / forced change /
  sign-in, audit rows without passwords, no password in any log.

### Changed
- **Backend:** the two import routes accept up to 1 MB of JSON, parsed only after the administrator check
  (`middleware/body.js`); every other request keeps the 100 kB limit.
- **Docs:** Administrator Guide §1 «Import users from a file», API Reference (two endpoints, 1 MB limit),
  STRUCTURE.md, Logging and Audit (`bulk_create`); version 1.1.0.

### Upgrade notes
- **nginx:** accepts up to 1 MB and waits up to 300 s on `/api/users/import[/preview]` — run `update.sh` to
  re-render the snippet.

---

## [1.0.0] — 2026-10-15 — Security remediation

The security remediation release: authentication (WP1), authorisation and data scope (WP2, WP4), input handling
(WP3), deployment hardening and supply chain (WP5, WP8), audit trail and logging (WP6), documentation accuracy
(WP7) and the Phase 7 verification leftovers (R8).

### Added
- **Backend:** `npm run verify-audit` and `GET /api/logs/integrity` (admins) verify the audit hash chains; the daily
  purge verifies first and writes the chain heads to the journal (ETS-SEC-013).
- **Backend:** `APP_SECRET_OLD` + `npm run rotate-app-secret` (`scripts/rotate-app-secret.js`) rotate the secret
  without losing 2FA enrolments (ETS-SEC-032).
- **Deployment:** `/usr/local/sbin/ets-log-protect` (`deploy/scripts/log-protect.sh`: `apply`, `migrate`,
  `restore`, `status`) applies the audit-trail protection automatically (see Security) (ETS-SEC-013).
- **Deployment:** `.github/dependabot.yml` (npm backend + frontend, GitHub Actions; weekly, 7-day cooldown);
  `npm audit --omit=dev` runs at every install/update (ETS-SEC-046, ETS-SEC-071).
- **Frontend:** Logs → «Verify log integrity» button and failed-log-write counter; Settings → separate audit
  retention field (min 365); ar + en texts (ETS-SEC-047, ETS-SEC-048, ETS-SEC-013).
- **Tests:**
  - `backend/test/input.test.js` (input handling; adapted to masked unknown usernames);
  - `backend/test/authz.test.js` — regression tests for P3-AUTHZ-01…10 and ETS-SEC-058;
  - `auth-security.test.js` (lockout, decay, enumeration, rate limits, session rotation, step-up, replay races,
    recovery codes, CLI) and `passwords.test.js` (policy, recovery codes, cookie name, API limiter);
  - `config.test.js` (APP_SECRET placeholders, DB TLS options per sslmode, remote-without-TLS refused, v2 envelope,
    tag length, AAD, v1 compatibility, rotation) and `rotate.test.js` (rotate-app-secret on a database);
  - `audit-log.test.js` (append-only, chain verification and tamper detection, purge floors and anchors, injected
    log-write failures, new events incl. CLI, masking, requester IP, admin-only logs, flood limits);
  - public `/api/health` returns no version (ETS-SEC-038); the first-note race repeated 10 times (ETS-SEC-056).

### Changed
- **Backend:** lockout is now a progressive pause per account (1, 2, 4 … minutes from `MAX_FAILED_LOGINS`, at most
  `LOCK_MINUTES`) that ends by itself; the counter restarts after `LOCKOUT_RESET_MINUTES` (60) without failures, so
  one wrong attempt after a lock no longer locks again for the full time (ETS-SEC-002).
- **Backend:** password policy — never below 10 characters, 12 for administrators (also in `create-admin`, which
  now uses the Settings minimum), at most 72 bytes, built-in list of common passwords; `BCRYPT_ROUNDS` kept within
  10–14; hashes with another cost are re-hashed at the next sign-in (ETS-SEC-019, ETS-SEC-020). Settings → minimum
  password length now accepts 10–64.
- **Backend:** recovery codes have 12 characters (about 59 bits, no modulo bias) and are stored as HMAC-SHA-256
  with an HKDF key from `APP_SECRET`; older codes keep working, the profile page suggests generating new ones
  (ETS-SEC-030).
- **Backend:** audit trail retention is its own setting `logs.audit_retention_days`, at least 365 days (kept at the
  previous period when longer); every purge is recorded with its actor (`system` / `cli:<OS user>`) and row counts;
  a shorter retention is flagged (ETS-SEC-048).
- **Backend:** a broken audit/auth hash chain stops the retention purge — nothing is deleted, `purge_skipped`
  (alert) is recorded in the audit trail and system log, `npm run purge-logs` exits 2; an administrator continues
  with `npm run purge-logs -- --acknowledge-broken-chain`, recorded as `purge_acknowledge` with who and which
  tables (ETS-SEC-013, ETS-SEC-048, V5-O1).
- **Backend:** `POST /users/bulk-2fa` no longer exempts the caller: a list naming the caller is refused with
  `cannot_change_own_permissions`, `all: true` leaves the caller out; removing exemptions is unchanged. UI label
  «Exempt everyone else from 2FA» (ar + en) (ETS-SEC-004, V2-N1).
- **Backend:** an administrator cannot reset their own password with `POST /users/<self>/reset-password` (400
  `use_change_password`, ar + en message; the button is hidden on their own account) — `/auth/change-password` asks
  for the current password (V2-N5).
- **Deployment:** `update.sh` re-deploys the systemd unit, nginx site/snippets, logrotate, backup/restore commands
  and cron from `install.conf`, reads `PORT` from `ets.env`, and prints rollback instructions on failure
  (ETS-SEC-068); it stops the service and migrates before starting the new version.
- **Deployment:** `restore.sh` verifies checksum + decryption + archive before touching anything, takes a
  pre-restore backup, restores with `--single-transaction --exit-on-error` (extensions left to the DBA) and
  `--no-acl`, fails hard and restarts the service on error, passes the file name to SQL as a psql variable
  (ETS-SEC-041); `ets-restore` records the restore in the audit trail (ETS-SEC-013).
- **Deployment:** nightly backup logs to root-only `/var/log/ets-backup.log` (outside the ets-writable
  `/var/log/ets`), with its own logrotate entry (ETS-SEC-043).
- **Deployment:** `ets.env.bak-*` are root:root 600, only the 5 newest kept; `ets.env` written atomically; a warning
  before nginx's default site is disabled (ETS-SEC-064).
- **Docs:**
  - 02, 06 (new §6a secrets and APP_SECRET rotation), 07, 08 (encrypted backups, key escrow, restore), 09, 10,
    README, STRUCTURE for the deployment work;
  - Administrator guide, Security and API reference for the authorisation rules; review notes for imports (weights,
    full import) (ETS-SEC-057);
  - 07 (who sees what, new events, masking, transactional audit, integrity §3, protection, migrations, restores,
    remote DBA, undo, alerts, retention and personal data, §3/§5 purge), 08 §3 (restore of a protected database),
    06 (authorisation, audit trail, recommendations), 10 (ETS-SEC-013, ETS-SEC-047, ETS-SEC-048, ETS-SEC-049,
    ETS-SEC-050, ETS-SEC-051, ETS-SEC-052, ETS-SEC-074, ETS-SEC-075, ETS-SEC-077);
  - client IP behind a load balancer / reverse proxy / NAT: nginx `real_ip` for the balancer's addresses only, in
    `/etc/nginx/conf.d/ets-realip.conf` (survives updates), never `TRUST_PROXY=true`; the shared-IP effect on the
    rate limits; in-memory API counters reset on restart (02 §9, 06, 10, 12, `.env.example`; a pointer comment in
    `deploy/nginx/ets-https.conf.tpl`) (ETS-SEC-022);
  - consistency pass of the handover pack, README, STRUCTURE, `.env.example` and `answers.example` with the 1.0.0
    code: sign-in pause model (no "account locked" / 423), rate limits, cookie `__Host-ets_sid`, HTTPS only,
    database TLS, encrypted backups and key escrow, nine roles and 13 permissions, scope fail-closed, `usr` for
    administrators only, import two-person rule, security logs for administrators only, audit retention ≥ 365, hash
    chain and `verify-audit`, audit-trail protection, new settings / env variables (`LOCKOUT_RESET_MINUTES`,
    `API_RATE_LIMIT`, `ALLOW_INSECURE_COOKIES`, `APP_SECRET_OLD`, `PGSSL*`, `TRUST_PROXY`), new npm scripts,
    `/api/health` without version, Node.js 22.12+ / 24+; example passwords removed (ETS-SEC-076);
  - 05 Database Design describes migrations 007–009 and 012 (`last_failed_at`, recovery-code hash format, `usr`
    cleanup, hash-chain columns, `log_chain_head` / `log_chain_anchor`, chain functions and triggers,
    `ets_purge_log`, ownership by `ets_log_owner`, new retention setting); `deploy/db/schema-reference.sql`
    regenerated after migration 012 (ETS-SEC-076);
  - 09 Test plan: 90 automated tests; new UAT cases for the sign-in pause, password rules, rate limits, cookie,
    health, 2FA step-up and recovery-code format, `usr` admin-only, self-grant, scope fail-closed, application
    scope, last admin, admin-only logs, integrity check, audit retention, audit-trail protection, two-person import
    rule, restore, update and key escrow (ETS-SEC-076);
  - 10 Runbook: security operations (verify-audit, broken chain, ets-log-protect, purge, backup key, APP_SECRET
    rotation, create-admin) and sign-in pauses / unlocking; 12 Checklist: backup key escrow, audit-trail
    protection, user scopes, network path, and the NodeSource key fingerprint; 04 User guide (AR): https only,
    sign-in pause message, password rules (10 / 12 characters), 2FA changes need password + code, recovery code
    format `xxxx-xxxx-xxxx`, no-scope users, uploader cannot sign (ETS-SEC-076).
- Version 1.0.0 in `package.json` and `package-lock.json` (backend, frontend).

### Removed
- **Deployment:** plain-HTTP installation mode — `ETS_TLS=none` refused, previous plain-HTTP answers fall back to
  self-signed, `update.sh` refuses a plain-HTTP install with a clear message; `COOKIE_SECURE=true` always;
  `ets-http.conf.tpl` deleted (ETS-SEC-011).
- **Backend:** `423 account_locked` with the lock time — a paused account answers exactly like a wrong password or
  an unknown username (`401 invalid_credentials`, same bcrypt cost) (ETS-SEC-014).

### Fixed
- **Backend:** a duplicate permission in `overrides` is a 400 `invalid_permission` instead of a 500 (V2-N4).
- **Database:** migration 009 records the full override list before/after in its audit rows and does not repeat the
  `scope_fail_closed` warning when re-run; already-migrated databases are unaffected (applied by file name) (V2-N6).
- **Backend:** ids (int4), dates (real calendar days), log page/user/status filters, scope/override/id lists,
  `PUT /tracker/weights` without a body and malformed tracker import payloads give 400 instead of 500 and no longer
  fill the error log (ETS-SEC-029).
- **Backend:** `/2fa/verify` answers `400 mfa_not_pending` instead of 500 when 2FA was reset meanwhile
  (ETS-SEC-055).

### Security
- **Input handling (WP3):**
  - request bodies limited to 100 kB and 32 levels of nesting before the session is known; only the file uploads
    (`POST /api/imports`, `/api/imports/preview`, `/api/tracker/import`, `PUT /api/branding/:key`) accept up to
    5 MB, parsed only after login, CSRF and permission checks; non-JSON bodies get `415`; imported files refused when
    nested too deeply; nginx `client_max_body_size` 128k, 6m only on the upload routes (ETS-SEC-008);
  - allow-lists (settings, report/function fields, log types, `set-setting.js`) and the frontend icon lookup use own
    keys only, so `toString`, `constructor`, `__proto__` … are refused with 400 (ETS-SEC-028);
  - CSV export neutralises formulas also after leading whitespace/invisible characters, for `|` and the full-width
    `＝ ＋ － ＠`, and cells starting with tab/CR/LF (ETS-SEC-059);
  - frontend API paths built with encoded segments, address-bar ids checked before calling the API, pages show
    "not found" instead of crashing on an unexpected response (ETS-SEC-060);
  - bidirectional control characters (U+202A–202E, U+2066–2069, U+200E/200F) removed from every text value of a
    request body except passwords (ETS-SEC-061);
  - `extract-catalog.js` only runs the catalog block of the reviewed reference file (pinned SHA-256,
    `--trust-source` to override), in an empty `vm` context with a timeout (ETS-SEC-062);
  - branding uploads stored without metadata (EXIF/GPS, XMP, comments, PNG text chunks, WebP EXIF/XMP) and without
    bytes after the end of the image; broken images refused (ETS-SEC-070).
- **Authorisation and data scope (WP2, WP4):**
  - user management (`usr`) is for the System Administrator role only — a `usr` override on any other role is
    ignored and refused (`usr_admin_only`); all `/api/users` routes need the admin role; nobody can widen their own
    permissions, scope or 2FA exemption (`cannot_change_own_permissions`); only administrators create/promote
    administrators, reset an administrator's password/2FA or bulk-exempt 2FA (ETS-SEC-004);
  - scope fails closed — full scope comes from the role only (admin, PM, TM); a user of another role with no scope
    rows sees no data anywhere (tracker, export, logs, approvals, imports, `/auth/me` `fullScope:false`)
    (ETS-SEC-005);
  - last-administrator protection counts permission overrides (an active admin holding `usr` and `cfg` must remain)
    and locks the administrator rows, so concurrent demotions cannot remove every admin (ETS-SEC-023, race part of
    ETS-SEC-021);
  - `GET /api/tracker/export` returns only the applications in scope; the project schedule only for full-scope
    users (ETS-SEC-006);
  - application-level scope is no longer treated as department scope — edit-request visibility and approval,
    import preview/upload, import lead/final approval and rejection (every changed application must be in scope)
    and batch details (only in-scope changes and figures) (ETS-SEC-007); a reader who sees part of an import batch
    gets change count, counts, apply result and department figures from the visible changes only and no project
    figure; project-status pending counts include only requests / batches of applications in scope (ETS-SEC-007,
    V2-N2, V2-N3);
  - `PUT /api/tracker/schedule` needs a full-scope user (`can.sch` follows) (ETS-SEC-024);
  - import two-person rule — the uploader may sign neither approval stage; the final approver also needs every
    changed application in scope (ETS-SEC-025);
  - a new import file supersedes only waiting batches nobody has signed yet (own, or entirely within the uploader's
    scope) and never when it has no changes (ETS-SEC-026);
  - approving an edit request or the second signature of an import re-checks that the author is still active, in
    scope and holds the needed permissions (409 `requester_not_allowed`; *Approve all* leaves such requests pending
    and reports `blocked_requests`); deactivating a user withdraws their pending edit requests (ETS-SEC-027);
  - "note with a noted status" exception: only when the status really changes to it (or the function has no note),
    so a user without `tst` cannot overwrite notes; the two-step overwrite (status away and back with a new note)
    is refused and an approved request re-checks that the note is still empty; a note written through the exception
    is stored only if the function still has no note when the row is updated (409 `note_changed`), so a tester's
    note saved at the same moment cannot be overwritten (ETS-SEC-056, V6-N1);
  - `GET /api/settings` needs full scope; the impact preview ignores functions of other applications
    (ETS-SEC-058);
  - Users screen — *Manage users* cannot be granted to non-administrator roles, own permissions / scope / 2FA
    exemption cannot be widened, warning and «بلا نطاق» badge for users without scope, new error texts in Arabic and
    English (ETS-SEC-004, ETS-SEC-005).
- **Authentication (WP1):**
  - a correct password no longer resets the failure counter while 2FA is pending; it is cleared only by a complete
    sign-in, so wrong 2FA codes add up across logins (ETS-SEC-001);
  - every endpoint that checks a password, 2FA code or recovery code (login, 2FA verify / setup / enable / disable,
    recovery codes, change password) is limited per IP and per account (`429 too_many_attempts` with
    `retry_after`); wrong answers on the profile re-authentication count towards the pause and, at the limit, end
    the session; a general per-IP limit applies to every `/api` request (`API_RATE_LIMIT`, `429
    too_many_requests`); concurrent checks on one account run one after another (ETS-SEC-003, ETS-SEC-021);
  - nginx login limit covers all those endpoints, in any letter case and with a trailing slash, and answers 429
    (ETS-SEC-003);
  - completing 2FA issues a new session token and revokes the pre-2FA one; signing in again revokes the browser's
    previous session (ETS-SEC-015);
  - turning 2FA on from the profile needs the password; turning it off and generating new recovery codes need the
    password and an authenticator / recovery code (ETS-SEC-016);
  - `/auth/me` before 2FA returns only username, language and stage (ETS-SEC-017);
  - sessions are revoked on admin 2FA reset, self-service 2FA disable (other sessions) and `create-admin` from the
    command line (ETS-SEC-018);
  - TOTP replay check is a conditional update and a recovery code can only be used once, also under parallel
    requests (ETS-SEC-021);
  - with `COOKIE_SECURE=true` the session cookie is named `__Host-ets_sid`; cookies are cleared with the same
    options everywhere; a production server refuses to start with insecure cookies unless
    `ALLOW_INSECURE_COOKIES=true` (ETS-SEC-053);
  - the forced-password-change gate is an explicit middleware on the allowed endpoints instead of a URL prefix test
    (ETS-SEC-054).
- **Deployment hardening and supply chain (WP5, WP8):**
  - backups encrypted with gpg (AES-256, tamper-evident) using a separate root-only key `/etc/ets/backup.key`
    created by the installer/update, with a `.sha256` checksum, never overwritten, and no longer with `ets.env`
    (APP_SECRET, DB password) copied next to them; an old `ets.env.backup` is deleted and old plain dumps are
    encrypted at the next run; key escrow and restore documented in doc 08 (ETS-SEC-009);
  - remote PostgreSQL always over TLS — `PGSSLMODE` / `PGSSLROOTCERT` (libpq semantics: require / verify-ca /
    verify-full) in `config.js` + `db/pool.js` and for psql / pg_dump / pg_restore; default `require` for a
    non-local host and the app refuses to start with an unencrypted remote connection; the installer asks for the DB
    server's CA (→ verify-full) and checks the connection is encrypted (ETS-SEC-010);
  - the DB TLS guard also reads `DATABASE_URL` — its host (`?host=`, empty host → PGHOST, sockets) and its
    `sslmode` / `ssl` parameters (URL wins over PGSSLMODE; `ssl=true` = verify-full); a weaker mode to another
    machine is refused at start, and the pool gets the checked `ssl` options instead of the URL's TLS parameters, so
    an embedded `sslmode=disable` can no longer win (ETS-SEC-010, V4-N1);
  - self-signed certificate is an end-entity certificate (`basicConstraints=critical,CA:FALSE`, keyUsage
    digitalSignature/keyEncipherment, extendedKeyUsage serverAuth, SAN, RSA-3072, 825 days); an existing CA:TRUE
    certificate is replaced by install/update; docs no longer say to import it as a trusted root (ETS-SEC-012);
  - `APP_SECRET` placeholders (e.g. the old `.env.example` value), values under 32 characters or with fewer than 12
    different characters are refused at start; `.env.example` ships empty secrets (ETS-SEC-031);
  - 2FA secret envelope `v2:<key id>:iv:tag:ct` with an HKDF-SHA-256 key, 16-byte GCM tag enforced, optional AAD;
    `v1` still read (ETS-SEC-032, ETS-SEC-063 except AAD binding by callers);
  - the DB role password is never on a command line or in the server log: the installer sends a SCRAM-SHA-256
    verifier (`deploy/db/scram-verifier.mjs`) on stdin; `create-database.sql` no longer takes a password (DBAs use
    `\password`); psql gets `PGPASSWORD` only per call; `create-admin --password` warns that it is deprecated
    (ETS-SEC-033, ETS-SEC-065);
  - `answers.example` ships no usable passwords (admin `CHANGE-ME` is refused); example / common words refused for
    DB and admin passwords; admin password 12+ characters, max 72 bytes; an admin password from an answers file /
    environment variable gets `must_change_password` (`create-admin --must-change-password`) (ETS-SEC-034);
  - nginx sends CSP (mirrors helmet), X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS, Permissions-Policy,
    COOP/CORP on the SPA and assets via `snippets/ets-headers.conf`, included in every location that has its own
    `add_header` (fixes the add_header inheritance gap) (ETS-SEC-035);
  - systemd sandboxing extended (CapabilityBoundingSet=, PrivateDevices, ProtectKernelLogs/Clock/Hostname,
    ProtectProc=invisible, RestrictNamespaces/Realtime/AddressFamilies, SystemCallFilter=@system-service,
    SystemCallArchitectures=native, UMask=0027, RemoveIPC, IPAddressAllow=localhost [+ remote DB IP] /
    IPAddressDeny=any); offline `systemd-analyze security` exposure 7.4 → 1.4 (ETS-SEC-036);
  - legacy-import temp copy in a `mktemp -d` directory, mode 640 root:ets, removed afterwards (ETS-SEC-037);
  - `server_tokens off`; public `/api/health` no longer returns the version (ETS-SEC-038);
  - TLS: Mozilla intermediate ECDHE+AEAD ciphers, `ssl_prefer_server_ciphers off`, session tickets off, shared
    session cache 1 d (ETS-SEC-039);
  - `REVOKE ALL ON DATABASE … FROM PUBLIC`, `GRANT CONNECT, TEMPORARY` to the app role, `REVOKE CREATE ON SCHEMA
    public FROM PUBLIC` (create-database.sql and every local install run) (ETS-SEC-040);
  - only runtime files are copied to `/opt/ets` (allow-list: backend src/scripts/package files, frontend sources for
    the build, deploy runtime files — no docs, tests, reference data, examples); code root-owned, backend
    `root:ets 750`, only `frontend/dist` world-readable (ETS-SEC-042);
  - no `curl | bash`: NodeSource apt repo with a fingerprint-pinned signing key and `signed-by`; npm ci and the Vite
    build run as the unprivileged `ets-build` user with `--ignore-scripts`, in a staging copy; answers files and
    `install.conf` are parsed as KEY=value data, never sourced (nothing exported); PGPASSWORD scoped to individual
    psql calls (ETS-SEC-044, ETS-SEC-067);
  - Node.js `engines` `^22.12.0 || >=24` with `engine-strict`; the installer upgrades any other version,
    `update.sh` refuses one (ETS-SEC-045);
  - existing-certificate mode warns when the private key is readable by others (ETS-SEC-066);
  - local PostgreSQL: warning when `listen_addresses` is not local-only or pg_hba has trust/password/md5 network
    rules (ETS-SEC-069).
- **Audit trail, logging and privacy (WP6):**
  - `audit_log` and `auth_log` are append-only (triggers refuse UPDATE, DELETE, TRUNCATE except the retention purge
    and the user_id → NULL of a deleted user) and hash-chained (`chain_seq`, `prev_hash`, `row_hash`, computed by
    the database; existing rows chained in id order); `log_chain_head`, `log_chain_anchor`; purge only through
    `ets_purge_log()` (oldest rows first, never younger than 365 / 30 days) (ETS-SEC-013, ETS-SEC-048);
  - audit-trail protection (`deploy/db/harden-log-tables.sql`: log tables, chain functions and schema `public`
    owned by the NOLOGIN role `ets_log_owner`; the application role may only read and append) applied automatically
    on every install and update of a local database, as the PostgreSQL superuser, by `ets-log-protect`. Migrations
    and restores run as the application role inside one superuser transaction in which the log objects are lent to
    it and protected again before COMMIT, so later migrations that change the log tables and restores keep
    working; `ets-restore` refuses (before changing anything) a protected database it
    cannot restore. The script is idempotent, checks inside its transaction that the application role can no longer
    change the logs, grants SELECT on the log sequences (needed by `ets-backup`), and is a no-op before migration
    012 (ETS-SEC-013);
  - audit rows are strict (a failed write fails the request); unlock, bulk 2FA exemption, branding, language,
    password change, 2FA setup/enable/disable, recovery codes, session revocation, admin resets and the 2FA policy
    change write their audit / auth_log rows in the same transaction; tracker and log exports are refused without
    their audit row; a sign-in creates no session without its `login` row; soft writes (failed sign-ins, denials,
    logout, reads) are counted and reported with `alert:true` (ETS-SEC-049);
  - new events `password_change_rejected`, `mfa_verify_while_locked`, `reauth_while_locked`, `session_expired`,
    `session_revoked_reuse`, `csrf_rejected`, `password_change_required`, `admin_created_cli`, `mfa_reset_cli`;
    audit rows for viewing a user record / security log, CLI `set-setting` and `create-admin` (as `cli:<OS user>`),
    session revocation (ETS-SEC-050);
  - an unknown username (and the name sent with a rate-limited request) is stored masked (`?x***#<HMAC>`), never as
    typed — DB, files, journal, export (ETS-SEC-051);
  - changes applied on approval carry the requester's own IP; the approver's IP is in `context.approver_ip`
    (ETS-SEC-052);
  - security logs (auth, access, error, system), log statistics and IPs / user agents for administrators only;
    others with `log` get the audit trail with IPs removed server-side, also in CSV; Logs shows the security tabs
    and statistics to administrators only (ETS-SEC-047);
  - only the first rate-limited sign-in of a window (then every 10^n) is written to auth_log; anonymous 404 / 429
    are not stored in access_log; user agent and paths capped at 300 characters (ETS-SEC-077);
  - high-value events are written with `alert:true` for forwarding / SIEM rules (ETS-SEC-075).

### Upgrade notes
- **Migrations** (applied by `update.sh`):
  - `008_auth_lockout.sql` — `users.last_failed_at` (time of the last failed check, for the lockout decay); comment
    on the recovery-code hash formats; no data changed;
  - `009_usr_admin_only.sql` — removes `usr` overrides held by non-administrators (each removal recorded in the
    audit trail) and lists in the system log (`scope_fail_closed`, warning) the active users of a scoped role
    without any scope (ETS-SEC-004, ETS-SEC-005);
  - `012_audit_integrity.sql` — append-only, hash-chained `audit_log` / `auth_log`, new setting
    `logs.audit_retention_days` (ETS-SEC-013, ETS-SEC-048).
- **Scope fails closed:** users of a scoped role with no scope saw everything before 1.0.0 and now see nothing until
  a department/application is ticked for them in *Users* (shown as «بلا نطاق / No scope»); nothing is granted
  automatically — see 03-Administrator-Guide §1 and the system-log event `scope_fail_closed`.
- **Everyone signs in again once** after the upgrade (new cookie name `__Host-ets_sid`).
- **Backups** are now `.dump.gpg`; the new key `/etc/ets/backup.key` must be escrowed (the update prints a
  reminder). PM / TM / managers no longer see the security logs. Check `sudo ets-log-protect status` → protected.
- **HTTPS only:** `update.sh` refuses an installation still configured for plain HTTP (run `deploy/install.sh` once
  and choose a certificate) and a Node.js older than 22.12; it adds `PGSSLMODE=require` to an existing remote
  install (ETS-SEC-010).
- **Remote database:** migrations run as the application role (all-or-nothing, clear DBA instructions on failure);
  the DBA applies the audit-trail protection with `ETS_SU_CONNINFO=… ets-log-protect apply` or psql;
  `deploy/db/harden-log-tables.sql` can also be run once by the DBA to give the log tables to a separate owner role
  (ETS-SEC-013).
- **Before the first install:** verify the NodeSource key fingerprint against NodeSource's published key (12
  Checklist).

---

## [0.9.0] — 2026-10-15 — Readable audit trail: clear sentences with previous and new values

### Added
- **Backend:** an approved edit request or import writes one `update` audit row per function / report / application
  weight with its old and new values, in the name of the employee who entered it, with the approvers in `context`
  (before, only "N applied" was recorded and the item history did not show the change).
- **Backend:** edit request, approval, rejection, withdrawal and every import step record their items (code, name,
  field, old → new, applied); a bulk set records each changed function's previous value.
- **Backend:** `GET /api/logs/audit` returns the person's full name, function code / name and application name;
  search also matches them. Department-scoped users also see the edit requests of their applications.
- **Frontend:** Logs → audit trail shows each row as a plain sentence (Arabic / English), e.g. «تعديل نسبة الإنجاز
  للوظيفة «D0 …» في تطبيق المبيعات: من 70% إلى 75%», with action type, the approver and request number, and reasons;
  the details window has a field / previous value / new value table and the list of items affected. Statuses,
  percentages and settings are shown by name.
- **Tests:** default language applies to `public-info` and to a new user created without a language.

### Changed
- **Frontend, Backend:** Settings → default language now takes effect: it is the language of the login screen and
  interface for a browser with no stored choice (from `GET /api/auth/public-info`; the language button, profile and
  the account's language after sign-in still win), and of new users created without a language
  (`POST /api/users`, the new-user form's «default language» option, and `npm run create-admin` for a new account).

### Removed
- **Backend (dead code):** unused imports (`query` in settings routes, `HttpError` in users routes), unread
  `config.isProd` / `config.appName`, the identity `publicUser` mapper, a redundant `'weight'` in the import field
  allow-list, and `export` on symbols used only in their own module.
- **Frontend (dead code):** unused `NOTIF_COLORS` / `REVIEW_COLORS`, `chart` / `key` icons, unused props
  (`ProgressBar` `color`, `Icon` `stroke`, `PasswordForm` `onDone`), unused parameters in `paceFrom` and the audit
  `diff`, unread `scheduleModel` fields, 23 unused translation keys, and duplicate / unused CSS rules (`.text-green`
  / `.text-red` → `.green-text` / `.red-text`, `.indicator-pill.yellow`, `--green`).

### Fixed
- **Backend:** changes applied from an approved edit request were logged without a username.
- **Backend:** saving weights no longer logs an unchanged application weight.
- **Frontend:** a pending removal / restore of a function no longer shows «removed [object Object]» in the
  function's "awaiting approval" chip; those requests are listed only in the lifecycle box above the table.
- **Frontend:** 21 API error codes had no message and showed the generic error (`csrf_rejected`,
  `not_authenticated`, `mfa_*`, `full_name_required`, `invalid_email` / `_language` / `_permission` / `_role` /
  `_scope` / `_date` / `_json`, `unknown_setting` / `_field` / `_application` / `_log`, `no_reports_track`,
  `payload_too_large`); Arabic and English texts added.
- **Frontend:** the dialog close button's accessible name is translated (was the English word "close").
- **Docs:** `deploy/db/schema-reference.sql` regenerated after migrations 001–007 (adds `audit_log.context`).

### Security
- **Backend:** the dummy hash checked for unknown usernames at login used bcrypt cost 4 while real hashes use
  `BCRYPT_ROUNDS` (12), so unknown usernames answered faster (username enumeration). It now uses the configured
  cost, built once at startup.

### Upgrade notes
- **Migration `007_audit_context.sql`:** `audit_log.context` (jsonb) — how a change came in (direct, edit request,
  import), who requested and who approved it, and the items involved with their before → after values.

---

## [0.8.1] — 2026-10-14 — Functions catalog document

### Added
- **Docs:** `docs/handover/13-Functions-Catalog.xlsx` — all 513 catalog functions by module (department) and
  application (code, name, source, reference, declared vendor status, counted by default) with a summary sheet
  (formulas). Review: the catalog re-extracted from `reference/erp-tracker-original.html` is identical to
  `catalog.json`; no duplicate codes, no empty names, every function linked to a valid application.

---

## [0.8.0] — 2026-10-14 — Add, remove and restore functions in any application

### Added
- **Backend:** `POST /api/tracker/applications/:id/functions` (name AR/EN, reference, weight, progress, included or
  not), `POST /api/tracker/functions/:id/remove` (reason required, any source incl. scope functions),
  `POST /api/tracker/functions/:id/restore`, and `POST /api/tracker/applications/:id/impact` (application,
  department and project % before → after for a proposed addition / removal / include / exclude).
- **Backend:** additions, removals and restores by data-entry users wait for the department team lead (same rule as
  their other edits); approval creates / removes / restores with the requester as author.
- **Frontend:** «إضافة وظيفة» dialog with live impact; «إزالة» on every function with reason and impact; include /
  exclude (✓) now asks for confirmation with the impact; «عرض المُزالة» lists removed functions with who / when /
  why and «استعادة»; pending additions / removals shown on the application; the approvals page shows them.
- **Tests:** add (included / excluded), impact preview, member request → lead approval, remove a scope function
  (reason, exclusion from counts, PATCH refused, seed / export / import do not bring it back), restore, code
  numbering, scope.

### Changed
- **Backend:** team members get permission `tog` (include / exclude, add, remove) — all of it through the team
  lead's approval.
- **Backend:** removal is now a soft removal for every function (the old hard delete of added requirements is
  replaced). Removed functions are excluded from calculations, summaries, project status, snapshots, search, the
  JSON export, full imports and team result files.

### Fixed
- **Backend:** a new added function could get the code of an earlier one after a deletion (codes were `C` + count →
  unique-key error); codes are now `C` + (highest + 1) and never reused.
- **Backend:** adding / deleting requirements bypassed the team lead's approval for data-entry users.
- **Docs:** `pg_dump` restrict markers removed from `deploy/db/schema-reference.sql` (from git, `dcccd0a`).

### Upgrade notes
- **Migration `006_function_lifecycle.sql`:** `functions.removed_at / removed_by / removed_reason / created_at /
  created_by`; edit request kinds `add_function`, `remove_function`, `restore_function`.

---

## [0.7.0] — 2026-10-13 — Project timeline and project status page

### Added
- **Backend:** `PUT /api/tracker/timeline` (permission `cfg`, full scope) — project start and close date. With a
  close date the number of curve periods is derived from start → close (the last period ends on the close date);
  close before start, a missing start or more than 60 periods are refused. The curve page keeps the dates and
  period count from Settings.
- **Backend:** hourly progress snapshot (`services/snapshots.js`), latest value of the day kept.
- **Backend:** `GET /api/tracker/project-status` — schedule, total and department progress, function states, test /
  notification / review / reports counts, pending approvals and the daily trend, for the user's scope (a scoped
  user's trend is the weighted average of their departments).
- **Frontend:** Settings → «الجدول الزمني للمشروع» card (start, close date, duration and derived periods).
- **Frontend:** new page «حالة المشروع» (sidebar → Tracking), calculations in `lib/health.js`:
  - status badge (on track / at risk / delayed / past close date / completed), time elapsed vs work done,
    planned-to-date, deviation, **schedule delay in days** (earned schedule), SPI and SPI(t);
  - current and required pace per month, **forecast close date** and its variance, forecast by SPI(t), days
    remaining, S-curve with the daily trend, departments vs plan (gap and 30-day change), quality & readiness;
  - automatic recommendations (delay, forecast, required pace, stalled progress, lagging departments, functions not
    started, failed / untested functions, notifications, reviews, open notes, pending approvals).
- **Frontend:** the dashboard curve card shows the project status and its headline, forecast and close date.
- **Tests:** timeline validation, derived periods (months and fortnights), schedule screen cannot move the dates,
  permissions, snapshot and project-status payload, scoped user.

### Changed
- **Docs:** `deploy/db/schema-reference.sql` regenerated with all migrations (001–005); handover docs updated
  (administrator guide, user guide, database design, API reference, test plan C-13d…f).

### Fixed
- **Backend:** PostgreSQL `date` values are now returned as stored (`YYYY-MM-DD`); before, on a server east of UTC
  the schedule start date could come back one day earlier.
- **Frontend:** two-column and card grids no longer overflow on phones.

### Upgrade notes
- **Migration `005_project_timeline.sql`:** `schedule.end_date` (planned close date) and table `progress_snapshots`
  (one row per day: project %, functions, completed, tested, notes, % per department).

---

## [0.6.1] — 2026-10-13 — S-curve verified, redesigned and added to the dashboard

### Added
- **Frontend:** the dashboard shows a «منحنى الإنجاز التراكمي» card (4 KPIs + chart) with a link to the curve page.

### Changed
- **Frontend:** new shared component `components/SCurve.jsx` (model + chart + KPI cards) used by the schedule page
  and the dashboard. Redesign: planned = dashed orange line, actual = solid blue line with a light area, period
  markers, a «today» line with planned-now and actual-now points and the current value labelled, legend above the
  chart, date labels on the time axis, crosshair + tooltip on hover (planned, actual, deviation per period), solid
  hairline gridlines, drawn at the container's real width so text stays readable on phones. Colour pair
  (#2a78d6 / #eb6834) validated for colour-blind separation and contrast.

### Fixed
- **Frontend:** the curve did not start at the origin (0 % at the start date); it now does for both planned and
  actual.
- **Frontend:** the current computed progress was not plotted; it now appears as the «اليوم / Today» point at the
  exact position of today's date between periods.
- **Frontend:** deviation and SPI compared the plan with the last manually recorded actual value (and showed «—»
  when none was recorded). They now compare the current computed progress with the plan interpolated at today's
  date: deviation = actual − planned (percentage points), SPI = actual ÷ planned.
- **Frontend:** month periods overflowed on short months (31 Jan + 1 month gave 3 Mar); the day is now clamped to
  the month's length.
- **Frontend:** on phones the top bar (large logo + search) was wider than the screen and the page could be shifted
  sideways; the logo and search now shrink and horizontal overflow is hidden.

---

## [0.6.0] — 2026-10-13 — Data-entry edits approved by the department team lead

### Added
- **Backend:** when a user who is not an approver of the department (team member, editor, tester…) changes a
  function, runs a bulk set or edits a report, the change is stored as an edit request (HTTP 202 `pending`) and the
  approved value stays unchanged.
  - Only a team lead of that department (`apv_dept`, scope covering it) can approve or reject — the project /
    technical manager is not required at this stage. Team leads, project / technical managers and system
    administrators apply their own edits directly.
  - Editing the same value again replaces the earlier pending value. On approval the change is applied with the
    requester as author; a value changed meanwhile by someone else is skipped.
  - Every step is audited (`edit_request`, `edit_approve`, `edit_reject`, `edit_withdraw`).
- **Backend:** `/api/approvals` — list (approvers: their departments; everyone: own requests), pending count,
  approve, reject (reason required), withdraw (requester), approve all.
- **Frontend:** «اعتماد التعديلات» page with before/after values per request, approve / reject / withdraw / approve
  all; red badge in the sidebar and a dashboard notice for the team lead; on the application and reports pages a
  «بانتظار الاعتماد» chip shows the proposed value and a notice tells data-entry users their edits go for approval;
  Settings → «الاعتمادات» switch to turn the rule on/off.
- **Tests:** API test of the whole cycle (27 tests).

### Upgrade notes
- **Migration `004_edit_requests.sql`:** tables `edit_requests`, `edit_request_items`; setting
  `approval.edits_need_lead` (default on).

---

## [0.5.2] — 2026-10-13 — Logo inside the login box

### Changed
- **Frontend:** the logo and system name now sit at the top of the sign-in box, above «تسجيل الدخول» and the
  username/password fields, separated by a thin line (also on the 2FA and password-change screens). The logo size
  slider for the login screen still applies.

---

## [0.5.1] — 2026-10-13 — Adjustable logo size

### Added
- **Frontend, Backend:** Settings → «الهوية البصرية» — two sliders: logo height in the top bar (20–80 px, default 28)
  and on the login screen (40–200 px, default 64). The change is shown live while dragging and saved when released
  (settings `app.logo_height`, `app.login_logo_height`). The top bar grows with the logo.

### Fixed
- **Frontend:** the logo was forced into a square, so wide logos looked tiny — it now keeps its proportions (height
  set, width automatic).
- **Frontend:** the main Save button of the Settings page no longer overwrites the logo sizes set by the sliders.

---

## [0.5.0] — 2026-10-13 — Branding: system logo, favicon, login background

### Added
- **Backend:** `/api/branding/:key` (`logo`, `favicon`, `login_bg`) — public GET with caching; upload (PUT, data
  URL) and reset (DELETE) need the `cfg` permission. Only PNG, JPEG, WebP and ICO are accepted, recognised by their
  content; SVG is refused (it can carry scripts). Limits: logo 1 MB, favicon 512 KB, background 3 MB. Uploads and
  resets are audited. `public-info` and `me` return the branding versions.
- **Frontend:** Settings → «الهوية البصرية» with preview, upload and "restore default" for each image. The logo
  replaces the icon in the top bar and on the login screen; the favicon (or the logo if no favicon) is the browser
  tab icon; the login screen shows the background picture with a dark overlay so the form stays readable.
- **Tests:** branding API test (26 tests).

### Fixed
- **Frontend:** error messages with values (e.g. maximum size) now show the value.

### Upgrade notes
- **Migration `003_branding.sql`:** table `branding_assets` (images stored in the database, so they are included in
  backups and survive updates).

---

## [0.4.0] — 2026-10-13 — Team result files: per-department import with two approvals; project roles

### Added
- **Backend:** `/api/imports` — a team's JSON (or HTML) file from the original tracker is read and the uploader
  **must choose** what to import: one department (its functions and application weights) or **التقارير** (the
  reports of the departments in the uploader's scope). Everything else in the file is ignored.
  - The differences with the approved data are stored as a pending batch with their effect on the department and
    project percentages; nothing changes until the batch is approved by the department team lead **and** the
    project or technical manager — two different people, any order.
  - Then the changes are applied in one transaction (a value changed meanwhile is skipped and reported). Either
    approver can reject with a reason. A newer file for the same choice replaces the batch still waiting. Every
    step is audited.
- **Backend:** roles `pm` (مدير المشروع), `tm` (المدير الفني للمشروع), `lead` (رئيس فريق إدارة), `member` (عضو فريق);
  permissions `apv_dept` (team lead approval) and `apv_final` (project / technical manager approval).
- **Frontend:** «الاستيراد والاعتماد» page (list, import window with the mandatory department/reports choice showing
  the number of changes and the effect of each option, batch page with before/after values per function, impact,
  signatures, approve/reject); red badge in the sidebar with batches awaiting the user's signature; notice on the
  dashboard while batches are pending.
- **Tests:** API test of the full cycle (25 tests).

### Changed
- **Backend:** the full import without approval (Settings → Data) now also requires the `cfg` permission and is
  labelled "initial migration only".

### Upgrade notes
- **Migration `002_import_approvals.sql`:** tables `import_batches` and `import_changes`; the new roles and
  permissions above.

---

## [0.3.0] — 2026-10-13 — Mandatory note for "with notes" statuses

### Added
- **Backend:** choosing a "with notes" status — test status *Passed with note* (1), notifications *Working with
  notes* (2), review *Present with notes* (3) — requires a non-empty note. The API refuses with `note_required`
  when the status would be saved without a note, when the note is cleared while such a status is set, and for a
  bulk *Passed with note* while some enabled items have no note. A user allowed to set such a status may write its
  note in the same request.
- **Frontend:** selecting one of these statuses on an item without a note opens the note window first ("Note
  required", with the reason); Save stays disabled until a note is typed; Cancel keeps the previous status; "Clear"
  is disabled while the note is required; items with such a status but no note (older data) show a red note icon.
- **Tests:** API test for the rule (24 tests).

### Changed
- **Backend:** the login/2FA rate limit is configurable (`LOGIN_RATE_LIMIT`, default 30 per 15 min per IP).

---

## [0.2.2] — 2026-10-13 — Fix blank page after creating a user

### Added
- **Frontend:** error boundary — if a screen fails to render, a message with "reload" and "dashboard" buttons is
  shown instead of a blank page; it clears when you navigate elsewhere.

### Fixed
- **Frontend:** after saving a new user the page `/users/<id>` went blank (`Cannot read properties of null (reading
  'full_name')`): the form briefly treated the empty "new user" data as the saved user. The form is now re-created
  for each user id. The user was always saved correctly; only the screen failed.

---

## [0.2.1] — 2026-10-13 — Reports in the department menus

### Added
- **Frontend:** new page `/reports/:dept` showing one department's reports, with a breadcrumb to the department.

### Changed
- **Frontend:** sidebar — «التقارير» moved from «المتابعة» to the top of «الإدارات». Each department now has an
  expandable sub-list whose first item is that department's reports, followed by its applications. The department
  of the current page opens automatically.

### Fixed
- **Frontend:** "%15" shown instead of "15%" in the reports share card in Arabic.

---

## [0.2.0] — 2026-10-12 — Installation wizard

### Added
- **Deployment:** `deploy/install.sh` rewritten as an interactive wizard. It asks for the domain or IP address
  (auto-detected), the certificate type (self-signed / Let's Encrypt / own files / plain HTTP), the HTTPS port, the
  HTTP redirect port, the internal application port, the database location (local or remote) with host, port, name,
  user and password (or a generated one), the administrator username, name, e-mail and password, the 2FA policy,
  the system names, the time zone, the backup retention, an optional data import and the firewall. Every answer is
  validated; passwords are typed twice and never echoed. A summary must be confirmed before anything changes.
- **Deployment:** `--dry-run` (writes the would-be config files to `./ets-dry-run/` with secrets masked),
  `--answers FILE` and `--yes` for unattended installs; template `deploy/answers.example`.
- **Deployment:** re-running the wizard keeps the data and `APP_SECRET`, offers the previous answers
  (`/etc/ets/install.conf`) as defaults, backs up `ets.env`, and resets the admin password.
- **Deployment:** nginx split into templates (`deploy/nginx/*.tpl`) for any HTTPS/HTTP/internal port; HTTP redirect
  server with a Let's Encrypt webroot for automatic renewal; plain-HTTP mode.
- **Deployment:** local PostgreSQL on a custom port (cluster port changed with `pg_conftool`); remote PostgreSQL
  with connection and `citext` checks.
- **Deployment:** the firewall opens the real SSH port (read from `sshd -T`) plus only the chosen web ports; time
  zone and NTP set; first backup taken; health checks of the service and the web server.
- **Backend:** `scripts/set-setting.js` to change a validated setting from the command line; `create-admin.js
  --email`, password from `ETS_ADMIN_PASSWORD` (never on the command line).

### Changed
- **Database:** `deploy/db/create-database.sql` takes the database name, user and password as variables
  (`-v db_name= -v db_user= -v db_password=`).
- **Deployment:** `ets-backup` / `ets-restore` read the DB connection from `/etc/ets/ets.env`, so they work with any
  DB name, user, port or remote server.
- **Docs:** Installation Guide rewritten for the wizard (all questions, what to prepare, remote DB, re-running,
  troubleshooting).

### Fixed
- **Deployment:** installation stopped at step 8 with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a
  string` — `/etc/ets` was `root:root 750`, so the `ets` user could not read `ets.env` and connected with an empty
  password. The folder is now `root:ets 750`, and the installer checks the file is readable. The app now stops with
  a clear message when its configuration file cannot be read (`ETS_ENV_FILE=none` skips it in tests).
- **Deployment:** nginx refused `http2 on;` on Ubuntu's nginx 1.18/1.24 — now `listen … ssl http2`.
- **Deployment:** nginx failed to start on servers with IPv6 disabled — `[::]` listeners are dropped there.
- **Backend:** in plain-HTTP mode the API's security headers asked browsers to upgrade to HTTPS
  (`upgrade-insecure-requests`) — now only sent with HTTPS; HSTS is sent once, by nginx.

---

## [0.1.0] — 2026-10-12 — First version (backend + frontend + PostgreSQL)

Initial development: the repository was created on 2026-10-12 (`cfa5836`, README only) and the whole first version
was built in one commit (`8119253`).

### Added
- **Database:** migration `001_init.sql` — users, roles, per-user permission overrides and scopes, sessions, 2FA
  recovery codes, settings, departments, applications, functions, reports track, schedule, and five log tables
  (`auth_log`, `audit_log`, `access_log`, `error_log`, `system_log`).
- **Database:** catalog extracted from `reference/erp-tracker-original.html` by `tools/extract-catalog.js`:
  4 departments, 30 applications, 513 functions (232 design, 125 vendor-list, 156 experience). Function codes
  (`D0…`, `X0…`) are identical to the original page so its saved data imports without remapping.
- **Backend:** Express 5 REST API — auth, tracker (summary, departments, applications, functions, bulk edit, custom
  requirements, weights, reports, schedule, search, export/import), users, settings, logs, system info.
- **Backend:** progress calculation ported from the original page (notification blending, reports share,
  fixed/auto weights, department and project roll-up), with unit tests.
- **Backend:** import of the original page's data (standalone HTML with `window.__SAVED`, or its JSON export) from
  the UI (Settings → Data) or CLI (`npm run import-legacy`); export in the same format.
- **Backend:** five roles (admin, department manager, application editor, tester, observer), 11 permission keys,
  per-user grant/revoke overrides, department/application data scope; last-admin protection.
- **Backend:** logging of every event to the database and to JSON-lines files (`app.log`, `error.log`,
  `access.log`); log viewer API with filters, paging and CSV export; daily retention purge.
- **Frontend:** React UI in the ERPNext visual style — top navbar with search, workspace sidebar, number cards,
  indicator pills, list views and forms; Arabic (RTL) and English (LTR) with per-user language; Cairo font bundled
  locally; responsive down to phone width.
- **Frontend:** screens — login, 2FA verify (code or recovery code), 2FA enrolment, forced password change,
  dashboard, department, application (inline editing of progress, weight, test/notification/review status, notes,
  enable/disable, bulk set, add requirement), weights, reports, S-curve & schedule, search, users & permissions,
  logs, settings, my account.
- **Deployment:** `deploy/install.sh` for Ubuntu 22.04/24.04 (Node 22, PostgreSQL, nginx + HTTPS
  self-signed/certbot/existing, systemd hardened unit, logrotate, daily `pg_dump` backups, ufw), `ets-backup`,
  `ets-restore`, `update.sh`, `create-database.sql`, `schema-reference.sql`.
- **Docs:** README, STRUCTURE, the change history (now this CHANGELOG) and the customer handover pack in
  `docs/handover/`.
- **Tests:** 23 automated tests — TOTP against RFC 6238/4226 vectors, calculation rules, and API integration tests
  (login, lockout, CSRF, 2FA modes, permissions, scope, audit, users, settings, import, logs).

### Fixed
- Fixed during development, before release:
  - **Backend:** the file logger crashed on early process exit (`sonic boom is not ready`) — file log streams are
    now synchronous.
  - **Frontend:** percentages showed as `%49.2` inside Arabic text — numbers are now bidi-isolated (LTR).
  - **Frontend:** the application function table overflowed horizontally at 1360 px — status selects narrowed.
  - **Backend:** the users list returned role ids only — now includes role names in both languages.

### Security
- **Backend:** login with username/password (bcrypt), account lockout after N failures, generic error messages,
  equal timing for unknown users, rate limiting on login and 2FA.
- **Backend:** two-factor authentication (TOTP, RFC 6238), compatible with Google/Microsoft Authenticator; QR
  enrolment; 10 one-time recovery codes; replay protection; secrets encrypted with AES-256-GCM.
- **Backend:** 2FA policy `off` / `optional` / `required`; per-user exemption; bulk exempt / un-exempt (all users or
  selected); admin reset of a user's authenticator.
- **Backend:** server-side sessions in PostgreSQL (httpOnly, SameSite=strict cookie, absolute and idle timeout,
  revocation), CSRF header check, helmet security headers and CSP, forced password change.

---

<!-- No git tags exist yet, so the links compare the commit that completed each release. Once tags are created
     (v1.7.0 …), replace the hashes with the tags. -->
[Unreleased]: https://github.com/mscit-admin/ets/compare/b2043e3...HEAD
[1.12.25]: https://github.com/mscit-admin/ets/compare/1545ce3...b2043e3
[1.12.24]: https://github.com/mscit-admin/ets/compare/00a0a55...1545ce3
[1.12.23]: https://github.com/mscit-admin/ets/compare/fe414d0...00a0a55
[1.12.22]: https://github.com/mscit-admin/ets/compare/5763be8...fe414d0
[1.12.21]: https://github.com/mscit-admin/ets/compare/1bcef55...5763be8
[1.12.20]: https://github.com/mscit-admin/ets/compare/958dbed...1bcef55
[1.12.19]: https://github.com/mscit-admin/ets/compare/ddc5999...958dbed
[1.12.18]: https://github.com/mscit-admin/ets/compare/a587e3d...ddc5999
[1.12.17]: https://github.com/mscit-admin/ets/compare/6483caa...a587e3d
[1.12.16]: https://github.com/mscit-admin/ets/compare/cf5cb68...6483caa
[1.12.15]: https://github.com/mscit-admin/ets/compare/240d29c...cf5cb68
[1.12.14]: https://github.com/mscit-admin/ets/compare/b6c4318...240d29c
[1.12.13]: https://github.com/mscit-admin/ets/compare/b53272a...b6c4318
[1.12.12]: https://github.com/mscit-admin/ets/compare/83d44aa...b53272a
[1.12.11]: https://github.com/mscit-admin/ets/compare/6d1c14a...83d44aa
[1.12.10]: https://github.com/mscit-admin/ets/compare/1e244b8...6d1c14a
[1.12.9]: https://github.com/mscit-admin/ets/compare/3177ecb...1e244b8
[1.12.8]: https://github.com/mscit-admin/ets/compare/bbf838f...3177ecb
[1.12.7]: https://github.com/mscit-admin/ets/compare/badafd9...bbf838f
[1.12.6]: https://github.com/mscit-admin/ets/compare/cc064d9...badafd9
[1.12.5]: https://github.com/mscit-admin/ets/compare/c1285ef...cc064d9
[1.12.4]: https://github.com/mscit-admin/ets/compare/3d0f83e...c1285ef
[1.12.3]: https://github.com/mscit-admin/ets/compare/8d0af85...3d0f83e
[1.12.2]: https://github.com/mscit-admin/ets/compare/91587f6...8d0af85
[1.12.1]: https://github.com/mscit-admin/ets/compare/4eab0ae...91587f6
[1.12.0]: https://github.com/mscit-admin/ets/compare/2435711...4eab0ae
[1.11.0]: https://github.com/mscit-admin/ets/compare/dd41f54...2435711
[1.10.0]: https://github.com/mscit-admin/ets/compare/1ff9138...dd41f54
[1.9.2]: https://github.com/mscit-admin/ets/compare/80f9472...1ff9138
[1.9.1]: https://github.com/mscit-admin/ets/compare/b5eb9e2...80f9472
[1.9.0]: https://github.com/mscit-admin/ets/compare/261ea0b...b5eb9e2
[1.8.1]: https://github.com/mscit-admin/ets/compare/4d4a7f0...261ea0b
[1.8.0]: https://github.com/mscit-admin/ets/compare/f7544d0...4d4a7f0
[1.7.0]: https://github.com/mscit-admin/ets/compare/abd37eb...f7544d0
[1.6.0]: https://github.com/mscit-admin/ets/compare/4e2c8c6...abd37eb
[1.5.1]: https://github.com/mscit-admin/ets/compare/9085ef2...4e2c8c6
[1.5.0]: https://github.com/mscit-admin/ets/compare/c2c6c45...9085ef2
[1.4.0]: https://github.com/mscit-admin/ets/compare/0d5f4eb...c2c6c45
[1.3.0]: https://github.com/mscit-admin/ets/compare/8a64cba...0d5f4eb
[1.2.0]: https://github.com/mscit-admin/ets/compare/d91578f...8a64cba
[1.1.1]: https://github.com/mscit-admin/ets/compare/50f1ec9...d91578f
[1.1.0]: https://github.com/mscit-admin/ets/compare/c9ba0d7...50f1ec9
[1.0.0]: https://github.com/mscit-admin/ets/compare/a984702...c9ba0d7
[0.9.0]: https://github.com/mscit-admin/ets/compare/59ed8ac...a984702
[0.8.1]: https://github.com/mscit-admin/ets/compare/6fed0bb...59ed8ac
[0.8.0]: https://github.com/mscit-admin/ets/compare/9cbf0ea...6fed0bb
[0.7.0]: https://github.com/mscit-admin/ets/compare/045df85...9cbf0ea
[0.6.1]: https://github.com/mscit-admin/ets/compare/a21bd07...045df85
[0.6.0]: https://github.com/mscit-admin/ets/compare/7265b93...a21bd07
[0.5.2]: https://github.com/mscit-admin/ets/compare/f4123c0...7265b93
[0.5.1]: https://github.com/mscit-admin/ets/compare/a51dc61...f4123c0
[0.5.0]: https://github.com/mscit-admin/ets/compare/51be99a...a51dc61
[0.4.0]: https://github.com/mscit-admin/ets/compare/7557934...51be99a
[0.3.0]: https://github.com/mscit-admin/ets/compare/a8cec3d...7557934
[0.2.2]: https://github.com/mscit-admin/ets/compare/7fdb5c6...a8cec3d
[0.2.1]: https://github.com/mscit-admin/ets/compare/b1bd3b5...7fdb5c6
[0.2.0]: https://github.com/mscit-admin/ets/compare/8119253...b1bd3b5
[0.1.0]: https://github.com/mscit-admin/ets/compare/cfa5836...8119253
