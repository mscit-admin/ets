// The TEST-side root release agent ets-release-publisher (1.12.19, PHASE 2) — backend/scripts/release-publisher.js,
// run by ets-release-publisher.service every 60 s (ets-release-publisher.timer) and at once when the API touches
// /var/lib/ets/inbox/.release-wake (ets-release-publisher.path). Mirrors the backup agent's shape exactly: the API
// (user ets, UNPRIVILEGED) only records a SIGNED promotion INTENT (a release_promotions row, status 'requested');
// this agent (ROOT) re-reads it, re-verifies the signature against the allow-listed signers, creates/pushes the
// annotated signed tag v<version>, writes + pushes the signed manifest deploy/production-release.json(+.sig) via a
// write-restricted deploy key, marks the row 'publishing', and pulls back the signed production-status.json so the
// admin screen learns production's progress. Commands run WITHOUT a shell (argument arrays); only the two signal
// files may be written in the repo (deployWritable/publisherWritable allow-list).
//
// OPERATOR-VERIFIED: the real git tag/push/pull happen only on the test server with the deploy key and signing key
// provisioned per docs/handover/13 §8a — this logic cannot be exercised end-to-end in the dev sandbox.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pool, query } from '../db/pool.js';
import { releaseNotifyStage } from '../services/release.js';
import { releaseEvent } from '../services/notify-events.js';
import { releasePaths, publisherWritable, writeAllowed, readConf, run } from './agent-util.js';

export const LOCK_KEY = 'ets_release_publisher';
const say = (...a) => console.log(new Date().toISOString(), 'publisher', ...a);
const MANIFEST_REL = 'deploy/production-release.json';
const STATUS_REL = 'deploy/production-status.json';

// GIT_SSH_COMMAND that pins the write-restricted deploy key (no agent, no other identities). Used for push only; the
// fetch of a public repo needs no key. The key is a root-600 file never in the repo.
function sshEnv(keyFile) {
  if (!keyFile || !fs.existsSync(keyFile)) return {};
  return { GIT_SSH_COMMAND: `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
}

async function setRow(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  await query(`UPDATE release_promotions SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
    [id, ...keys.map(k => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]))]).catch(() => {});
}
async function applyError(msg) {
  await query(`INSERT INTO release_agent_status(id, apply_error, updated_at) VALUES (1,$1,now())
    ON CONFLICT (id) DO UPDATE SET apply_error=$1, updated_at=now()`, [msg]).catch(() => {});
}

// Verify a signed manifest/status object against a *.pub allow-list by shelling out to the shared verify.mjs helper —
// the SAME code path the production agent uses, so there is one authoritative verifier. Writes the object + sig to
// temp files, runs the helper, returns its parsed JSON result.
async function verifyWithHelper(p, obj, signature, signersDir, extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-rel-verify-'));
  try {
    const mf = path.join(dir, 'm.json'), sf = path.join(dir, 'm.sig');
    fs.writeFileSync(mf, JSON.stringify(obj), { mode: 0o600 });
    fs.writeFileSync(sf, String(signature), { mode: 0o600 });
    const r = await run('node', [p.verify, '--manifest', mf, '--sig', sf, '--signers-dir', signersDir, ...extra], { full: true });
    let out = null; try { out = JSON.parse(r.out.trim().split('\n').pop()); } catch { /* unparseable */ }
    return out || { ok: false, reason: 'verifier_unparseable', code: r.code };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Push the signal: create the annotated signed tag v<version> if missing, write the manifest + sig into the repo,
// commit and push the branch + tag with the deploy key. Returns { ok, tag_created, error }.
async function publish(p, conf, row) {
  const repo = conf.REPO_DIR;
  const remote = conf.REPO_REMOTE || 'origin';
  const branch = conf.BRANCH || 'main';
  const env = sshEnv(conf.DEPLOY_KEY || p.deployKey);
  const git = (args, opts = {}) => run(p.git, ['-C', repo, ...args], { env, full: true, ...opts });

  // fresh, fast-forwardable branch tip (never lose local edits — the signal files are the only tracked changes we make)
  let r = await git(['fetch', remote, '--tags', branch]);
  if (r.code !== 0) return { ok: false, error: 'fetch_failed: ' + r.out.trim().slice(-300) };
  r = await git(['checkout', branch]); if (r.code !== 0) return { ok: false, error: 'checkout_branch_failed: ' + r.out.trim().slice(-300) };
  r = await git(['reset', '--hard', `${remote}/${branch}`]); if (r.code !== 0) return { ok: false, error: 'reset_failed: ' + r.out.trim().slice(-300) };

  // the commit the version resolves to must already be on the branch (it is a released commit)
  const commit = row.commit;
  const anc = await git(['merge-base', '--is-ancestor', commit, `${remote}/${branch}`]);
  if (anc.code !== 0) return { ok: false, error: 'commit_not_on_branch' };

  // annotated, signed tag v<version> (the confirmed decision). Skip if it already exists; push it.
  let tagCreated = false;
  const tag = `v${row.version}`;
  const have = await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`]);
  if (have.code !== 0) {
    const signFlag = (conf.TAG_SIGN || 'on') === 'off' ? '-a' : '-s';
    r = await git(['tag', signFlag, '-m', `ETS ${row.version}`, tag, commit]);
    if (r.code !== 0) {
      if (signFlag === '-s') return { ok: false, error: 'tag_sign_failed (configure git user.signingkey / gpg, or set TAG_SIGN=off): ' + r.out.trim().slice(-200) };
      return { ok: false, error: 'tag_failed: ' + r.out.trim().slice(-200) };
    }
    tagCreated = true;
  }
  r = await git(['push', remote, `refs/tags/${tag}`]);
  if (r.code !== 0) return { ok: false, error: 'tag_push_failed: ' + r.out.trim().slice(-300) };

  // write the signed manifest (+ detached sig) — only these two files are writable in the repo
  const allow = publisherWritable(p, repo);
  writeAllowed(allow, path.join(repo, MANIFEST_REL), JSON.stringify(row.manifest, null, 2) + '\n', 0o644);
  writeAllowed(allow, path.join(repo, MANIFEST_REL) + '.sig', String(row.signature) + '\n', 0o644);

  // verify the freshly written files with the shared helper before pushing — never push a signal we cannot verify
  const v = await verifyWithHelper(p, row.manifest, row.signature, p.signersDir, ['--ancestor', 'yes']);
  if (!v.ok) return { ok: false, error: `self_verify_failed: ${v.check || ''} ${v.reason || ''}`.trim() };

  r = await git(['add', '--', MANIFEST_REL, MANIFEST_REL + '.sig']); if (r.code !== 0) return { ok: false, error: 'git_add_failed' };
  // nothing to commit (idempotent re-run with the same signal) is success
  const st = await git(['status', '--porcelain', '--', MANIFEST_REL, MANIFEST_REL + '.sig']);
  if (st.out.trim()) {
    r = await git(['-c', `user.name=${conf.GIT_NAME || 'ETS release publisher'}`, '-c', `user.email=${conf.GIT_EMAIL || 'release@ets.local'}`,
      'commit', '-m', `release: publish production signal ${row.version} (${String(row.nonce).slice(0, 10)})`, '--', MANIFEST_REL, MANIFEST_REL + '.sig']);
    if (r.code !== 0) return { ok: false, error: 'commit_failed: ' + r.out.trim().slice(-300) };
    r = await git(['push', remote, `HEAD:${branch}`]);
    if (r.code !== 0) return { ok: false, error: 'push_failed (non-fast-forward? rerun to re-fetch): ' + r.out.trim().slice(-300) };
  }
  return { ok: true, tag, tag_created: tagCreated };
}

// Pull the signed production-status.json back and, when its signature verifies against the allow-listed PROD status
// key, update release_agent_status (what production is running) and — when its nonce matches an open row — that row.
async function pullStatus(p, conf) {
  const repo = conf.REPO_DIR;
  const remote = conf.REPO_REMOTE || 'origin';
  const branch = conf.BRANCH || 'main';
  const env = sshEnv(conf.DEPLOY_KEY || p.deployKey);
  const git = (args) => run(p.git, ['-C', repo, ...args], { env, full: true });

  await git(['fetch', remote, branch]);
  const sj = await git(['show', `${remote}/${branch}:${STATUS_REL}`]);
  const ss = await git(['show', `${remote}/${branch}:${STATUS_REL}.sig`]);
  if (sj.code !== 0 || ss.code !== 0) return { pulled: false, reason: 'no_status_file_yet' };
  let status; try { status = JSON.parse(sj.out); } catch { return { pulled: false, reason: 'status_unparseable' }; }
  const signersDir = conf.STATUS_SIGNERS_DIR || p.statusSignersDir;
  const v = await verifyWithHelper(p, status, ss.out.trim(), signersDir, ['--mode', 'signature']);
  if (!v.ok) { say('production status REJECTED:', v.reason); return { pulled: false, reason: v.reason }; }

  await query(`INSERT INTO release_agent_status(id, data, last_nonce, agent_seen_at, apply_error, updated_at)
    VALUES (1,$1,$2,$3,NULL,now())
    ON CONFLICT (id) DO UPDATE SET data=$1, last_nonce=$2, agent_seen_at=$3, apply_error=NULL, updated_at=now()`,
  [JSON.stringify({ version: status.version || null, commit: status.commit || null, deployed_at: status.deployed_at || status.issued_at || null,
    phase: status.phase || null, last_result: status.result || null }),
  status.nonce || null, status.issued_at || new Date().toISOString()]);

  // map the prod phase onto the open test row with the same nonce (status CHECK: requested/publishing/deploying/…)
  if (status.nonce) {
    const row = (await query(`SELECT id, status, version, intent, prev_version FROM release_promotions WHERE nonce=$1 ORDER BY id DESC LIMIT 1`, [status.nonce])).rows[0];
    if (row && !['succeeded', 'failed', 'rolled_back', 'cancelled'].includes(row.status)) {
      const PHASE_TO_STATUS = { pulled: 'deploying', backing_up: 'deploying', deploying: 'deploying', verifying: 'deploying',
        succeeded: 'succeeded', failed: 'failed', rolled_back: 'rolled_back' };
      const next = PHASE_TO_STATUS[status.phase] || row.status;
      const terminal = ['succeeded', 'failed', 'rolled_back'].includes(next);
      await setRow(row.id, { status: next, progress: { phase: status.phase || null, prod: status.progress || null },
        result: status.result || null, backup_ref: status.backup_ref || null, error: status.error || null,
        ...(terminal ? { finished_at: new Date() } : {}) });
      // S-REL (S12): alert admins on a terminal transition (succeeded / failed / rolled_back). The started alert was
      // sent by the API; the pure releaseNotifyStage() decides which hop warrants an alert.
      const stage = releaseNotifyStage(row.status, next);
      if (stage) await releaseEvent(stage, { id: Number(row.id), version: row.version, intent: row.intent,
        prev_version: row.prev_version, backup_ref: status.backup_ref || null, error: status.error || null,
        result: status.result || null });
    }
  }
  return { pulled: true, version: status.version, phase: status.phase };
}

// One cycle. Picks at most one 'requested' row, publishes it, then pulls the status back. → summary object.
export async function cycle({ p = releasePaths(), maxRows = 5 } = {}) {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    if (!(await c.query(`SELECT to_regclass('public.release_promotions') IS NOT NULL AS ok`)).rows[0].ok) return { skipped: 'no_tables' };

    const conf = readConf(p.publisherConf);
    if (!conf || !conf.REPO_DIR) { await applyError('publisher not configured: ' + p.publisherConf + ' missing REPO_DIR'); return { skipped: 'no_conf' }; }
    if (!fs.existsSync(conf.REPO_DIR)) { await applyError('REPO_DIR does not exist: ' + conf.REPO_DIR); return { skipped: 'no_repo' }; }

    let published = 0;
    for (let i = 0; i < maxRows; i++) {
      const row = (await c.query(`SELECT * FROM release_promotions WHERE status='requested' ORDER BY id LIMIT 1`)).rows[0];
      if (!row) break;
      if (!row.manifest || !row.signature) { await setRow(row.id, { status: 'failed', error: 'row has no signed manifest', finished_at: new Date() }); continue; }
      say(`row ${row.id}: ${row.intent} ${row.version} (${String(row.commit).slice(0, 10)})`);
      await setRow(row.id, { status: 'publishing', progress: { phase: 'publishing' } });
      let res;
      try { res = await publish(p, conf, row); }
      catch (e) { res = { ok: false, error: String(e.message || e).slice(0, 300) }; }
      if (res.ok) {
        say(`row ${row.id}: published (tag ${res.tag}${res.tag_created ? ' created' : ' existed'})`);
        await setRow(row.id, { status: 'publishing', signer: row.signer, progress: { phase: 'published', tag: res.tag, pushed_at: new Date().toISOString() } });
        published++;
      } else {
        say(`row ${row.id}: publish FAILED: ${res.error}`);
        await setRow(row.id, { status: 'failed', error: String(res.error).slice(0, 500), finished_at: new Date(), progress: { phase: 'publish_failed' } });
      }
    }

    let pulled = null;
    try { pulled = await pullStatus(p, conf); } catch (e) { say('status pull error:', e.message); }
    return { published, pulled };
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    c.release();
  }
}

export { verifyWithHelper };
