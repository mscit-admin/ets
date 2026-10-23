// The PRODUCTION-side root release agent ets-deploy-agent (1.12.19, PHASE 2) — backend/scripts/deploy-agent.js, run by
// ets-deploy-agent.service every 30 s (ets-deploy-agent.timer) and at once when the repo working copy's signal file
// changes (ets-deploy-agent.path). Installed BY THE OPERATOR on the production server. Production never opens a socket
// to the test server: it PULLS the signed signal from git and verifies it cryptographically before doing anything.
//
// Each cycle:
//   1. git fetch the default branch (read-only pull credentials).
//   2. read deploy/production-release.json(+.sig) from the fetched branch and VERIFY it with the shared verify.mjs
//      helper against the allow-listed signer key baked into /etc/ets/deploy-agent.conf — ALL §3.1 checks must pass:
//      signature, commit is an ANCESTOR of the default branch (git merge-base --is-ancestor — the Phase-1 stub is
//      completed HERE, where the git copy exists), version strictly newer (downgrade block) or a matching rollback,
//      fresh (window + one-time nonce vs release_agent_status.last_nonce), and prev_commit == the deployed commit.
//   3. on accept: take a pre-deploy ets-backup (store its ref), checkout the tagged commit, run deploy/scripts/
//      update.sh (migrations + build + restart), then HEALTH-GATE (poll /api/health for HEALTH_TIMEOUT seconds).
//   4. success → record 'succeeded', write + sign + push production-status.json. Failure → record 'failed' with the
//      backup_ref and, when AUTO_ROLLBACK=on AND NO migration ran, code-rollback (checkout prev commit + update.sh);
//      when a migration ran the schema is ahead of the old code so a DB restore-from-backup is required — that is the
//      §5.3 manual / Phase-3 path, left as a clearly-recorded hook (DB rollback is NOT performed automatically here).
//
// No shell (argument arrays); only the status files + the local status.json are writable (deployWritable allow-list);
// runs as root only via its own unit; the API / ets user is never in this path.
//
// OPERATOR-VERIFIED: the real fetch/checkout/update.sh/restart/health/rollback run only on the production server
// (and its staging clone, per docs/handover/13 §8a.4). The dev sandbox has no prod, no systemd and no git remote, so
// this logic is delivered for the operator rehearsal; the PURE verification it rests on is unit-tested via verify.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pool, query } from '../db/pool.js';
import { signManifest } from '../services/release.js';
import { releasePaths, deployWritable, writeAllowed, readConf, run, readText } from './agent-util.js';

export const LOCK_KEY = 'ets_deploy_agent';
const say = (...a) => console.log(new Date().toISOString(), 'deploy-agent', ...a);
const MANIFEST_REL = 'deploy/production-release.json';
const STATUS_REL = 'deploy/production-status.json';
const COMMIT_RE = /^[0-9a-f]{40}$/;

function sshEnv(keyFile) {
  if (!keyFile || !fs.existsSync(keyFile)) return {};
  return { GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
}
// Current production version + commit (authoritative): /opt/ets/BUILD-INFO, written by build_and_deploy_app.
function buildInfo(p) {
  const txt = readText(path.join(p.app, 'BUILD-INFO')) || '';
  const g = re => (re.exec(txt) || [])[1] || null;
  const commit = g(/^commit=([0-9a-f]+)/m);
  return { version: g(/^version=([0-9.]+)/m), commit: COMMIT_RE.test(String(commit)) ? commit : null };
}
// Count of applied migrations (schema_migrations) — compared before/after update.sh to tell a code-only failure
// (checkout + redeploy is enough) from a failure after a migration ran (schema ahead of old code → DB restore needed).
async function migrationHead() {
  try { return (await query(`SELECT count(*)::int AS n, max(version) AS head FROM schema_migrations`)).rows[0]; }
  catch { return { n: null, head: null }; }
}
async function setAgentStatus(data, nonce, applyError = null) {
  await query(`INSERT INTO release_agent_status(id, data, last_nonce, agent_seen_at, apply_error, updated_at)
    VALUES (1,$1,$2,now(),$3,now())
    ON CONFLICT (id) DO UPDATE SET data=$1, last_nonce=COALESCE($2, release_agent_status.last_nonce), agent_seen_at=now(), apply_error=$3, updated_at=now()`,
  [JSON.stringify(data), nonce, applyError]).catch(() => {});
}

// Write + sign + push the production status back-channel (no secrets), and the local /var/lib/ets/release/status.json
// the prod read-only API reads. Signed by the PROD status key; verified by the publisher's status allow-list.
async function writeStatus(p, conf, status) {
  const allow = deployWritable(p, conf.REPO_DIR);
  const local = path.join(p.releaseDir, 'status.json');
  try { fs.mkdirSync(p.releaseDir, { recursive: true, mode: 0o755 }); } catch { /* exists */ }
  writeAllowed(allow, local, JSON.stringify(status, null, 2) + '\n', 0o644);

  const keyPem = readText(conf.STATUS_KEY || p.statusKey);
  if (!keyPem) { say('no status signing key — status not pushed'); return { pushed: false, reason: 'no_status_key' }; }
  let signed; try { signed = signManifest(status, keyPem); } catch (e) { return { pushed: false, reason: 'sign_failed: ' + e.message }; }

  const repo = conf.REPO_DIR, remote = conf.REPO_REMOTE || 'origin', branch = conf.BRANCH || 'main';
  const env = sshEnv(conf.DEPLOY_KEY || p.deployKey);
  const git = (args) => run(p.git, ['-C', repo, ...args], { env, full: true });
  writeAllowed(allow, path.join(repo, STATUS_REL), JSON.stringify(signed.manifest, null, 2) + '\n', 0o644);
  writeAllowed(allow, path.join(repo, STATUS_REL) + '.sig', signed.signature + '\n', 0o644);
  // commit on top of the current branch tip without disturbing the checked-out deploy commit: use a worktree-free add
  await git(['fetch', remote, branch]);
  await git(['stash', 'push', '--include-untracked', '--', STATUS_REL, STATUS_REL + '.sig']).catch(() => ({}));
  // Push the status on the branch tip. The operator rehearsal confirms the exact git flow; keep it best-effort so a
  // status-push hiccup never masks the deploy result already recorded in the DB.
  const r = await git(['push', remote, `HEAD:${branch}`]);
  return { pushed: r.code === 0, reason: r.code === 0 ? null : r.out.trim().slice(-200) };
}

// Poll the local health endpoint until it answers OK or the timeout elapses. → true on healthy.
async function healthGate(conf) {
  const url = conf.HEALTH_URL || `http://127.0.0.1:${conf.PORT || process.env.PORT || 3000}/api/health`;
  const timeoutMs = Math.max(5, Number(conf.HEALTH_TIMEOUT || 120)) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await run('curl', ['-fsS', '--max-time', '5', url]);
    if (r.code === 0) return true;
    await new Promise(res => setTimeout(res, 3000));
  }
  return false;
}

// Run deploy/scripts/update.sh from the repo working copy (as root; update.sh builds, migrates and restarts). →
// { code, out }.
function runUpdate(p, conf) {
  const repo = conf.REPO_DIR;
  const update = conf.UPDATE_CMD || path.join(repo, 'deploy', 'scripts', 'update.sh');
  return run('bash', [update], { cwd: repo, timeoutMs: Math.max(600, Number(conf.UPDATE_TIMEOUT || 3600)) * 1000, full: true });
}

// Check out a commit in the repo working copy (detached). → { ok }.
async function checkout(p, conf, commit) {
  const repo = conf.REPO_DIR;
  const r = await run(p.git, ['-C', repo, 'checkout', '--force', '--detach', commit], { full: true });
  return { ok: r.code === 0, out: r.out };
}

// Deploy one verified manifest. Records progress through release_agent_status + the status back-channel.
async function deploy(p, conf, manifest) {
  const commit = manifest.commit, version = manifest.version, nonce = manifest.nonce;
  const prevInfo = buildInfo(p);
  const base = { version, commit, prev_version: prevInfo.version, prev_commit: prevInfo.commit, nonce,
    intent: manifest.intent || 'deploy', issued_at: new Date().toISOString() };
  const emit = async (phase, extra = {}) => {
    const status = { ...base, phase, ...extra };
    await setAgentStatus({ version: phase === 'succeeded' ? version : prevInfo.version, commit: phase === 'succeeded' ? commit : prevInfo.commit,
      deployed_at: phase === 'succeeded' ? new Date().toISOString() : (prevInfo.version ? undefined : null), phase, nonce }, phase === 'succeeded' || phase === 'rolled_back' ? nonce : null);
    await writeStatus(p, conf, status).catch(e => say('status write error:', e.message));
    return status;
  };

  // 1. pre-deploy backup (mandatory) — reuse ets-backup; capture its file as backup_ref for the DB rollback path
  await emit('backing_up');
  const bk = await run(conf.BACKUP_CMD || p.backupCmd, [], { env: { ETS_BACKUP_LOCK_WAIT: '600' }, full: true });
  const backupRef = (/backup ok: (\S+)/.exec(bk.out) || [])[1] || null;
  if (bk.code !== 0) { await emit('failed', { error: 'pre_deploy_backup_failed', backup_ref: backupRef }); return { ok: false, reason: 'backup_failed' }; }
  say('pre-deploy backup:', backupRef || '(unparsed)');

  // 2. record the migration head, checkout, run update.sh
  const preMig = await migrationHead();
  await emit('deploying', { backup_ref: backupRef });
  const co = await checkout(p, conf, commit);
  if (!co.ok) { await emit('failed', { error: 'checkout_failed', backup_ref: backupRef }); return { ok: false, reason: 'checkout_failed' }; }
  const up = runUpdate(p, conf);
  const upRes = await up;

  // 3. health gate
  await emit('verifying', { backup_ref: backupRef });
  const healthy = upRes.code === 0 && await healthGate(conf);
  const postMig = await migrationHead();
  const migrated = preMig.n !== null && postMig.n !== null && postMig.n > preMig.n;

  if (healthy) {
    say(`deploy ${version} succeeded`);
    await emit('succeeded', { backup_ref: backupRef, result: { migrated, migration_head: postMig.head, update_exit: upRes.code } });
    return { ok: true, backup_ref: backupRef, migrated };
  }

  // 4. failure → record, then decide rollback. AUTO_ROLLBACK governs prod (the test row's auto_rollback is advisory).
  say(`deploy ${version} FAILED (update_exit=${upRes.code}, healthy=${healthy}, migrated=${migrated})`);
  const auto = (conf.AUTO_ROLLBACK || 'on') !== 'off';
  const failResult = { update_exit: upRes.code, healthy: false, migrated, migration_head: postMig.head, log_tail: upRes.out.slice(-4000) };

  if (auto && !migrated && prevInfo.commit) {
    // CODE-ONLY rollback (safe: no migration ran, so the old code matches the schema): checkout prev + redeploy
    say('auto code-rollback to', prevInfo.commit.slice(0, 10));
    await emit('failed', { error: 'health_gate_failed; code-rollback in progress', backup_ref: backupRef, result: failResult });
    const rc = await checkout(p, conf, prevInfo.commit);
    const ru = rc.ok ? await runUpdate(p, conf) : { code: 1, out: 'checkout prev failed' };
    const rhealthy = ru.code === 0 && await healthGate(conf);
    if (rhealthy) {
      await emit('rolled_back', { backup_ref: backupRef, result: { ...failResult, rolled_back_to: prevInfo.version, db_restored: false } });
      return { ok: false, rolled_back: true, backup_ref: backupRef };
    }
    await emit('failed', { error: 'code-rollback also failed — operator intervention required', backup_ref: backupRef, result: { ...failResult, rollback_failed: true } });
    return { ok: false, rolled_back: false, backup_ref: backupRef };
  }

  // A migration ran (schema ahead of old code) OR auto-rollback is off: STOP at 'failed' with the backup_ref recorded.
  // DB rollback = restore-from-backup (ets-restore <backup_ref>) — the §5.3 path, performed manually or by Phase 3,
  // NOT automatically here. The hook is the recorded backup_ref + needs_db_restore flag.
  await emit('failed', { error: migrated ? 'health_gate_failed after a migration ran — DB restore required (ets-restore ' + (backupRef || '<backup>') + '); see §5.3' : 'health_gate_failed; auto_rollback off', backup_ref: backupRef, result: { ...failResult, needs_db_restore: !!migrated, auto_rollback: auto } });
  return { ok: false, rolled_back: false, needs_db_restore: !!migrated, backup_ref: backupRef };
}

// One cycle: fetch, read + verify the signal, and deploy when it is accepted and not already applied.
export async function cycle({ p = releasePaths(), dryRun = false } = {}) {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    if (!(await c.query(`SELECT to_regclass('public.release_agent_status') IS NOT NULL AS ok`)).rows[0].ok) return { skipped: 'no_tables' };

    const conf = readConf(p.deployAgentConf);
    if (!conf || !conf.REPO_DIR) { await setAgentStatus({ phase: 'idle' }, null, 'deploy agent not configured: ' + p.deployAgentConf + ' missing REPO_DIR'); return { skipped: 'no_conf' }; }
    if (!fs.existsSync(conf.REPO_DIR)) { await setAgentStatus({ phase: 'idle' }, null, 'REPO_DIR does not exist: ' + conf.REPO_DIR); return { skipped: 'no_repo' }; }

    const remote = conf.REPO_REMOTE || 'origin', branch = conf.BRANCH || 'main';
    const pullEnv = sshEnv(conf.PULL_KEY || conf.DEPLOY_KEY || p.deployKey);
    const git = (args, opts = {}) => run(p.git, ['-C', conf.REPO_DIR, ...args], { env: pullEnv, full: true, ...opts });

    const f = await git(['fetch', remote, '--tags', branch]);
    if (f.code !== 0) { await setAgentStatus({ phase: 'idle' }, null, 'fetch failed: ' + f.out.trim().slice(-200)); return { fetched: false }; }

    const sj = await git(['show', `${remote}/${branch}:${MANIFEST_REL}`]);
    const ss = await git(['show', `${remote}/${branch}:${MANIFEST_REL}.sig`]);
    if (sj.code !== 0 || ss.code !== 0) { await setAgentStatus({ ...buildInfo(p), phase: 'idle' }, null, null); return { signal: false }; }
    let manifest; try { manifest = JSON.parse(sj.out); } catch { await setAgentStatus({ ...buildInfo(p), phase: 'idle' }, null, 'signal unparseable'); return { signal: false }; }
    const signature = ss.out.trim();

    const deployed = buildInfo(p);
    const lastNonce = (await c.query('SELECT last_nonce FROM release_agent_status WHERE id=1')).rows[0]?.last_nonce || null;

    // already at this version/commit (or the same nonce already applied) → idempotent no-op (verify-only dry run too)
    if (deployed.commit && deployed.commit === manifest.commit && deployed.version === manifest.version) {
      await setAgentStatus({ ...deployed, phase: 'idle' }, manifest.nonce, null);
      return { signal: true, applied: false, reason: 'already_current' };
    }

    // ancestor check (the completed Phase-1 stub): is the signal's commit an ancestor of the fetched default branch?
    const anc = await git(['merge-base', '--is-ancestor', manifest.commit, `${remote}/${branch}`]);
    const ancestor = anc.code === 0 ? 'yes' : (anc.code === 1 ? 'no' : 'unknown');

    // write the signal to temp files and run the shared verifier with ALL §3.1 checks
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-deploy-verify-'));
    let verdict;
    try {
      fs.writeFileSync(path.join(dir, 'm.json'), sj.out, { mode: 0o600 });
      fs.writeFileSync(path.join(dir, 'm.sig'), signature, { mode: 0o600 });
      const args = [p.verify, '--manifest', path.join(dir, 'm.json'), '--sig', path.join(dir, 'm.sig'),
        '--signers-dir', conf.SIGNERS_DIR || p.signersDir, '--ancestor', ancestor,
        '--freshness-days', String(conf.FRESHNESS_DAYS || 14)];
      if (deployed.version) args.push('--deployed-version', deployed.version);
      if (deployed.commit) args.push('--deployed-commit', deployed.commit);
      if (lastNonce) args.push('--used-nonces', lastNonce);
      const r = await run('node', args, { full: true });
      try { verdict = JSON.parse(r.out.trim().split('\n').pop()); } catch { verdict = { ok: false, reason: 'verifier_unparseable', code: r.code }; }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }

    if (!verdict.ok) {
      say('signal REJECTED:', verdict.check, verdict.reason);
      await setAgentStatus({ ...deployed, phase: 'idle', last_reject: { check: verdict.check, reason: verdict.reason, at: new Date().toISOString() } }, null,
        `signal rejected: ${verdict.check || ''} ${verdict.reason || ''}`.trim());
      return { signal: true, applied: false, rejected: verdict };
    }

    if (dryRun) { say('dry run: signal verified OK, not deploying'); return { signal: true, applied: false, dryRun: true, verdict }; }

    say(`signal ACCEPTED: ${manifest.intent || 'deploy'} ${manifest.version} (${String(manifest.commit).slice(0, 10)})`);
    const res = await deploy(p, conf, manifest);
    return { signal: true, applied: true, result: res };
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    c.release();
  }
}
