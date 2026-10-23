// Release promotion (1.12.18, PHASE 1): the PURE manifest + signature logic shared by the test API
// (backend/src/routes/release.js) and — in Phase 2 — the root agents (ets-release-publisher / ets-deploy-agent).
//
// This module is deliberately free of Express, the database and git, so it is cleanly unit-tested
// (backend/test/release.test.js). It does three things:
//   1. build + canonicalize the release manifest JSON (the exact bytes that get signed),
//   2. Ed25519 sign + verify those bytes (Node `crypto`, keys supplied by the caller — never read here, never
//      committed; the real keys live in root-owned files per the design §8a.1),
//   3. the verification CHECKS the production agent runs before it would deploy (§3.1): signature against an
//      allow-listed signer, commit resolves to a known release, strictly-newer version (downgrade block), freshness
//      window + one-time nonce (replay block), and prev-state match.
//
// Trust boundary: the manifest's authenticity rests on the Ed25519 SIGNATURE over the canonical bytes, not on who
// pushed it. A caller verifies a manifest by supplying the allow-listed signer public keys and the current deployed
// state; every rejection returns a clear machine-readable `reason`.
import crypto from 'node:crypto';
import { canon } from '../backup/config.js';

export const MANIFEST_SCHEMA = 1;
export const DEFAULT_FRESHNESS_DAYS = 14;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{16,128}$/;

// A fresh random nonce (32 hex = 128 bits). Binds a signal to one promotion row and gives replay protection.
export const newNonce = () => crypto.randomBytes(16).toString('hex');

// Compare two x.y.z versions. 1 if a>b, -1 if a<b, 0 if equal. (Same semantics as backup/config.js cmpVersion.)
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

// ---------------------------------------------------------------- keys & key ids
// A stable, non-secret id for a signer: the first 16 hex of SHA-256 over the key's DER SubjectPublicKeyInfo. Derived
// from the PUBLIC key only, so it is safe to log and to store on the promotion row and in the allow-list.
export function keyId(publicKeyPem) {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}
// Derive the public half of a private key (so a signer can record its own key id).
export const publicFromPrivate = privateKeyPem =>
  crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' });

// ---------------------------------------------------------------- manifest
// Build the canonical manifest object (not yet signed). Throws on a malformed input so a bad manifest is never signed.
export function buildManifest({ version, commit, prevVersion = null, prevCommit = null, intent = 'deploy',
  authorizer, nonce, issuedAt, signerKeyId }) {
  if (!VERSION_RE.test(String(version || ''))) throw new Error('invalid_version');
  if (!COMMIT_RE.test(String(commit || ''))) throw new Error('invalid_commit');
  if (prevVersion !== null && !VERSION_RE.test(String(prevVersion))) throw new Error('invalid_prev_version');
  if (prevCommit !== null && !COMMIT_RE.test(String(prevCommit))) throw new Error('invalid_prev_commit');
  if (!['deploy', 'rollback'].includes(intent)) throw new Error('invalid_intent');
  if (!nonce || !NONCE_RE.test(String(nonce))) throw new Error('invalid_nonce');
  if (!authorizer || typeof authorizer !== 'object') throw new Error('invalid_authorizer');
  return {
    schema: MANIFEST_SCHEMA,
    version: String(version),
    commit: String(commit),
    prev_version: prevVersion,
    prev_commit: prevCommit,
    intent,
    authorizer: { user: String(authorizer.user ?? ''), name: String(authorizer.name ?? ''), at: String(authorizer.at ?? '') },
    nonce: String(nonce),
    issued_at: issuedAt || new Date().toISOString(),
    signer_key_id: signerKeyId ? String(signerKeyId) : null,
  };
}

// The exact bytes that are signed / verified: JSON with recursively sorted keys, no trailing whitespace. Reuses the
// backup canon() helper so a value read back from jsonb compares equal to the same value built in JavaScript.
export const manifestBytes = manifest => Buffer.from(canon(manifest), 'utf8');

// Sign a manifest with a release private key. Returns the detached signature (base64) and the signer key id, and
// stamps signer_key_id onto the manifest (signed as part of the canonical bytes). The private key is used and
// discarded here; it is never stored.
export function signManifest(manifest, privateKeyPem) {
  const pub = publicFromPrivate(privateKeyPem);
  const signer = keyId(pub);
  const m = { ...manifest, signer_key_id: signer };
  const sig = crypto.sign(null, manifestBytes(m), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { manifest: m, signature: sig, signer_key_id: signer };
}

// Low-level signature check: does `signature` (base64) verify over the manifest bytes under `publicKeyPem`?
export function verifySignature(manifest, signature, publicKeyPem) {
  try {
    return crypto.verify(null, manifestBytes(manifest), crypto.createPublicKey(publicKeyPem), Buffer.from(String(signature), 'base64'));
  } catch { return false; }
}

// ---------------------------------------------------------------- individual checks (each returns a reason or null)
// 1. Signature against an ALLOW-LISTED signer. allowedSigners: [{ key_id, publicKey }]. The manifest's signer_key_id
//    must be on the list AND the signature must verify under that key. Full check (not a stub).
export function checkSignature(manifest, signature, allowedSigners) {
  const list = Array.isArray(allowedSigners) ? allowedSigners : [];
  const signer = list.find(s => s.key_id === manifest?.signer_key_id);
  if (!signer) return 'unknown_signer';
  if (!verifySignature(manifest, signature, signer.publicKey)) return 'bad_signature';
  return null;
}

// 2. Commit membership. Phase 1 verifies the FORMAT (40 hex) and that the commit RESOLVES TO A KNOWN RELEASE — the
//    caller passes `knownCommits`, the set of commit hashes that back a released version (resolved from tags /
//    CHANGELOG release commits by the route). The full ancestor check (`git merge-base --is-ancestor`) is a
//    documented Phase 2 stub: it needs a git working copy and the fetched default branch, which only the root agent
//    has. When `knownCommits` is not supplied, only the format is checked.
export function checkCommit(manifest, knownCommits = null) {
  if (!COMMIT_RE.test(String(manifest?.commit || ''))) return 'bad_commit_format';
  if (knownCommits && !(knownCommits instanceof Set ? knownCommits.has(manifest.commit) : knownCommits.includes(manifest.commit))) {
    return 'unknown_commit';
  }
  return null;
}

// 2b. Ancestor membership (PHASE 2 — completed in the production deploy agent, which HAS the fetched git working copy).
//     The agent computes `git merge-base --is-ancestor <commit> <default-branch-tip>` and passes the boolean result as
//     `isAncestor`. A commit that is NOT an ancestor of the default branch is refused (it was never released on the
//     line production follows). `isAncestor === null`/undefined means the caller cannot evaluate it (e.g. the
//     unprivileged test API, which has no fetched default branch) → skipped, exactly like checkCommit's knownCommits.
export function checkAncestor(manifest, { isAncestor = null } = {}) {
  if (!COMMIT_RE.test(String(manifest?.commit || ''))) return 'bad_commit_format';
  if (isAncestor === false) return 'non_ancestor';
  return null;
}

// 3. Monotonic version — blocks a downgrade. For intent 'deploy' the version must be STRICTLY NEWER than the deployed
//    version. For intent 'rollback' the version must be <= deployed and must match the recorded prev_version.
export function checkVersion(manifest, deployed) {
  if (!VERSION_RE.test(String(manifest?.version || ''))) return 'bad_version_format';
  if (!deployed?.version) return null;   // nothing deployed yet: any valid version is acceptable
  const c = cmpVersion(manifest.version, deployed.version);
  if (manifest.intent === 'rollback') {
    if (c > 0) return 'rollback_not_older';
    if (deployed.prev_version && manifest.version !== deployed.prev_version) return 'rollback_prev_mismatch';
    return null;
  }
  if (c <= 0) return 'downgrade';
  return null;
}

// 4. Freshness window + one-time nonce — blocks a replay. issued_at must be within freshnessDays of `now`, and the
//    nonce must not equal an already-applied nonce.
export function checkFreshness(manifest, { now = Date.now(), freshnessDays = DEFAULT_FRESHNESS_DAYS, usedNonces = null } = {}) {
  const t = Date.parse(manifest?.issued_at || '');
  if (!Number.isFinite(t)) return 'bad_issued_at';
  const age = now - t;
  if (age > freshnessDays * 864e5) return 'stale';
  if (age < -5 * 60_000) return 'issued_in_future';   // small clock-skew tolerance
  if (usedNonces && (usedNonces instanceof Set ? usedNonces.has(manifest.nonce) : usedNonces.includes(manifest.nonce))) {
    return 'replayed_nonce';
  }
  return null;
}

// 5. Prev-match — the manifest was authored against the state production is actually in. prev_commit must equal the
//    currently deployed commit (skipped when nothing is deployed yet, i.e. a first deploy).
export function checkPrev(manifest, deployed) {
  if (!deployed?.commit) return null;
  if (manifest?.prev_commit !== deployed.commit) return 'prev_mismatch';
  return null;
}

// The whole verification the production agent runs before it would act (§3.1). Returns { ok: true } or
// { ok: false, reason, check }. Checks run in order; the first failure is reported.
export function verifyManifest({ manifest, signature }, { allowedSigners = [], deployed = null,
  knownCommits = null, isAncestor = null, now = Date.now(), freshnessDays = DEFAULT_FRESHNESS_DAYS, usedNonces = null } = {}) {
  const steps = [
    ['signature', () => checkSignature(manifest, signature, allowedSigners)],
    ['commit', () => checkCommit(manifest, knownCommits)],
    ['ancestor', () => checkAncestor(manifest, { isAncestor })],
    ['version', () => checkVersion(manifest, deployed)],
    ['freshness', () => checkFreshness(manifest, { now, freshnessDays, usedNonces })],
    ['prev', () => checkPrev(manifest, deployed)],
  ];
  for (const [check, fn] of steps) {
    const reason = fn();
    if (reason) return { ok: false, check, reason };
  }
  return { ok: true };
}

// ================================================================= Phase 3: pure deploy-decision logic
// These functions carry NO IO (no HTTP, no git, no DB): the production deploy agent (backend/src/release/
// deploy-agent.js) does the actual readiness probing and git/update.sh work, then hands the collected results to
// these pure reducers to decide pass/fail and the rollback action. Kept here so they are unit-tested
// (backend/test/release.test.js) WITHOUT a live production server — the §7 "testable here" column.

// Extended health gate (§5.1 "verifying" + the design's "show WHY a deploy failed"). The agent runs one or more
// readiness PROBES — the app serves /api/health, an optional second known endpoint, the database is reachable, and
// migrations are applied — and passes their raw results here as [{ name, ok, detail }]. evaluateHealth reduces them
// to a single verdict with a human-readable summary that is recorded in the promotion progress/result and the signed
// production-status.json, so the Release screen can show exactly which check failed.
//   required: the probe names that MUST pass (default: every probe present). A required probe that is missing from
//   the list counts as a failure (the agent could not even run it).
export function evaluateHealth(probes, { required = null } = {}) {
  const list = Array.isArray(probes) ? probes : [];
  const checks = list.map(c => ({
    name: String(c?.name || ''),
    ok: !!c?.ok,
    detail: c?.detail == null ? null : String(c.detail).slice(0, 500),
  }));
  const req = Array.isArray(required) && required.length ? required : checks.map(c => c.name);
  const failed = checks.filter(c => req.includes(c.name) && !c.ok).map(c => c.name);
  const missing = req.filter(n => !checks.some(c => c.name === n));
  const passed = checks.length > 0 && failed.length === 0 && missing.length === 0;
  const bad = [...failed, ...missing.map(m => `${m} (not run)`)];
  return {
    passed,
    checks,
    failed,
    missing,
    summary: passed ? `all ${checks.length} readiness checks passed`
      : checks.length === 0 ? 'no readiness checks ran'
        : `readiness failed: ${bad.join(', ')}`,
  };
}

// The completed auto-rollback decision table (§5.2–§5.3). PURE: given the facts the agent gathered, decide the single
// next action. DB rollback is NEVER automatic — a migration-after-failure can only be undone by restore-from-backup
// (manual, per §5.3), so the function returns `stop_needs_db_restore` with the exact operator command instead.
//   inputs: { auto_rollback, migration_ran, health_passed, backup_ref, prev_commit }
//   action ∈ { none | code_rollback | stop | stop_needs_db_restore }
//     none                  the deploy is healthy — nothing to undo.
//     code_rollback         unhealthy, no migration ran, auto_rollback on, a previous commit exists → check out the
//                           previous commit and redeploy (safe: the schema matches the old code).
//     stop_needs_db_restore unhealthy AND a migration ran → the schema is ahead of the old code; code rollback alone
//                           is UNSAFE. Stop at failed and surface the manual `ets-restore <backup_ref>` command.
//     stop                  unhealthy, no migration, but auto_rollback is off (operator inspects first) OR there is no
//                           previous commit to roll back to (first deploy). Stop at failed; no DB restore needed.
export function rollbackDecision({ auto_rollback = true, migration_ran = false, health_passed = false,
  backup_ref = null, prev_commit = null } = {}) {
  if (health_passed) return { action: 'none', needs_db_restore: false, reason: 'healthy' };
  if (migration_ran) {
    return {
      action: 'stop_needs_db_restore',
      needs_db_restore: true,
      backup_ref: backup_ref || null,
      restore_command: `ets-restore ${backup_ref || '<backup_ref>'}`,
      reason: 'health_failed_after_migration',
    };
  }
  if (auto_rollback && prev_commit) {
    return { action: 'code_rollback', needs_db_restore: false, prev_commit, reason: 'health_failed_code_rollback' };
  }
  return { action: 'stop', needs_db_restore: false, reason: auto_rollback ? 'no_prev_commit' : 'auto_rollback_off' };
}

// Which S-REL (S12 release_event) stage, if any, a promotion status transition should alert on. PURE so the "fires on
// the right transitions" rule is unit-tested without the agents. The terminal transitions are high-signal (the caller
// maps failed/rolled_back to a critical severity); a repeat of the same status, or any non-interesting hop, is null.
const TERMINAL_STAGE = { succeeded: 'succeeded', failed: 'failed', rolled_back: 'rolled_back' };
export function releaseNotifyStage(oldStatus, newStatus) {
  if (oldStatus === newStatus) return null;
  return TERMINAL_STAGE[newStatus] || null;
}
// Severity for a release_event stage (failed / rolled_back are high-signal; started / succeeded are informational).
export const releaseStageSeverity = stage => (stage === 'failed' || stage === 'rolled_back' ? 'critical' : 'info');
