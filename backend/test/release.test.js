// Release promotion (1.12.18, PHASE 1): the PURE manifest + Ed25519 sign/verify logic (services/release.js) with the
// happy path and EVERY rejection case (bad signer, tampered manifest, unknown commit, downgrade, stale, replayed
// nonce, prev mismatch), and the API of Settings → «الترقية والنشر» (/api/release): the admin gate, the password + OTP
// re-authentication, the confirmation step, version validation, that /promote writes a 'requested' row with a VALID
// signed manifest, the status/history shape, one-in-flight, and the per-admin rate limit. No real deploy happens.
// The API tests need TEST_DATABASE_URL like api.test.js (the public schema of that database is DROPPED and recreated).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as R from '../src/services/release.js';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const COMMIT = 'a587e3d' + 'b'.repeat(33);          // a well-formed 40-hex commit for the pure tests
const PREV_COMMIT = '6483caa' + 'c'.repeat(33);

// an ephemeral Ed25519 key pair (never committed; in production the key is a root-owned file, §8a.1)
const kp = crypto.generateKeyPairSync('ed25519');
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' });
const KID = R.keyId(PUB);

// build + sign a fresh, valid manifest, and the options under which it verifies OK
function signed(over = {}) {
  const manifest = R.buildManifest({
    version: '1.12.17', commit: COMMIT, prevVersion: '1.12.16', prevCommit: PREV_COMMIT, intent: 'deploy',
    authorizer: { user: 'root', name: 'Root', at: new Date().toISOString() }, nonce: R.newNonce(), issuedAt: new Date().toISOString(), ...over,
  });
  const s = R.signManifest(manifest, PRIV);
  return { manifest: s.manifest, signature: s.signature };
}
const okOpts = () => ({ allowedSigners: [{ key_id: KID, publicKey: PUB }], deployed: { version: '1.12.16', commit: PREV_COMMIT },
  knownCommits: new Set([COMMIT]), now: Date.now(), freshnessDays: 14, usedNonces: new Set() });

// ================================================================= pure sign / verify
test('release: key id is derived from the public key; private→public round-trips', () => {
  assert.match(KID, /^[0-9a-f]{16}$/);
  assert.equal(R.keyId(R.publicFromPrivate(PRIV)), KID);
});

test('release: build canonicalizes, sign stamps the signer, verify is happy for a valid manifest', () => {
  const { manifest, signature } = signed();
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.signer_key_id, KID);
  // canonical bytes are sorted-key JSON (stable regardless of insertion order)
  assert.equal(R.manifestBytes(manifest).toString('utf8'), R.manifestBytes({ ...manifest }).toString('utf8'));
  assert.ok(R.verifySignature(manifest, signature, PUB));
  assert.deepEqual(R.verifyManifest({ manifest, signature }, okOpts()), { ok: true });
});

test('release: build refuses a malformed manifest (bad version/commit/nonce/intent)', () => {
  const base = { version: '1.12.17', commit: COMMIT, authorizer: { user: 'r' }, nonce: R.newNonce() };
  assert.throws(() => R.buildManifest({ ...base, version: '1.12' }), /invalid_version/);
  assert.throws(() => R.buildManifest({ ...base, commit: 'xyz' }), /invalid_commit/);
  assert.throws(() => R.buildManifest({ ...base, nonce: 'short' }), /invalid_nonce/);
  assert.throws(() => R.buildManifest({ ...base, intent: 'delete' }), /invalid_intent/);
  assert.throws(() => R.buildManifest({ ...base, authorizer: null }), /invalid_authorizer/);
});

test('release: REJECT — unknown signer (not on the allow-list)', () => {
  const { manifest, signature } = signed();
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const v = R.verifyManifest({ manifest, signature }, { ...okOpts(), allowedSigners: [{ key_id: R.keyId(other), publicKey: other }] });
  assert.deepEqual(v, { ok: false, check: 'signature', reason: 'unknown_signer' });
});

test('release: REJECT — tampered manifest (signature no longer verifies)', () => {
  const { manifest, signature } = signed();
  const tampered = { ...manifest, version: '1.13.0' };            // change a signed field
  assert.equal(R.verifySignature(tampered, signature, PUB), false);
  const v = R.verifyManifest({ manifest: tampered, signature }, okOpts());
  assert.deepEqual(v, { ok: false, check: 'signature', reason: 'bad_signature' });
  // a signer on the list but the WRONG key → bad_signature as well
  const wrong = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  const v2 = R.verifyManifest({ manifest, signature }, { ...okOpts(), allowedSigners: [{ key_id: KID, publicKey: wrong }] });
  assert.deepEqual(v2, { ok: false, check: 'signature', reason: 'bad_signature' });
});

test('release: REJECT — commit not a known release (format ok, membership fails); format too', () => {
  const { manifest, signature } = signed();
  assert.deepEqual(R.verifyManifest({ manifest, signature }, { ...okOpts(), knownCommits: new Set(['d'.repeat(40)]) }),
    { ok: false, check: 'commit', reason: 'unknown_commit' });
  assert.equal(R.checkCommit({ commit: 'nothex' }), 'bad_commit_format');
  assert.equal(R.checkCommit({ commit: COMMIT }), null);          // no knownCommits → format only passes
});

test('release: REJECT — downgrade (version not strictly newer than deployed)', () => {
  const { manifest, signature } = signed({ version: '1.12.16' });
  const v = R.verifyManifest({ manifest, signature }, { ...okOpts(), knownCommits: new Set([manifest.commit]) });
  assert.deepEqual(v, { ok: false, check: 'version', reason: 'downgrade' });
  // equal version is also a downgrade; a rollback intent to an older matching prev is allowed
  assert.equal(R.checkVersion({ version: '1.12.16', intent: 'deploy' }, { version: '1.12.16' }), 'downgrade');
  assert.equal(R.checkVersion({ version: '1.12.15', intent: 'rollback' }, { version: '1.12.16', prev_version: '1.12.15' }), null);
  assert.equal(R.checkVersion({ version: '1.12.14', intent: 'rollback' }, { version: '1.12.16', prev_version: '1.12.15' }), 'rollback_prev_mismatch');
  assert.equal(R.checkVersion({ version: '1.13.0', intent: 'deploy' }, null), null);   // nothing deployed yet: any version ok
});

test('release: REJECT — stale manifest and a replayed nonce', () => {
  const { manifest, signature } = signed();
  const old = R.verifyManifest({ manifest, signature }, { ...okOpts(), now: Date.parse(manifest.issued_at) + 15 * 864e5 });
  assert.deepEqual(old, { ok: false, check: 'freshness', reason: 'stale' });
  const replay = R.verifyManifest({ manifest, signature }, { ...okOpts(), usedNonces: new Set([manifest.nonce]) });
  assert.deepEqual(replay, { ok: false, check: 'freshness', reason: 'replayed_nonce' });
  assert.equal(R.checkFreshness({ issued_at: 'not-a-date', nonce: 'x' }), 'bad_issued_at');
});

test('release: REJECT — prev mismatch (manifest authored against a different deployed commit)', () => {
  const { manifest, signature } = signed();
  const v = R.verifyManifest({ manifest, signature }, { ...okOpts(), deployed: { version: '1.12.16', commit: 'e'.repeat(40) } });
  assert.deepEqual(v, { ok: false, check: 'prev', reason: 'prev_mismatch' });
  assert.equal(R.checkPrev({ prev_commit: PREV_COMMIT }, null), null);   // first deploy: nothing deployed, skipped
});

// ================================================================= Phase 3: pure deploy-decision logic
test('release: evaluateHealth — all required probes pass → passed', () => {
  const v = R.evaluateHealth([{ name: 'http_health', ok: true, detail: '200' }, { name: 'db_reachable', ok: true }, { name: 'migrations_applied', ok: true }]);
  assert.equal(v.passed, true);
  assert.deepEqual(v.failed, []);
  assert.match(v.summary, /passed/);
});
test('release: evaluateHealth — a failed probe fails the gate and names the check', () => {
  const v = R.evaluateHealth([{ name: 'http_health', ok: false, detail: 'curl exit 7' }, { name: 'db_reachable', ok: true }]);
  assert.equal(v.passed, false);
  assert.deepEqual(v.failed, ['http_health']);
  assert.match(v.summary, /http_health/);
  assert.equal(v.checks[0].detail, 'curl exit 7');
});
test('release: evaluateHealth — no probes, or a required probe not run, is a failure', () => {
  assert.equal(R.evaluateHealth([]).passed, false);
  const v = R.evaluateHealth([{ name: 'http_health', ok: true }], { required: ['http_health', 'db_reachable'] });
  assert.equal(v.passed, false);
  assert.deepEqual(v.missing, ['db_reachable']);
  assert.match(v.summary, /db_reachable \(not run\)/);
});

test('release: rollbackDecision — full decision table (every branch)', () => {
  // healthy → none
  assert.equal(R.rollbackDecision({ health_passed: true, auto_rollback: true, migration_ran: true }).action, 'none');
  // unhealthy + no migration + auto + prev commit → code_rollback
  const cr = R.rollbackDecision({ health_passed: false, auto_rollback: true, migration_ran: false, prev_commit: 'a'.repeat(40) });
  assert.equal(cr.action, 'code_rollback');
  assert.equal(cr.needs_db_restore, false);
  // unhealthy + migration ran → stop_needs_db_restore (even with auto on) + the exact ets-restore command
  const dbr = R.rollbackDecision({ health_passed: false, auto_rollback: true, migration_ran: true, backup_ref: 'ets-2026.tar.age', prev_commit: 'a'.repeat(40) });
  assert.equal(dbr.action, 'stop_needs_db_restore');
  assert.equal(dbr.needs_db_restore, true);
  assert.equal(dbr.restore_command, 'ets-restore ets-2026.tar.age');
  // auto_rollback off (no migration) → stop
  const off = R.rollbackDecision({ health_passed: false, auto_rollback: false, migration_ran: false, prev_commit: 'a'.repeat(40) });
  assert.equal(off.action, 'stop');
  assert.equal(off.reason, 'auto_rollback_off');
  // auto on but nothing to roll back to (first deploy) → stop
  assert.equal(R.rollbackDecision({ health_passed: false, auto_rollback: true, migration_ran: false, prev_commit: null }).action, 'stop');
  // stop_needs_db_restore with no backup_ref still gives a usable command placeholder
  assert.equal(R.rollbackDecision({ health_passed: false, migration_ran: true }).restore_command, 'ets-restore <backup_ref>');
});

test('release: releaseNotifyStage fires only on terminal transitions', () => {
  assert.equal(R.releaseNotifyStage('deploying', 'succeeded'), 'succeeded');
  assert.equal(R.releaseNotifyStage('deploying', 'failed'), 'failed');
  assert.equal(R.releaseNotifyStage('failed', 'rolled_back'), 'rolled_back');
  assert.equal(R.releaseNotifyStage('requested', 'publishing'), null);   // non-terminal hop
  assert.equal(R.releaseNotifyStage('succeeded', 'succeeded'), null);    // no change
  assert.equal(R.releaseStageSeverity('failed'), 'critical');
  assert.equal(R.releaseStageSeverity('rolled_back'), 'critical');
  assert.equal(R.releaseStageSeverity('started'), 'info');
  assert.equal(R.releaseStageSeverity('succeeded'), 'info');
});

// ================================================================= API
let server, base, pool, ids = {}, totp, cryptoSvc, KEYDIR;
before(async () => {
  if (skip) return;
  KEYDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-rel-'));
  const keyFile = path.join(KEYDIR, 'release-sign.key');
  const trust = path.join(KEYDIR, 'trust');
  fs.mkdirSync(trust, { recursive: true });
  fs.writeFileSync(keyFile, PRIV, { mode: 0o600 });
  fs.writeFileSync(path.join(trust, 'release.pub'), PUB);
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
    ETS_RELEASE_SIGN_KEY: keyFile, ETS_RELEASE_SIGNERS_DIR: trust, ETS_RELEASE_PROMOTE_LIMIT: '8',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  for (const [u, role] of [['root', 'admin'], ['root2', 'admin'], ['pm1', 'pm'], ['twofa', 'admin']]) {
    ids[u] = (await pool.query(`INSERT INTO users(username, full_name, password_hash, role_id, must_change_password, language)
      VALUES ($1,$2,$3,$4,false,'ar') RETURNING id`, [u, 'User ' + u, h, role])).rows[0].id;
  }
  await pool.query(`INSERT INTO user_permission_overrides(user_id, permission, granted) VALUES ($1,'cfg',true)`, [ids.pm1]).catch(() => {});
  // production is recorded as running 1.12.16 (so 1.12.17 is a valid, newer promotion with a known prev)
  await pool.query(`INSERT INTO release_agent_status(id, data, agent_seen_at) VALUES (1,$1,now())
    ON CONFLICT (id) DO UPDATE SET data=$1, agent_seen_at=now()`,
  [JSON.stringify({ version: '1.12.16', commit: 'f'.repeat(40), deployed_at: '2026-10-20T10:00:00Z' })]);
  totp = await import('../src/services/totp.js');
  cryptoSvc = await import('../src/services/crypto.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
  if (skip) return;
  server.closeAllConnections?.(); server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
  fs.rmSync(KEYDIR, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}, h) => call('POST', p, b, h),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }) };
}
const as = async u => { const c = client(); assert.equal((await c.login(u)).status, 200, 'login ' + u); return c; };
const PW = { password: 'Passw0rd-123' };

test('release API: administrators only — signed-out 401, a cfg override is not admin 403, admin 200', { skip }, async () => {
  assert.equal((await client().get('/release/status')).status, 401);
  assert.equal((await client().get('/release/versions')).status, 401);
  const pm = await as('pm1');
  assert.equal((await pm.get('/release/status')).status, 403);
  assert.equal((await pm.get('/release/versions')).status, 403);
  assert.equal((await pm.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW })).status, 403);
  const root = await as('root');
  assert.equal((await root.get('/release/status')).status, 200);
});

test('release API: /versions lists promotable versions with commit + what-changed, and current state', { skip }, async () => {
  const root = await as('root');
  const v = (await root.get('/release/versions')).data;
  assert.equal(v.phase, 3);
  assert.equal(v.production.version, '1.12.16');
  assert.equal(v.signing_ready, true);
  const e = v.versions.find(x => x.version === '1.12.17');
  assert.ok(e, '1.12.17 is listed');
  assert.match(e.commit, /^[0-9a-f]{40}$/);
  assert.equal(e.promotable, true);
  assert.ok(e.summary && e.summary.length > 0, 'what-changed summary present');
  assert.ok(['tag', 'release_commit'].includes(e.commit_source));
});

test('release API: /promote needs re-auth + confirm, validates the version, writes a signed requested row', { skip }, async () => {
  const root = await as('root');
  // unknown version → 400
  assert.equal((await root.post('/release/promote', { version: '9.9.9', confirm: '9.9.9', ...PW })).status, 400);
  assert.equal((await root.post('/release/promote', { version: 'not-a-version', confirm: 'x', ...PW })).status, 400);
  // confirm phrase must equal the target version
  let r = await root.post('/release/promote', { version: '1.12.17', confirm: 'wrong', ...PW });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'confirmation_phrase_mismatch');
  // re-auth: missing / wrong password refused (checked after confirm)
  r = await root.post('/release/promote', { version: '1.12.17', confirm: '1.12.17' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'wrong_password');
  r = await root.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', password: 'nope' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'wrong_password');
  // happy path: a 'requested' row with prev_* from production and a VALID signed manifest
  r = await root.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', auto_rollback: true, ...PW });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const p = r.data.promotion;
  assert.equal(p.status, 'requested');
  assert.equal(p.version, '1.12.17');
  assert.equal(p.prev_version, '1.12.16');
  assert.equal(p.auto_rollback, true);
  assert.match(p.commit, /^[0-9a-f]{40}$/);
  assert.equal(p.signer, KID);
  // the stored manifest + signature verify under the configured signer key
  const row = (await pool.query('SELECT manifest, signature, signer FROM release_promotions WHERE id=$1', [p.id])).rows[0];
  assert.ok(R.verifySignature(row.manifest, row.signature, PUB), 'stored signature verifies');
  assert.equal(row.manifest.signer_key_id, KID);
  assert.equal(row.manifest.prev_version, '1.12.16');
  assert.equal(row.manifest.intent, 'deploy');
  // no secret (private key) anywhere in the DB
  const all = JSON.stringify((await pool.query('SELECT * FROM release_promotions')).rows);
  assert.ok(!all.includes('PRIVATE KEY') && !all.includes(PRIV.split('\n')[1]), 'the signing key is not stored');
  // a second promotion while one is open → 409 (one in flight)
  const again = await root.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW });
  assert.equal(again.status, 409); assert.equal(again.data.error, 'promotion_in_flight');
  // audit row written
  const au = (await pool.query(`SELECT action, summary FROM audit_log WHERE entity='release_promotion' ORDER BY chain_seq DESC LIMIT 1`)).rows[0];
  assert.equal(au.action, 'release_promote');
  await pool.query('DELETE FROM release_promotions');
});

test('release API: OTP is required when the admin has 2FA on (wrong code refused, nothing written)', { skip }, async () => {
  const c = await as('twofa');
  const secret = totp.generateSecret();
  await pool.query('UPDATE users SET totp_enabled=true, totp_secret=$2, totp_last_step=NULL WHERE id=$1', [ids.twofa, cryptoSvc.encrypt(secret)]);
  let r = await c.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'mfa_code_required');
  r = await c.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW, code: '000000' });
  assert.equal(r.status, 400); assert.equal(r.data.error, 'invalid_code');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM release_promotions')).rows[0].n, 0);
  r = await c.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW, code: totp.totp(secret) });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await pool.query('UPDATE users SET totp_enabled=false, totp_secret=NULL WHERE id=$1', [ids.twofa]);
  await pool.query('DELETE FROM release_promotions');
});

test('release API: /status and /history shape', { skip }, async () => {
  const root = await as('root');
  const r = await root.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW });
  assert.equal(r.status, 202);
  const st = (await root.get('/release/status')).data;
  assert.equal(st.phase, 3);
  assert.equal(st.in_flight, true);
  assert.equal(st.current.version, '1.12.17');
  assert.equal(st.production.version, '1.12.16');
  const h = (await root.get('/release/history')).data;
  assert.ok(Array.isArray(h.promotions) && h.promotions.length >= 1);
  assert.equal(h.promotions[0].version, '1.12.17');
  assert.ok(h.promotions[0].manifest, 'history carries the manifest');
  // the history row exposes the fields the expandable detail view renders
  for (const k of ['progress', 'result', 'backup_ref', 'prev_version', 'authorized_at', 'finished_at']) {
    assert.ok(k in h.promotions[0], `history row carries ${k}`);
  }
  await pool.query('DELETE FROM release_promotions');
  await pool.query(`DELETE FROM notifications WHERE type='release_event'`);
});

test('release API: /promote raises the S-REL (S12) started notification to administrators', { skip }, async () => {
  await pool.query(`DELETE FROM notifications WHERE type='release_event'`);
  const admin = await as('twofa');   // a fresh admin (root's per-hour promote quota is spent by earlier tests)
  const r = await admin.post('/release/promote', { version: '1.12.17', confirm: '1.12.17', ...PW });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const n = (await pool.query(`SELECT user_id, severity, params FROM notifications WHERE type='release_event'`)).rows;
  assert.ok(n.length >= 1, 'a release_event notification was created');
  const mine = n.find(x => x.user_id === ids.twofa);
  assert.ok(mine, 'the admin who promoted is alerted');
  assert.equal(mine.params.stage, 'started');
  assert.equal(mine.params.version, '1.12.17');
  assert.equal(mine.params.intent, 'deploy');
  assert.equal(mine.severity, 'info', 'started is informational (failed/rolled_back are critical)');
  await pool.query('DELETE FROM release_promotions');
  await pool.query(`DELETE FROM notifications WHERE type='release_event'`);
});

test('release API: /promote is rate-limited per administrator', { skip }, async () => {
  const root = await as('root2');
  let last;
  for (let i = 0; i < 12 && last?.status !== 429; i++) {
    last = await root.post('/release/promote', { version: '1.12.17', confirm: 'wrong-' + i });   // 400s still count towards the limit
  }
  assert.equal(last.status, 429);
  await pool.query('DELETE FROM release_promotions');
});
