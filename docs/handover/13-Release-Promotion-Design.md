# 13 — Release Promotion (Test → Production) — Design & Implementation Plan

> **Status: PHASE 1 IMPLEMENTED (1.12.18).** The in-app foundation of §8 Phase 1 is built and tested: migration
> `024_release_promotion.sql` (`release_promotions`, `release_agent_status`), the pure manifest + Ed25519 sign/verify
> logic `backend/src/services/release.js`, the admin-only `/api/release/*` endpoints
> (`backend/src/routes/release.js`), the Settings → «الترقية والنشر» screen
> (`frontend/src/components/ReleasePromotion.jsx`), and `backend/test/release.test.js`. **Phases 2–3 (the root agents,
> signing-key install, systemd units, real git push/pull/checkout/update.sh, health gate and rollback) are NOT built.**
> In Phase 1 the agent is **mocked**: a promotion is RECORDED as a signed intent (status `requested`) — nothing is
> pushed to git, no tag is created, no deploy happens. The confirmed user decisions are applied: version→commit
> resolution prefers an annotated tag `v<x.y.z>` else the `release <x.y.z>` commit; promote requires a single admin +
> re-auth (password + OTP); and an `auto_rollback` boolean (default true) is stored for Phase 3 to honour.
>
> **Config/env keys added in Phase 1** (keys live only in root-owned files, never in the DB or the repo — same secrets
> rule as backups): `ETS_RELEASE_SIGN_KEY` (path to the Ed25519 release private-key PEM, default
> `/etc/ets/release-sign.key`; when unset/unreadable the promote button is disabled and `/promote` returns
> `release_signing_unavailable`), `ETS_RELEASE_SIGNERS_DIR` (directory of allow-listed signer public-key PEMs, default
> `/etc/ets/release-trust`), `ETS_RELEASE_FRESHNESS_DAYS` (replay window, default 14) and `ETS_RELEASE_PROMOTE_LIMIT`
> (per-admin promote rate limit, default 10/hour). Actual key generation and the deploy key are Phase 2 (§8a.1).
>
> **What is a full check vs. a documented stub in Phase 1** (`services/release.js`): signature-against-allow-listed-
> signer, downgrade (strictly-newer version), freshness window + one-time nonce (replay), and prev-state match are
> **full**. **Commit membership is partial:** Phase 1 verifies the 40-hex format and that the commit **resolves to a
> known release** (from tags / CHANGELOG release commits); the full ancestor check
> (`git merge-base --is-ancestor <commit> origin/HEAD`) is a **Phase 2 stub** because it needs the root agent's fetched
> git working copy, which the unprivileged API does not have.
>
> *(Original design note, retained for Phases 2–3.)* This document specifies a feature built in the staged plan of §8,
> each stage shippable and (where possible) unit-testable in this repository.

A system administrator tests a new ETS version on the **test server**, then — from the **admin screen** — presses one
button to promote that exact version to **production**. The promotion is carried out safely (automatic backup first,
one-click rollback if it fails) and without ever giving the API root or repository write credentials, mirroring the
`ets-backup-agent` architecture already in the product (see [08 — Backup & Recovery](08-Backup-and-Recovery.md)).

| | |
|---|---|
| **Test server** | `http://161.97.78.116:8899` — where testing happens and the promote button lives |
| **Production** | `https://10.61.85.50:3594` — reached over VPN; deploys are **pulled** here, never pushed to |
| **Shared channel** | the git repository **`github.com/mscit-admin/ets`** — the only path both servers share |
| **Granularity** | by **released version** (e.g. `1.12.17`); everything up to that version/commit is promoted |
| **Safety** | automatic encrypted backup **before** every production deploy + one-click **rollback** |

---

## 1. Goal and confirmed decisions

**Goal.** Give the administrator a controlled, auditable "promote to production" pipeline so that a version proven on
the test server reaches production exactly, with a backup taken first and a rollback available, and without weakening
any of the system's security invariants.

**Confirmed decisions (from the user):**

1. **Where.** Testing is done on the test server (`161.97.78.116:8899`). The promote button is on the **admin screen**
   of the **test** ETS.
2. **Signalling direction.** The **production** deploy-agent **pulls**. There is **no direct test→prod network call**;
   the two servers communicate only through the git repository.
3. **Granularity.** By **version**. The admin picks a released version from the changelog/tags; everything up to that
   commit is promoted. **Not** per-feature cherry-pick.
4. **Safety.** An **automatic encrypted backup** is taken on production **before** each deploy, and there is a
   **one-click rollback** to the previous version if the update fails.

**Invariant that shapes everything below (from [06 — Security](06-Security.md) and the backup design):** the API
process (`ets-backend.service`, user `ets`) **never runs as root** and **never holds repository write credentials**.
All privileged work — git checkout, `update.sh`, migrations, restarting services — is done by **root deploy-agents**
installed exactly like `ets-backup-agent`: a systemd oneshot started by a timer and a `.path` wake file, reading its
desired state from the database, validating it again, and acting only on an allow-list. The API only **records
intent**.

> **This feature deliberately introduces automatic deployment, which was previously disallowed.** §4 enumerates the
> compensating controls that make this acceptable. Treat a production deploy as the **single most sensitive action in
> the system** — more sensitive than a restore, because it changes code *and* data on the production server.

---

## 2. Architecture

### 2.1 Diagram

```
  TEST SERVER (161.97.78.116:8899)                 GITHUB (mscit-admin/ets)            PRODUCTION (10.61.85.50:3594, via VPN)
  ───────────────────────────────                  ──────────────────────             ──────────────────────────────────────
                                                                                        [ runs the CURRENTLY deployed version ]
  ┌──────────────────────────┐                                                          ┌──────────────────────────┐
  │ Admin UI (Settings →     │                                                          │ Prod ETS API (user ets,  │
  │  «ترقية إلى الإنتاج»)     │                                                          │  unprivileged) — shows   │
  │  version picker +        │                                                          │  deploy status read from │
  │  what-changed + button   │                                                          │  prod DB (status file)   │
  └────────────┬─────────────┘                                                          └────────────┬─────────────┘
               │ POST /api/release/promote                                                           │ reads status (no root)
               │  (admin + password + OTP + confirm)                                                 │
  ┌────────────▼─────────────┐                                                          ┌────────────▼─────────────┐
  │ Test ETS API (user ets)  │                                                          │ ets-deploy-agent (ROOT)  │
  │  writes release_promotions│   (1) wake .path                                        │  oneshot, timer + .path  │
  │  row (intent only)        │──────────────┐                                          │  reads prod DB intent +  │
  └────────────┬─────────────┘               │                                          │  PULLS the signal        │
               │ wake .path                   │                                          └──────┬──────┬────────────┘
  ┌────────────▼─────────────┐                │                                                 │(pull)│(push status)
  │ ets-release-publisher    │                │   deploy/production-release.json                 │      │
  │  (ROOT) oneshot          │                │   { version, commit, prev, authorizer,          │      │
  │  builds + SIGNS manifest │   (2) git push │     ts, nonce }  + Ed25519 signature  ◄──────────┘      │
  │  pushes via deploy key   │───────────────────────────────────►  (signed by RELEASE KEY)            │
  │  (write-restricted)      │                │                                                         │
  │  PULLS prod status back  │◄───────────────────────────────────  deploy/production-status.json ◄────┘
  └──────────────────────────┘                │                     (signed by PROD KEY)
                                                └── everything up to <commit> is on the default branch already
```

Both servers hold the git repository as a working copy (the production server already needs a repository copy to run
`update.sh`). The repository is the mailbox: the **publisher writes** a signed release manifest into it, the **prod
agent reads** it, and the **prod agent writes back** a signed status file that the **publisher reads** so the test-side
admin screen can show progress. Neither server ever opens a socket to the other.

### 2.2 Component list

| # | Component | Runs as | Server | Role |
|---|---|---|---|---|
| A | **Admin UI** — Settings → «ترقية إلى الإنتاج» / "Promote to production" | browser | test | Version picker, what-changed preview, promote button, live status, rollback button, history |
| B | **Test ETS API** `/api/release/*` | `ets` (unpriv.) | test | Validates admin + re-auth + confirmation, records the promotion **intent** in `release_promotions`, exposes status/history. Holds **no** signing or push key. |
| C | **`release_promotions`** table (+ `release_agent_status`) | PostgreSQL | test & prod | Intent + lifecycle record; see §2.3 |
| D | **`ets-release-publisher`** agent | **root** | test | Oneshot (timer + `.path`), mirrors `ets-backup-agent`. Reads an *authorized* promotion, builds the manifest, **signs** it with the release private key, **pushes** it via a write-restricted deploy key, and **pulls back** the prod status file. Allow-listed files only. |
| E | **Release signing key** (Ed25519) | root-only file on test | test | `/etc/ets/release-sign.key` (600). Public half is baked into the prod agent's allow-list. Not in the repo. |
| F | **Signal** — `deploy/production-release.json` (+ `.sig`) | committed file | repo | The authenticated promote signal; see §3 |
| G | **`ets-deploy-agent`** agent | **root** | prod | Oneshot (timer + `.path`), mirrors `ets-backup-agent`. Pulls the signal, **verifies** the signature against the allow-listed signer, backs up (reuses `ets-backup`), checks out the commit, runs `update.sh`, health-checks, records the result, rolls back on failure, and **writes back** the signed `production-status.json`. |
| H | **Prod signing key** (Ed25519) | root-only file on prod | prod | `/etc/ets/deploy-status.key` (600). Signs the status file the test side reads. Public half baked into the publisher's allow-list. |
| I | **Prod ETS API** `/api/release/status` (read-only) | `ets` (unpriv.) | prod | Lets a prod admin see the same status the agent wrote; never triggers a deploy itself. |

### 2.3 Database tables

`release_promotions` lives in **both** databases but is written differently on each side (the test API records intent;
the prod agent records execution). A migration `024_release_promotion.sql` creates it. Shape (mirrors the shape of
`backup_jobs` / `backup_status`):

```sql
CREATE TABLE IF NOT EXISTS release_promotions (
  id             bigserial PRIMARY KEY,
  version        text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  commit         text NOT NULL CHECK (commit ~ '^[0-9a-f]{40}$'),
  prev_version   text,                              -- the version production ran before this (for rollback / display)
  prev_commit    text CHECK (prev_commit IS NULL OR prev_commit ~ '^[0-9a-f]{40}$'),
  nonce          text NOT NULL,                     -- random; replay protection, binds the signal to this row
  requested_by   integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  authorized_by  integer REFERENCES users(id) ON DELETE SET NULL,  -- who passed re-auth + confirm
  authorized_at  timestamptz,
  signer         text,                              -- key id of the release key that signed the manifest
  status         text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','authorized','published','pulled','backing_up',
                                   'deploying','verifying','succeeded','failed','rolled_back','cancelled')),
  intent         text NOT NULL DEFAULT 'deploy' CHECK (intent IN ('deploy','rollback')),
  backup_ref     text,                              -- the pre-deploy backup file name (for the DB rollback path)
  progress       jsonb,                             -- step checklist / percentages, no secrets
  result         jsonb,                             -- health result, migrations applied, timings
  error          text,
  published_at   timestamptz,
  finished_at    timestamptz
);
CREATE INDEX IF NOT EXISTS release_promotions_open ON release_promotions(status, id)
  WHERE status NOT IN ('succeeded','failed','rolled_back','cancelled');
-- at most one promotion in flight at a time
CREATE UNIQUE INDEX IF NOT EXISTS release_promotions_one_open ON release_promotions((1))
  WHERE status IN ('authorized','published','pulled','backing_up','deploying','verifying');

CREATE TABLE IF NOT EXISTS release_agent_status (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb, -- deployed version/commit, last pull, last verify result
  agent_seen_at timestamptz,
  apply_error   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

The **status lifecycle** flows `draft → authorized` (test API, after re-auth) `→ published` (publisher pushed the
signal) `→ pulled → backing_up → deploying → verifying → succeeded | failed → rolled_back` (prod agent). On the test
side, states after `published` are learned from the signed `production-status.json` the publisher pulls back; on the
prod side the agent writes them directly. Every transition writes a `release` row to the **system log** (§4.3).

Secrets rule (same as backups): **no table column ever holds a key**. The signing keys live only in root-owned files;
the API cannot read them.

---

## 3. Cross-server signalling and authenticity (the core design)

### 3.1 Recommended option: a signed release manifest committed to the repo

**`deploy/production-release.json`** — a small JSON file the publisher commits to the default branch, plus a detached
signature `deploy/production-release.json.sig`:

```json
{
  "schema": 1,
  "version": "1.12.17",
  "commit":  "a587e3d…(40 hex)…",
  "prev_version": "1.12.16",
  "prev_commit":  "6483caa…(40 hex)…",
  "intent":  "deploy",
  "authorizer": { "user": "admin", "name": "…", "at": "2026-10-23T10:00:00Z" },
  "nonce":   "3f9c…(random)…",
  "issued_at": "2026-10-23T10:00:05Z",
  "signer_key_id": "a1b2c3d4e5f60718"
}
```

`production-release.json.sig` is an **Ed25519 signature over the exact canonical bytes** of the manifest (the manifest
is serialized with sorted keys and no trailing whitespace — reuse the `canon()` helper that already exists in
`backend/src/backup/config.js`). The signature is produced by the **release private key** held only on the test server
(`/etc/ets/release-sign.key`, root 600).

**How the production agent verifies it (every pull, before doing anything):**

1. **Signature.** Verify `.sig` against the manifest bytes using the **allow-listed public key(s)** baked into the prod
   agent's config (`/etc/ets/deploy-agent.conf`, root-owned, not in the repo). A manifest whose signer key id is not on
   the allow-list, or whose signature does not verify, is **rejected and logged** — nothing is deployed.
2. **Commit membership.** The signed `commit` must be an ancestor of the current default branch tip and the file's own
   commit (the agent fetches, then `git merge-base --is-ancestor <commit> origin/main`). This stops a signal that
   points at a commit that was never released.
3. **Monotonic version.** `version` must be **strictly newer** than the currently deployed version (from
   `/opt/ets/BUILD-INFO`) for `intent:"deploy"`. A lower/equal version is refused unless `intent:"rollback"` and it
   matches the recorded `prev_*` of the deployment being rolled back. This blocks **downgrade attacks**.
4. **Freshness / replay.** `issued_at` must be within a window (e.g. 14 days) and the `nonce` must not equal the nonce
   of an already-applied manifest (the agent remembers the last applied nonce in `release_agent_status`). A replayed old
   manifest is refused.
5. **Prev-match.** `prev_commit` must equal the agent's currently deployed commit, so the manifest was authored against
   the state production is actually in (detects a race / a stale signal).

Only when **all** checks pass does the agent proceed to §5.

### 3.2 Who pushes the signal

**The push is done by the test-side root agent (`ets-release-publisher`) using a write-restricted deploy key** —
**not** by the API, and **not** by CI.

* The **API holds neither the signing key nor a push credential.** It only writes an `authorized` row. The publisher
  (root) is woken by the `.path` file, re-reads and re-validates the row, signs, and pushes. This is the *exact* trust
  split the backup feature already uses (API records intent → root agent acts), so it reuses a proven, audited pattern
  and keeps **one** trust model across the product.
* The deploy key is a **GitHub deploy key scoped to this one repo with write access** (or a fine-grained PAT limited to
  `contents:write` on `mscit-admin/ets`), stored `/etc/ets/release-deploy-key` (root 600). Because the signal's
  authenticity rests on the **Ed25519 signature**, not on who pushed, even a leaked deploy key cannot *forge* a valid
  deploy — it could only push a manifest the prod agent will reject for a bad signature.

### 3.3 Rejected alternatives

| Option | Why rejected |
|---|---|
| **(b) a `production` branch fast-forwarded to the chosen tag** | A branch (or tag) carries **no authenticity**: anyone with push rights — or anyone who compromises the repo — can move it, and the prod agent cannot tell an authorized move from a malicious one. It would make "can push to the repo" equivalent to "can deploy to production", which violates the threat model in §4.4. Usable only *with* a separate signature, at which point the manifest is simpler and self-describing. |
| **(c) a `prod-current` git tag** | Same authenticity gap as a branch, plus tags are mutable and easy to move by accident; no room for authorizer, nonce, prev-state or freshness. |
| **CI / GitHub Action signs + deploys** | Adds GitHub Actions and its stored secrets as a **new trust anchor and a new attack surface** (workflow edits, secret exfiltration, supply-chain), needs repo-admin, and puts a cloud service in the path to an **air-gapped, VPN-only** production box. Our pull-only prod agent already needs no inbound access; CI would not improve that and would couple deploys to GitHub availability. We keep CI out of the trust path entirely. |
| **API pushes directly** | Would require the unprivileged API to hold repo-write credentials and a signing key — a direct violation of the never-root / no-write-creds invariant. |

**Net:** a **signed manifest** (option a) **published by the test root agent via a restricted deploy key**, verified by
the prod agent against an **allow-listed signer** — authenticity is independent of the transport, so a repo or
deploy-key compromise cannot trigger a production deploy.

### 3.4 Status back-channel (symmetric)

Production cannot call the test server either, so the prod agent writes `deploy/production-status.json` (version,
commit, per-step progress, result, timestamps — **no secrets**), signs it with the **prod status key**
(`/etc/ets/deploy-status.key`), and pushes it with its own write-restricted deploy key. The publisher pulls and
verifies it (against the prod public key on its allow-list) and writes it into the test `release_promotions.progress`,
so the admin screen shows live-ish status (polled; latency = pull interval). The prod ETS API also surfaces it locally.

---

## 4. Security model

### 4.1 Authentication and authorization

* **Admin-only.** `/api/release/*` requires `requireAuth, requirePerm('cfg'), requireAdmin` — the same gate as
  Settings → «النسخ الاحتياطي». Non-admins never see the tab (the UI hides it; the API refuses it).
* **Re-authentication on promote.** Pressing promote requires a fresh **password + OTP** re-auth, reusing the exact
  `reauth(req, { password, secondFactor:true, events:[…] })` helper used by the backup restore/escrow flow
  (`backend/src/routes/auth.js`). The re-auth is recorded; 3 bad attempts apply the standard lockout.
* **Explicit confirmation step.** After re-auth the admin must type the target version (or a confirmation phrase), like
  the restore wizard's "type the host name" gate, so the version being promoted is unmistakable.
* **Rate limiting.** `/api/release/promote` is rate-limited per administrator (e.g. 10 / hour), same pattern as the
  backup job limiter.

### 4.2 Signature verification (authenticity)

As in §3.1: the prod agent **only** acts on a manifest that is Ed25519-signed by an **allow-listed** key, points at a
**released ancestor commit**, is **strictly newer** (or an explicit matching rollback), is **fresh** (window + nonce,
no replay), and matches the **prev-state**. The signing private key never leaves the test server and is never in the
repo; the prod agent carries only the **public** allow-list.

### 4.3 Audit trail

Every step is in the **change history / system log** with readable sentences (reusing `logAudit` / `logSystem`):
promote requested (who, version, commit), re-auth result, manifest signed and pushed (signer key id, nonce), pulled on
prod, backup taken (which file), checkout, migrations applied, health result, success/failure, rollback. A new
notification class mirrors the backup ones — **S-REL** "production deploy started / succeeded / failed / rolled back",
critical, sent to administrators (phone allowed). Secrets (keys) are never logged.

### 4.4 Threat cases

| Who/what | Could they trigger an unwanted prod deploy? | Why not |
|---|---|---|
| A **non-admin** app user | No | `/api/release/*` is admin-only; the row needs `authorized_at` from a re-auth'd admin. |
| An **admin without the 2nd factor / password** | No | Promote needs a fresh password + OTP re-auth and an explicit confirm. |
| Someone who **compromises the GitHub repo** (push rights) | No | They can push a manifest, but cannot produce a valid **signature** (the signing key is not in the repo). The prod agent rejects an unsigned/badly-signed/unknown-signer manifest. They also cannot create a commit the manifest can point at that is both an ancestor *and* passes the newer/prev checks without the signature. |
| Someone who **steals the test-side deploy key** | No (only an annoyance) | The deploy key only pushes; authenticity is the signature. A forced push of a bad manifest fails signature verification on prod. (Still: rotate the key; the prod agent logs rejected signals.) |
| Someone who **steals the release signing key** (root on the test server) | Yes — this is the crown jewel | If an attacker is already root on the test server they can sign. Compensating controls: the key is root-600, the test server is the lower-trust box but still hardened per [06](06-Security.md); the prod agent still requires the commit to be a released ancestor and still takes a **backup before deploying** and health-gates with **rollback**; every deploy raises an S-REL alert to all admins; and key rotation + an allow-list of *multiple* signers let a compromised key be removed centrally. Optionally require **two** distinct signers (dual-control) for prod — see §9. |
| A **replayed old manifest** | No | Freshness window + one-time nonce; the agent remembers the last applied nonce. |
| A **downgrade** to a vulnerable old version | No | Monotonic-version check; a lower version is refused unless it is an explicit, prev-matching rollback. |
| A **bad migration** that corrupts prod | Contained | Backup-before-deploy + health gate + rollback; DB rollback = restore the pre-deploy backup (§5.3). |

### 4.5 Compensating controls for "automatic deployment" (previously disallowed)

1. Human-in-the-loop: a deploy only ever starts from an **admin pressing a button with re-auth + confirm**. The agent
   never invents a deploy; it only executes an authorized, signed intent.
2. **Backup first, always** (reuse `ets-backup`), recorded as `backup_ref`.
3. **Cryptographic authenticity** independent of transport (§3).
4. **Health gate + automatic rollback** (§5.2–5.3).
5. **Full audit trail + mandatory S-REL alerts** to every admin.
6. **Allow-listed agent actions** only (no shell; argument arrays; writable-file allow-list) — same as the backup agent.
7. **One promotion in flight** (DB unique partial index) — no concurrent deploys.
8. **Version-only granularity** — the promoted artifact is a released, reviewed commit, not an ad-hoc cherry-pick.

---

## 5. Sequences

### 5.1 Happy path

```
1. Admin opens Settings → «ترقية إلى الإنتاج» on the TEST server, picks version 1.12.17 (default: latest released),
   reviews the "what changed since production's 1.12.16" preview, presses Promote.
2. API: requireAdmin → re-auth (password + OTP) → confirm phrase → INSERT release_promotions (status 'authorized',
   nonce, requested_by, authorized_by/at, prev_* from the last known prod version). Touch the publisher .wake file.
3. ets-release-publisher (root) wakes, re-validates the row, resolves the commit for 1.12.17, builds the canonical
   manifest, SIGNS it (release key), writes deploy/production-release.json(+.sig), commits and PUSHES via the deploy
   key. Marks the row 'published'. (Nothing was sent to prod directly.)
4. ets-deploy-agent (root, PROD) on its next timer/.path cycle does: git fetch; read manifest; VERIFY (signature,
   ancestor, newer, fresh/nonce, prev-match). All pass → status 'pulled'.
5. PROD: 'backing_up' — run `ets-backup` (encrypted), record backup_ref. Then 'deploying' — git checkout <commit>
   into the repo copy, run `sudo bash deploy/scripts/update.sh` (builds as ets-build, migrations via ets-log-protect,
   restarts ets-backend). Then 'verifying' — poll /api/health until OK (reuse update.sh's own health loop).
6. Health OK → status 'succeeded'; write + sign + push production-status.json. BUILD-INFO now shows 1.12.17.
7. Publisher pulls production-status.json, verifies it, updates the test row to 'succeeded'. Admin screen shows green;
   S-REL "succeeded" alert to admins.
```

### 5.2 Failure / rollback path

```
5'. update.sh fails, OR /api/health does not come up within the timeout.
    → prod agent marks 'failed', captures the log, and begins AUTOMATIC ROLLBACK (or waits for the admin's one-click
      rollback, per the configured mode — see §9):
      a. git checkout <prev_commit>  (the version production ran before — code rollback is cheap and exact)
      b. run update.sh from the previous copy to rebuild/redeploy that version
      c. IF the failed deploy had already applied a forward migration, the schema is now ahead of the old code →
         DB ROLLBACK is required (5.3).
      d. health-check the restored version; status 'rolled_back'; sign + push status; S-REL "rolled back" alert.
```

### 5.3 The DB-migration rollback caveat (explicit)

**Code rollback is easy; database rollback is NOT.** `update.sh` runs **forward** migrations on production, and ETS
migrations are not written to run in reverse. So:

* **Code-only failure** (build/restart failed *before* migrations, or no migration in this version): checkout the
  previous commit and redeploy — **no DB action needed**. Detect this from whether `migrate_db` ran (the agent records
  the pre-deploy migration head and compares).
* **Failure after a migration ran** (the dangerous case): the schema is now ahead of the old code. The **only reliable
  DB rollback is restore-from-backup** — restore the **pre-deploy backup** (`backup_ref`) taken in step 5. This is why
  the backup is mandatory and its name is stored on the row. The agent restores it with the existing restore path
  (`ets-restore <backup_ref>` / the restore agent), which empties and reloads the schema in one transaction, then
  redeploys the previous code. **Data written to production between the backup and the failed deploy is lost** — the
  backup is taken immediately before deploy to keep that window to seconds, and the deploy is health-gated so most
  failures surface before users return.
* **Forward-compatibility requirement (mitigates the above):** migrations should follow the **expand/contract**
  pattern — a release only *adds* columns/tables and tolerates the previous code; destructive changes (drop/rename)
  are split across **two** releases (expand in release N, contract in release N+1 once N is proven in production). Then
  a single-release rollback rarely needs a DB restore at all. Document this rule in the migration guide and gate it in
  review.

---

## 6. Admin UI specification (Settings → «ترقية إلى الإنتاج»)

A new tab in `frontend/src/pages/Settings.jsx`, admin-only (same gating as the backup tab), component
`frontend/src/components/ReleasePromotion.jsx`. Sections:

1. **Current state banner.** "Production is running **1.12.16** (commit `6483caa`, deployed 2026-10-20). Test is
   **1.12.17**." Read from the prod status back-channel; shows a staleness note if the last prod status is old.
2. **Version picker.** A dropdown of **released versions** parsed from `CHANGELOG.md` headings
   (`## [1.12.17] — …`) and/or git tags, newest first, limited to versions **newer than production's**. Each option
   shows the version, date and one-line title. (Default selection: the latest released version.)
   > *Note:* the repo currently has **no git tags** — see §9. The picker falls back to CHANGELOG headings + the
   > `release <x.y.z>` commits until tagging is adopted.
3. **What-changed preview.** The CHANGELOG entries between production's version and the selected version
   (Added/Changed/Fixed/Security/**Upgrade notes**), with the **Upgrade notes** highlighted (operator actions,
   migrations). This is the admin's go/no-go information.
4. **Promote button.** Opens a modal: re-auth (password + OTP) → confirm (type the version) → submit. Disabled when a
   promotion is already in flight or when the selected version is not newer than production.
5. **Live status.** A per-step checklist (authorized → published → pulled → backing up → deploying → verifying →
   succeeded/failed/rolled back) with timestamps, the backup file name, the health result, and the deploy log tail on
   failure. Polled from `GET /api/release/status`.
6. **Rollback button.** Enabled when the current/last deploy is `failed` (or always, as a break-glass, per §9 mode).
   One click → re-auth → confirm → records a `rollback` intent to `prev_commit`; same pipeline in reverse, with the
   §5.3 DB caveat shown plainly before confirming.
7. **History.** A table of past promotions (version, who, when, result, duration, backup used, rolled back?), read from
   `release_promotions`, newest first — the audit view for operators.

Arabic labels throughout (RTL), matching the existing settings pages; English in this doc for the technical reader.

---

## 7. What is testable here vs. operator-verified

| Verifiable **in this sandbox** (unit/integration tests) | Verifiable **only on the real servers** |
|---|---|
| The `/api/release/*` endpoints: admin gate, re-auth, confirm, rate-limit, intent row creation, status/history reads | The `ets-release-publisher` and `ets-deploy-agent` systemd units running as root |
| `release_promotions` migration + lifecycle transitions | The actual git **push** with the deploy key over the network |
| Manifest **build + canonicalization + sign + verify** logic (pure functions; a committed test key pair) | Production **pull over VPN**, checkout, `update.sh`, migrations, restart |
| Signature **rejection** cases (bad signer, replay/nonce, downgrade, stale prev, non-ancestor) — table-driven tests | The **end-to-end** promote→deploy→health→rollback on `10.61.85.50:3594` |
| Admin UI: picker parsing of CHANGELOG, what-changed diff, modal flow (component tests) | The real **backup-before-deploy** and **restore-from-backup** DB rollback |
| A **mocked agent** that reads a queued row and writes status, so the whole app flow is exercised | Key generation, allow-list install, deploy-key authorization on GitHub |

**The pipeline cannot be end-to-end tested in the dev sandbox** (no prod server, no VPN, no systemd, no real GitHub
deploy key). Phase 1 (below) is therefore built against a **mocked agent**; the real agents (Phase 2) are verified with
the dry-run rehearsal in §8/§8a on the actual servers.

---

## 8. Staged implementation plan

Each phase is independently shippable. Sizes are rough (S ≈ ½ day, M ≈ 1–2 days, L ≈ 3–5 days of focused work).

### Phase 1 — In-app foundation (fully testable here) — **size M** — ✅ IMPLEMENTED in 1.12.18

* **Files:** `backend/src/db/migrations/024_release_promotion.sql`; `backend/src/routes/release.js` (new, mounted in
  `backend/src/app.js`); `backend/src/services/release.js` (manifest build/canon/verify as pure functions, reusing
  `canon()` and Node `crypto` Ed25519); `frontend/src/components/ReleasePromotion.jsx`; a tab in
  `frontend/src/pages/Settings.jsx`; i18n strings; `backend/test/release.test.js`.
* **Build:** the table, the endpoints (promote/authorize/status/history/rollback-intent) with admin + re-auth + confirm
  + rate-limit + audit, the UI (picker from CHANGELOG, what-changed, modal, status/history), and a **mocked agent**
  (a test harness / dev script that drains the queue and writes `release_agent_status`) so the flow runs end-to-end
  in-app.
* **Testable here:** everything in the left column of §7. **Operator-verified:** nothing yet.

### Phase 2 — The real agents, signing and systemd (operator-verified) — **size L**

* **Files:** `deploy/scripts/release-publisher.sh` + `backend/scripts/release-publisher.js` (test side); `deploy/scripts/
  deploy-agent.sh` + `backend/scripts/deploy-agent.js` (prod side); shared `deploy/scripts/release-lib.sh`;
  `backend/src/release/agent-util.js` (allow-list + `run` without a shell, mirrored from `backup/agent-util.js`);
  systemd units `deploy/systemd/ets-release-publisher.{service,timer,path}` and `ets-deploy-agent.{service,timer,path}`;
  `install.sh` / `update.sh` hooks to install + enable them and to generate/record keys; operator docs (§8 of this doc
  → a new runbook section in [10 — Operations Runbook](10-Operations-Runbook.md)).
* **Build:** publisher reads an `authorized` row, signs, pushes via the deploy key, pulls the status back; prod agent
  pulls, verifies (all §3.1 checks), backs up, checks out, runs `update.sh`, health-checks, writes/signs/pushes status.
  Both use the writable-file allow-list and argument-array `run` — **no shell**.
* **Testable here:** the pure sign/verify/canon and allow-list logic (unit). **Operator-verified:** the actual push/
  pull, checkout, `update.sh`, health, and the systemd wiring — on the real servers, via the §8a rehearsal.

### Phase 3 — Rollback, health gating, history polish — **size M**

* **Files:** rollback branch in `deploy-agent.js` (code rollback + the §5.3 DB-restore path reusing `ets-restore`);
  health-gate timeout + log capture; S-REL notification class in `backend/src/services/notify-catalog.js` /
  `notify-events.js`; the history table + status back-channel polish in `ReleasePromotion.jsx`; prod read-only
  `/api/release/status`.
* **Build:** automatic (or one-click, per mode) rollback with the migration caveat handled; mandatory alerts; the
  history/audit view; the back-channel status surfaced on both servers.
* **Testable here:** rollback **decision** logic and the migration-head comparison (unit), notification rendering, UI.
  **Operator-verified:** a real failed deploy → real rollback → real DB restore, in the §8a rehearsal.

---

## 8a. Operator setup and rehearsal

### 8a.1 Keys and allow-lists (one time)

```bash
# TEST server — release signing key (Ed25519) + its id; the PUBLIC half goes to prod's allow-list
sudo install -d -m 700 /etc/ets
sudo bash -c 'umask 077; openssl genpkey -algorithm ed25519 -out /etc/ets/release-sign.key'   # 600, root
sudo openssl pkey -in /etc/ets/release-sign.key -pubout -out /etc/ets/release-sign.pub         # share this
#   record its key id (salted hash, like the backup key id) for the allow-list and the audit rows

# TEST server — write-restricted git deploy credential (deploy key or fine-grained PAT, contents:write on this repo)
sudo bash -c 'umask 077; : > /etc/ets/release-deploy-key'   # install the private deploy key here, root 600
#   add its PUBLIC key as a WRITE deploy key on github.com/mscit-admin/ets (Settings → Deploy keys)

# PROD server — status signing key (Ed25519); PUBLIC half goes to the publisher's allow-list on the test server
sudo bash -c 'umask 077; openssl genpkey -algorithm ed25519 -out /etc/ets/deploy-status.key'
sudo openssl pkey -in /etc/ets/deploy-status.key -pubout -out /etc/ets/deploy-status.pub

# PROD server — the deploy agent's config: the ALLOW-LISTED release public key(s), the repo URL + its own deploy key
sudo install -m 600 /dev/stdin /etc/ets/deploy-agent.conf <<'EOF'
# the only signers the production deploy agent will trust (paste the test server's release-sign.pub here)
ALLOWED_SIGNERS=/etc/ets/release-trust/*.pub
REPO_URL=https://github.com/mscit-admin/ets.git
DEPLOY_KEY=/etc/ets/prod-status-deploy-key      # write-restricted, for pushing production-status.json only
FRESHNESS_DAYS=14
AUTO_ROLLBACK=on                                # or 'off' for one-click-only rollback
EOF
sudo install -d -m 700 /etc/ets/release-trust   # drop each trusted release-*.pub here (rotation = add/remove files)
```

### 8a.2 systemd units (both servers, installed by `install.sh`/`update.sh`)

Mirror the backup units exactly: a **oneshot `.service`** run as root, a **`.timer`** (poll every 30 s on prod so a
pushed signal is picked up quickly; the publisher can poll less often), and a **`.path`** watching
`/var/lib/ets/inbox/.wake` so the test API's wake file starts the publisher at once. The prod agent keeps a tmpfs
`RuntimeDirectory` like the backup agent if it must hold a restore key briefly during a DB rollback.

```bash
sudo systemctl enable --now ets-release-publisher.timer ets-release-publisher.path   # TEST
sudo systemctl enable --now ets-deploy-agent.timer     ets-deploy-agent.path         # PROD
```

### 8a.3 VPN / pull assumptions

The production server reaches GitHub for **fetch** (and to **push** only its status file) — confirm the VPN/egress
allows HTTPS to `github.com`. The test server reaches GitHub for fetch + push. **Neither server needs any inbound port
from the other**; the admin reaches the test UI on `161.97.78.116:8899` and (separately, over VPN) the prod UI on
`https://10.61.85.50:3594`. Escrow both signing keys like the backup key (§6 of [08](08-Backup-and-Recovery.md)):
without the release key no new deploys can be signed; losing it is recoverable by generating a new one and updating the
prod allow-list.

### 8a.4 Staged dry-run / rollback rehearsal (on the real servers, before first real use)

1. **Verify-only dry run (prod agent `--dry-run`):** publish a manifest for the version prod already runs; the agent
   should fetch, verify the signature and all checks, and **report "already at this version, nothing to do"** — proves
   signing, the allow-list, fetch and verification without changing anything.
2. **Bad-signal drills:** push a manifest signed by a **non-allow-listed** key, a **replayed** nonce, and a
   **downgrade** — confirm each is **rejected and logged** and nothing deploys.
3. **Forward deploy on a staging clone of prod** (same OS/systemd), promoting N-1 → N: confirm backup taken, checkout,
   `update.sh`, health OK, status pushed back, test UI goes green.
4. **Failure + rollback drill:** promote a deliberately broken build (e.g. a migration that fails) on the staging
   clone; confirm the health gate fails, the agent rolls back the code, and — because a migration ran — **restores the
   pre-deploy backup** (§5.3), ending `rolled_back` with the DB intact and the alert sent.
5. Only after 1–4 pass on staging, enable it against the real production server and do the first promotion during a
   maintenance window with the operator watching.

---

## 9. Open questions and risks (for the user)

1. **Git tags.** The repo currently has **no tags** (only `release <x.y.z>` commits + CHANGELOG headings). Should we
   adopt annotated, **signed** tags per release (`v1.12.17`)? That makes the version picker and the "commit for a
   version" resolution unambiguous and lets the prod agent verify the tag signature too. **Recommended.**
2. **Auto-rollback vs. one-click rollback.** Should a failed deploy roll back **automatically**, or stop at `failed`
   and wait for the admin's **one-click** rollback? Auto is safer for availability; manual gives a human the chance to
   inspect first. Proposed default: **auto-rollback on a failed health check**, with a config switch (`AUTO_ROLLBACK`).
3. **Dual-control for production.** Given a stolen *release signing key* is the one way to forge a deploy (§4.4), do you
   want to require **two** signers (two admins, two keys) for a prod promotion? The allow-list already supports multiple
   signers; dual-control would be a Phase 4 add-on.
4. **The lost-writes window (§5.3).** On a migration-failure rollback, data written to prod between the pre-deploy
   backup and the failure is lost. Acceptable given the health gate keeps the window to seconds, or do you want a
   maintenance-mode "drain users first" option before prod deploys?
5. **Expand/contract migrations.** Adopting the two-release pattern for destructive schema changes is what makes single
   -release rollback safe without a DB restore. Is the team willing to split destructive changes across two releases?
6. **Repository availability.** The pipeline depends on GitHub being reachable from both servers over the VPN. Is an
   internal mirror (or a self-hosted git remote reachable on the VPN) wanted as a fallback, so a GitHub outage cannot
   block an urgent promotion or rollback?
7. **Who holds the keys / escrow owner.** Same escrow discipline as the backup key: who stores the release and status
   signing keys, and who can rotate the prod allow-list?
8. **Scope of "everything up to the version".** Confirmed as the whole default-branch history up to the chosen commit
   (no cherry-pick). Does production ever need to run a version the test server has **not** run first? (The monotonic
   check assumes a linear test→prod promotion.)

---

## 10. Files this feature will add (reference, when built)

| Path | What |
|---|---|
| `backend/src/db/migrations/024_release_promotion.sql` | `release_promotions`, `release_agent_status` |
| `backend/src/routes/release.js` | `/api/release/*` (admin + re-auth + confirm, intent only) |
| `backend/src/services/release.js` | manifest build / canon / Ed25519 sign+verify (pure, unit-tested) |
| `backend/src/release/agent-util.js` | allow-list + no-shell `run`, mirrored from `backup/agent-util.js` |
| `backend/scripts/release-publisher.js`, `deploy/scripts/release-publisher.sh` | TEST root agent: sign + push + pull status |
| `backend/scripts/deploy-agent.js`, `deploy/scripts/deploy-agent.sh` | PROD root agent: pull + verify + backup + checkout + update.sh + health + rollback |
| `deploy/scripts/release-lib.sh` | shared shell helpers |
| `deploy/systemd/ets-release-publisher.{service,timer,path}` | TEST agent units |
| `deploy/systemd/ets-deploy-agent.{service,timer,path}` | PROD agent units |
| `frontend/src/components/ReleasePromotion.jsx` + a tab in `frontend/src/pages/Settings.jsx` | the admin UI |
| `/etc/ets/release-sign.key(.pub)`, `release-deploy-key`, `deploy-status.key(.pub)`, `deploy-agent.conf`, `release-trust/*.pub` | keys & allow-lists (root 600; **not in the repo**) |

---

*This is a design document, not a release. Nothing here changes the running system until the staged plan is built,
reviewed and — for Phases 2–3 — rehearsed on the real servers per §8a.*
