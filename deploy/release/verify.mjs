#!/usr/bin/env node
// ETS release manifest verifier (1.12.19, PHASE 2) — the single authoritative verification entry point the two ROOT
// agents call (ets-release-publisher re-checks before pushing; ets-deploy-agent checks before it would deploy). It
// imports the PURE logic in backend/src/services/release.js — NO crypto is re-implemented in bash — reads a manifest
// file, its detached signature and a directory of allow-listed signer public keys, runs every §3.1 check, prints a
// single-line machine-readable JSON result and exits 0 (verified) / 1 (rejected) / 2 (usage or I/O error).
//
//   node verify.mjs --manifest F --sig F --signers-dir D [options]
//     --deployed-version V --deployed-commit C40 --deployed-prev-version V   current production state (downgrade/prev)
//     --ancestor yes|no|unknown     result of `git merge-base --is-ancestor <commit> <branch>` the CALLER computed
//     --known-commits a,b,...|@file one commit hash per line in @file; membership check (optional)
//     --used-nonces a,b,...|@file   already-applied nonces (replay check)
//     --freshness-days N            replay/staleness window (default 14)
//     --now-ms N                    clock override (tests only)
//     --mode signature              verify ONLY the signature against the allow-list (the status back-channel file,
//                                   which is a signed JSON but not a deploy manifest); skips the deploy-only checks
//   The exact bytes signed are the canonical object; verify reads the JSON back and re-canonicalizes it, so the
//   on-disk formatting does not matter.
import fs from 'node:fs';
import { verifyManifest, checkSignature, keyId } from '../../backend/src/services/release.js';
import { loadSigners } from '../../backend/src/release/agent-util.js';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = true;
    else { o[k] = next; i++; }
  }
  return o;
}
// a,b,c  OR  @path/to/file (one entry per line). → Set of non-empty trimmed entries, or null when absent.
function listArg(v) {
  if (v === undefined) return null;
  let text = String(v);
  if (text.startsWith('@')) text = fs.readFileSync(text.slice(1), 'utf8').split('\n').join(',');
  const items = text.split(',').map(s => s.trim()).filter(Boolean);
  return new Set(items);
}
function fail(code, reason, check = null) {
  process.stdout.write(JSON.stringify(check ? { ok: false, check, reason } : { ok: false, reason }) + '\n');
  process.exit(code);
}

const o = parseArgs(process.argv.slice(2));
if (!o.manifest || !o.sig || !o['signers-dir']) {
  fail(2, 'usage: verify.mjs --manifest F --sig F --signers-dir D [options]');
}

let manifest, signature, allowedSigners;
try { manifest = JSON.parse(fs.readFileSync(o.manifest, 'utf8')); } catch (e) { fail(2, 'manifest_unreadable: ' + e.message); }
try { signature = fs.readFileSync(o.sig, 'utf8').trim(); } catch (e) { fail(2, 'signature_unreadable: ' + e.message); }
allowedSigners = loadSigners(o['signers-dir'], keyId);
if (allowedSigners.length === 0) fail(2, 'no_signers: ' + o['signers-dir'] + ' has no *.pub allow-listed keys');

if (o.mode === 'signature') {
  const reason = checkSignature(manifest, signature, allowedSigners);
  const result = reason ? { ok: false, check: 'signature', reason } : { ok: true };
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exit(result.ok ? 0 : 1);
}

const deployed = (o['deployed-version'] || o['deployed-commit'])
  ? { version: o['deployed-version'] || null, commit: o['deployed-commit'] || null, prev_version: o['deployed-prev-version'] || null }
  : null;
const ancestor = o.ancestor === undefined || o.ancestor === 'unknown' ? null : o.ancestor === 'yes' || o.ancestor === true;

const result = verifyManifest({ manifest, signature }, {
  allowedSigners,
  deployed,
  isAncestor: ancestor,
  knownCommits: listArg(o['known-commits']),
  usedNonces: listArg(o['used-nonces']),
  freshnessDays: o['freshness-days'] ? Math.max(1, Number(o['freshness-days'])) : undefined,
  now: o['now-ms'] ? Number(o['now-ms']) : Date.now(),
});

process.stdout.write(JSON.stringify(result) + '\n');
process.exit(result.ok ? 0 : 1);
