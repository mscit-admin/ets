// Release manifest verifier (1.12.19, PHASE 2) — the PURE ancestor check completed in services/release.js, and the
// sandbox-testable CLI helper deploy/release/verify.mjs that the two root agents call. Every §3.1 rejection is
// exercised against the real helper process (exit 0 = verified, 1 = rejected, 2 = usage/I-O), with the right
// machine-readable reason, plus the --mode signature back-channel check. No database is needed (pure + process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as R from '../src/services/release.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY = path.resolve(HERE, '../../deploy/release/verify.mjs');
const COMMIT = 'a587e3d' + 'b'.repeat(33);
const PREV_COMMIT = '6483caa' + 'c'.repeat(33);

const kp = crypto.generateKeyPairSync('ed25519');
const PRIV = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB = kp.publicKey.export({ type: 'spki', format: 'pem' });
const KID = R.keyId(PUB);

// ---------------------------------------------------------------- pure: the completed ancestor check
test('release: checkAncestor rejects a non-ancestor, passes an ancestor, skips when unknown', () => {
  assert.equal(R.checkAncestor({ commit: COMMIT }, { isAncestor: false }), 'non_ancestor');
  assert.equal(R.checkAncestor({ commit: COMMIT }, { isAncestor: true }), null);
  assert.equal(R.checkAncestor({ commit: COMMIT }, { isAncestor: null }), null);   // caller cannot evaluate → skipped
  assert.equal(R.checkAncestor({ commit: COMMIT }, {}), null);
  assert.equal(R.checkAncestor({ commit: 'nothex' }, { isAncestor: true }), 'bad_commit_format');
});

test('release: verifyManifest runs the ancestor step between commit and version', () => {
  const m = R.signManifest(R.buildManifest({ version: '1.12.19', commit: COMMIT, prevVersion: '1.12.18', prevCommit: PREV_COMMIT,
    intent: 'deploy', authorizer: { user: 'root', name: 'Root', at: new Date().toISOString() }, nonce: R.newNonce(), issuedAt: new Date().toISOString() }), PRIV);
  const opts = { allowedSigners: [{ key_id: KID, publicKey: PUB }], deployed: { version: '1.12.18', commit: PREV_COMMIT }, usedNonces: new Set() };
  assert.deepEqual(R.verifyManifest(m, { ...opts, isAncestor: true }), { ok: true });
  assert.deepEqual(R.verifyManifest(m, { ...opts, isAncestor: false }), { ok: false, check: 'ancestor', reason: 'non_ancestor' });
  assert.deepEqual(R.verifyManifest(m, opts), { ok: true });   // isAncestor defaults to null → skipped (the test API)
});

// ---------------------------------------------------------------- the verify.mjs CLI helper (the real agents' path)
function fixture(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ets-vmjs-'));
  const trust = path.join(dir, 'trust');
  fs.mkdirSync(trust);
  fs.writeFileSync(path.join(trust, 'release.pub'), PUB);
  const signed = R.signManifest(R.buildManifest({ version: '1.12.19', commit: COMMIT, prevVersion: '1.12.18', prevCommit: PREV_COMMIT,
    intent: 'deploy', authorizer: { user: 'root', name: 'Root', at: new Date().toISOString() }, nonce: R.newNonce(), issuedAt: new Date().toISOString(), ...over }), PRIV);
  fs.writeFileSync(path.join(dir, 'm.json'), JSON.stringify(signed.manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'm.sig'), signed.signature);
  return { dir, trust, manifest: signed.manifest, signature: signed.signature };
}
// run verify.mjs → { code, out } (out = parsed JSON of the last line)
function verify(dir, args, { manifestFile = 'm.json', sigFile = 'm.sig' } = {}) {
  const base = ['--manifest', path.join(dir, manifestFile), '--sig', path.join(dir, sigFile), '--signers-dir', path.join(dir, 'trust')];
  try {
    const out = execFileSync('node', [VERIFY, ...base, ...args], { encoding: 'utf8' });
    return { code: 0, out: JSON.parse(out.trim().split('\n').pop()) };
  } catch (e) {
    const text = String(e.stdout || '').trim();
    let json = null; try { json = JSON.parse(text.split('\n').pop()); } catch { /* none */ }
    return { code: e.status ?? 1, out: json };
  }
}
const OKARGS = ['--deployed-version', '1.12.18', '--deployed-commit', PREV_COMMIT, '--ancestor', 'yes'];

test('verify.mjs: a valid manifest verifies (exit 0, { ok: true })', () => {
  const f = fixture();
  const r = verify(f.dir, OKARGS);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, { ok: true });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: tampered manifest → exit 1, signature/bad_signature', () => {
  const f = fixture();
  const m = { ...f.manifest, version: '1.13.0' };                       // change a signed field after signing
  fs.writeFileSync(path.join(f.dir, 'm.json'), JSON.stringify(m));
  const r = verify(f.dir, OKARGS);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'signature', reason: 'bad_signature' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: unknown signer (allow-list has a different key) → exit 1, unknown_signer', () => {
  const f = fixture();
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  fs.writeFileSync(path.join(f.trust, 'release.pub'), other);           // replace the only trusted key
  const r = verify(f.dir, OKARGS);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'signature', reason: 'unknown_signer' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: non-ancestor commit → exit 1, ancestor/non_ancestor (the completed check)', () => {
  const f = fixture();
  const r = verify(f.dir, ['--deployed-version', '1.12.18', '--deployed-commit', PREV_COMMIT, '--ancestor', 'no']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'ancestor', reason: 'non_ancestor' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: downgrade (version not newer than deployed) → exit 1, version/downgrade', () => {
  const f = fixture({ version: '1.12.17' });
  const r = verify(f.dir, ['--deployed-version', '1.12.18', '--deployed-commit', PREV_COMMIT, '--ancestor', 'yes']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'version', reason: 'downgrade' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: replayed nonce → exit 1, freshness/replayed_nonce', () => {
  const f = fixture();
  const r = verify(f.dir, [...OKARGS, '--used-nonces', f.manifest.nonce]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'freshness', reason: 'replayed_nonce' });
  // and via a @file list
  const nf = path.join(f.dir, 'nonces.txt');
  fs.writeFileSync(nf, 'deadbeef\n' + f.manifest.nonce + '\n');
  const r2 = verify(f.dir, [...OKARGS, '--used-nonces', '@' + nf]);
  assert.equal(r2.code, 1);
  assert.equal(r2.out.reason, 'replayed_nonce');
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: stale manifest (outside the freshness window) → exit 1, freshness/stale', () => {
  const f = fixture({ issuedAt: new Date(Date.now() - 20 * 864e5).toISOString() });
  const r = verify(f.dir, [...OKARGS, '--freshness-days', '14']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'freshness', reason: 'stale' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: prev mismatch (authored against a different deployed commit) → exit 1, prev/prev_mismatch', () => {
  const f = fixture();
  const r = verify(f.dir, ['--deployed-version', '1.12.18', '--deployed-commit', 'e'.repeat(40), '--ancestor', 'yes']);
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, { ok: false, check: 'prev', reason: 'prev_mismatch' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: --mode signature verifies only the signature (status back-channel)', () => {
  const f = fixture();
  // a signed status-like object (not a deploy manifest): signature-only mode ignores version/ancestor/etc.
  const status = R.signManifest({ version: '1.12.19', commit: COMMIT, phase: 'succeeded', issued_at: new Date().toISOString() }, PRIV);
  fs.writeFileSync(path.join(f.dir, 's.json'), JSON.stringify(status.manifest));
  fs.writeFileSync(path.join(f.dir, 's.sig'), status.signature);
  const ok = verify(f.dir, ['--mode', 'signature'], { manifestFile: 's.json', sigFile: 's.sig' });
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.out, { ok: true });
  // tamper the status → rejected
  fs.writeFileSync(path.join(f.dir, 's.json'), JSON.stringify({ ...status.manifest, phase: 'failed' }));
  const bad = verify(f.dir, ['--mode', 'signature'], { manifestFile: 's.json', sigFile: 's.sig' });
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.out, { ok: false, check: 'signature', reason: 'bad_signature' });
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test('verify.mjs: usage / empty allow-list → exit 2', () => {
  const f = fixture();
  fs.rmSync(path.join(f.trust, 'release.pub'));                         // no *.pub in the allow-list
  const r = verify(f.dir, OKARGS);
  assert.equal(r.code, 2);
  assert.match(r.out.reason, /no_signers/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});
