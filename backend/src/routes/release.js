// /api/release — Settings → «الترقية والنشر» / "Release & deploy" (1.12.18, PHASE 1). System administrators only
// (cfg + the admin role), exactly like Settings → «النسخ الاحتياطي». The API runs UNPRIVILEGED and never deploys:
// it records the promotion INTENT (a signed manifest on a release_promotions row) and — in Phase 2 — a root agent
// re-validates, signs, pushes, pulls, backs up, checks out and health-gates. In Phase 1 the agent is MOCKED:
// NOTHING is pushed to git, no tag is created, no checkout or deploy happens. A promotion row is created with status
// 'requested' and a valid signed manifest; Phase 2 wires the real ets-release-publisher / ets-deploy-agent.
//
//   GET  /versions   released versions newer than production (from a signed tag v<x.y.z>, else the `release <x.y.z>`
//                     commit + CHANGELOG), each with its commit and what-changed summary; current prod + test state
//   GET  /status      the current / last promotion and the (Phase 2) agent heartbeat
//   GET  /history     past promotions, newest first (the operator audit view)
//   POST /promote     admin + re-auth (password + OTP) + confirm + rate-limit → writes a 'requested' row with a signed
//                     manifest (MOCKED: no real deploy). prev_* come from the recorded production version.
//   POST /rollback    admin + re-auth + confirm → records a 'rollback' intent to the previous version (same, MOCKED)
// Every mutation is in the change history (logAudit) with readable sentences; the signing key is never logged or stored.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db/pool.js';
import { config as appConfig } from '../config.js';
import { requireAuth, requirePerm, requireAdmin } from '../middleware/auth.js';
import { HttpError } from '../utils/http.js';
import { logAudit, logSystem } from '../services/logs.js';
import { reauth } from './auth.js';
import { buildManifest, signManifest, newNonce, cmpVersion, keyId } from '../services/release.js';

const r = Router();
r.use(requireAuth, requirePerm('cfg'), requireAdmin);

// The repository working copy this server runs from (routes → src → backend → repo root).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

const perUser = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u:' + req.user.id,
  handler: (req, res) => res.status(429).json({ error: 'too_many_requests', retry_after: Math.ceil(windowMs / 1000) }) });
const promoteLimiter = perUser(+(process.env.ETS_RELEASE_PROMOTE_LIMIT || 10), 60 * 60_000);

// password + OTP again (the exact re-auth the backup restore / escrow flow uses) — reauth() from routes/auth.js
const twoFactor = req => reauth(req, { password: req.body?.password, secondFactor: true,
  events: ['release_reauth_bad_password', 'release_reauth_bad_code'] });

// ---------------------------------------------------------------- git (read-only; argument arrays, no shell)
function git(args) {
  try { return execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
// Resolve a released version to its 40-hex commit. PREFER an annotated tag v<x.y.z> (Phase 2 will also verify the tag
// signature); else fall back to the `release <x.y.z>` commit. Returns null when neither resolves.
function resolveCommit(version) {
  if (!VERSION_RE.test(version)) return null;
  const tag = git(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`]);
  if (tag && COMMIT_RE.test(tag)) return { commit: tag, source: 'tag' };
  const rel = git(['log', '--all', '-n', '1', '--format=%H', `--grep=^release ${version}$`]);
  if (rel && COMMIT_RE.test(rel)) return { commit: rel, source: 'release_commit' };
  return null;
}

// ---------------------------------------------------------------- CHANGELOG (what-changed)
function changelogEntries() {
  let text;
  try { text = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8'); } catch { return []; }
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    const m = /^## \[(\d+\.\d+\.\d+)\]\s*(?:[—-]\s*(\d{4}-\d{2}-\d{2}))?\s*(?:[—-]\s*(.*?))?\s*$/.exec(line);
    if (m) { if (cur) out.push(cur); cur = { version: m[1], date: m[2] || null, title: (m[3] || '').trim(), body: [] }; continue; }
    if (/^## /.test(line)) { if (cur) out.push(cur); cur = null; continue; }   // [Unreleased] or other
    if (cur) cur.body.push(line);
  }
  if (cur) out.push(cur);
  for (const e of out) e.summary = e.body.join('\n').trim();
  return out;
}

// The latest state the (Phase 2) deploy agent reported back: the version/commit production is running.
async function agentStatus() {
  const row = (await query('SELECT data, last_nonce, agent_seen_at, apply_error FROM release_agent_status WHERE id=1')).rows[0];
  return row || { data: {}, last_nonce: null, agent_seen_at: null, apply_error: null };
}
function production(st) {
  const d = st?.data || {};
  return { version: VERSION_RE.test(String(d.version || '')) ? d.version : null,
    commit: COMMIT_RE.test(String(d.commit || '')) ? d.commit : null, deployed_at: d.deployed_at || null,
    stale: !st?.agent_seen_at || Date.now() - new Date(st.agent_seen_at) > 10 * 60_000 };
}

const publicPromotion = p => p && ({
  id: Number(p.id), version: p.version, commit: p.commit, prev_version: p.prev_version, prev_commit: p.prev_commit,
  intent: p.intent, auto_rollback: p.auto_rollback, status: p.status, signer: p.signer, backup_ref: p.backup_ref,
  requested_by: p.requested_by, by_name: p.by_name || null, requested_at: p.requested_at,
  authorized_by: p.authorized_by, authorized_at: p.authorized_at, created_at: p.created_at, updated_at: p.updated_at,
  finished_at: p.finished_at, progress: p.progress || null, result: p.result || null, error: p.error || null,
  manifest: p.manifest || null });

const OPEN = ['requested', 'publishing', 'deploying'];
const signKey = () => { try { return fs.readFileSync(appConfig.release.signKeyFile, 'utf8'); } catch { return null; } };
const signingReady = () => !!signKey();

// Wake the root publisher (ets-release-publisher.path watches /var/lib/ets/inbox/.release-wake); otherwise the timer
// picks the row up within 60 s. A separate wake file from the backup agent's .wake so the two .path units never cross.
const STATE_DIR = process.env.ETS_STATE_DIR || '/var/lib/ets';
function wake() {
  try { fs.writeFileSync(path.join(STATE_DIR, 'inbox', '.release-wake'), String(Date.now()), { mode: 0o600 }); } catch { /* the timer picks it up */ }
}

// ---------------------------------------------------------------- GET /versions
r.get('/versions', async (req, res) => {
  const st = await agentStatus();
  const prod = production(st);
  const entries = changelogEntries();
  const versions = [];
  for (const e of entries) {
    const resolved = resolveCommit(e.version);
    if (!resolved) continue;                                   // only versions whose commit we can resolve are promotable
    const newer = !prod.version || cmpVersion(e.version, prod.version) > 0;
    versions.push({ version: e.version, date: e.date, title: e.title, summary: e.summary,
      commit: resolved.commit, commit_source: resolved.source, promotable: newer });
  }
  res.json({
    phase: 1,
    production: prod,
    test: { version: pkg.version, resolved: resolveCommit(pkg.version)?.commit || null },
    signing_ready: signingReady(),
    versions,   // newest first (CHANGELOG order)
  });
});

// ---------------------------------------------------------------- GET /status
r.get('/status', async (req, res) => {
  const st = await agentStatus();
  const cur = (await query(`SELECT p.*, u.full_name AS by_name FROM release_promotions p LEFT JOIN users u ON u.id=p.requested_by
    ORDER BY p.id DESC LIMIT 1`)).rows[0];
  res.json({
    phase: 1,
    production: production(st),
    agent: { seen_at: st.agent_seen_at || null, ok: !!st.agent_seen_at && Date.now() - new Date(st.agent_seen_at) < 3 * 60_000,
      apply_error: st.apply_error || null },
    current: publicPromotion(cur),
    in_flight: !!cur && OPEN.includes(cur.status),
    signing_ready: signingReady(),
  });
});

// ---------------------------------------------------------------- GET /history
r.get('/history', async (req, res) => {
  const rows = (await query(`SELECT p.*, u.full_name AS by_name FROM release_promotions p LEFT JOIN users u ON u.id=p.requested_by
    ORDER BY p.id DESC LIMIT 50`)).rows.map(publicPromotion);
  res.json({ promotions: rows });
});

// ---------------------------------------------------------------- the shared promote / rollback intent writer
async function recordIntent(req, res, { intent }) {
  const version = String(req.body?.version || '');
  if (!VERSION_RE.test(version)) throw new HttpError(400, 'invalid_version');
  const st = await agentStatus();
  const prod = production(st);

  // resolve the chosen version → commit (prefer tag, else the release commit)
  const resolved = resolveCommit(version);
  if (!resolved) throw new HttpError(400, 'unknown_version', { version });
  const commit = resolved.commit;

  // the version must be one the CHANGELOG knows (a released, reviewed version — not an arbitrary string)
  const entry = changelogEntries().find(e => e.version === version);
  if (!entry) throw new HttpError(400, 'unknown_version', { version });

  // direction checks (also re-checked by the prod agent in Phase 2 — services/release.js verifyManifest)
  if (intent === 'deploy') {
    if (prod.version && cmpVersion(version, prod.version) <= 0) throw new HttpError(409, 'not_newer', { version, production: prod.version });
  } else {
    if (!prod.version || !prod.commit) throw new HttpError(409, 'nothing_to_roll_back');
    if (cmpVersion(version, prod.version) >= 0) throw new HttpError(409, 'rollback_not_older', { version, production: prod.version });
  }

  // the confirmation step: the admin typed the exact target version (like the restore wizard's host-name gate)
  if (String(req.body?.confirm || '') !== version) throw new HttpError(400, 'confirmation_phrase_mismatch');

  // re-authentication: a fresh password + OTP (reuses the backup restore/escrow re-auth)
  await twoFactor(req);

  // sign the manifest with the release private key (root-owned file; never stored or logged). Phase 1 only RECORDS
  // the intent — the signature travels on the row for the Phase 2 publisher to re-use / re-create.
  const key = signKey();
  if (!key) throw new HttpError(503, 'release_signing_unavailable');

  const auto = req.body?.auto_rollback !== false;   // default true
  const nonce = newNonce();
  const authorizedAt = new Date().toISOString();
  let signed;
  try {
    const manifest = buildManifest({
      version, commit, prevVersion: prod.version, prevCommit: prod.commit, intent,
      authorizer: { user: req.user.username, name: req.user.full_name || req.user.username, at: authorizedAt }, nonce, issuedAt: authorizedAt,
    });
    signed = signManifest(manifest, key);
  } catch (e) { throw new HttpError(500, 'manifest_build_failed', { reason: e.message }); }

  let row;
  try {
    row = await tx(async cl => {
      const ins = (await cl.query(`INSERT INTO release_promotions
        (version, commit, prev_version, prev_commit, nonce, intent, auto_rollback, requested_by, authorized_by, authorized_at, signer, manifest, signature, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,'requested') RETURNING *`,
      [version, commit, prod.version, prod.commit, nonce, intent, auto, req.user.id, authorizedAt, signed.signer_key_id,
        JSON.stringify(signed.manifest), signed.signature])).rows[0];
      await logAudit(req, { db: cl, action: intent === 'deploy' ? 'release_promote' : 'release_rollback', entity: 'release_promotion',
        entityId: String(ins.id), summary: `${intent} ${version} (${commit.slice(0, 10)})${prod.version ? ' from ' + prod.version : ''}`,
        newValue: { version, commit, prev_version: prod.version, prev_commit: prod.commit, intent, auto_rollback: auto, signer: signed.signer_key_id, nonce } });
      return ins;
    });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'promotion_in_flight');
    throw e;
  }
  await logSystem('release_requested', `production ${intent} requested: ${version} (${commit.slice(0, 10)})`,
    { promotion_id: Number(row.id), version, commit, intent, by: req.user.username });
  wake();   // Phase 2: ets-release-publisher re-reads, signs, pushes; Phase 1 only records the intent.
  res.status(202).json({ promotion: publicPromotion(row), note: 'Promotion recorded; the root release agents sign, push and deploy it (see docs/handover/13).' });
}

r.post('/promote', promoteLimiter, (req, res) => recordIntent(req, res, { intent: 'deploy' }));
r.post('/rollback', promoteLimiter, (req, res) => recordIntent(req, res, { intent: 'rollback' }));

export const _test = { resolveCommit, changelogEntries, keyId, REPO_ROOT };
export default r;
