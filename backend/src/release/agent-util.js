// Helpers of the two ROOT release agents (1.12.19, PHASE 2): ets-release-publisher (TEST server) and ets-deploy-agent
// (PRODUCTION server). Mirrors backend/src/backup/agent-util.js: fixed paths from the environment / conf files, an
// allow-list of the ONLY files an agent may write, commands started WITHOUT a shell (argument arrays), and small file
// utilities. The generic, proven helpers (run, writeAtomic, writeJson, readText, readJsonFile, sweep, ips, hostname)
// are reused from the backup agent so there is ONE no-shell exec path across the product.
import fs from 'node:fs';
import path from 'node:path';
import { parseKv } from '../backup/config.js';
import { run, writeAtomic, writeJson, readText, readJsonFile, sweep, ips, hostname } from '../backup/agent-util.js';

export { run, writeAtomic, writeJson, readText, readJsonFile, sweep, ips, hostname };

// Every path the release agents use comes from here (environment overrides exist for the tests). The repository
// WORKING COPY (REPO_DIR) and the write-restricted git credentials live in the root-owned conf files, never in the
// repo and never readable by the unprivileged API — same secrets rule as the backup key.
export function releasePaths(env = process.env) {
  const conf = env.ETS_CONF_DIR || '/etc/ets';
  const state = env.ETS_STATE_DIR || '/var/lib/ets';
  return {
    conf,
    envFile: env.ETS_ENV_FILE || path.join(conf, 'ets.env'),
    publisherConf: env.ETS_RELEASE_PUBLISHER_CONF || path.join(conf, 'release-publisher.conf'),
    deployAgentConf: env.ETS_DEPLOY_AGENT_CONF || path.join(conf, 'deploy-agent.conf'),
    signKey: env.ETS_RELEASE_SIGN_KEY || path.join(conf, 'release-sign.key'),       // TEST: signs the manifest
    signersDir: env.ETS_RELEASE_SIGNERS_DIR || path.join(conf, 'release-trust'),    // allow-listed release signer *.pub
    statusKey: env.ETS_RELEASE_STATUS_KEY || path.join(conf, 'deploy-status.key'),  // PROD: signs the status file
    statusSignersDir: env.ETS_RELEASE_STATUS_SIGNERS_DIR || path.join(conf, 'status-trust'), // allow-listed status *.pub
    deployKey: env.ETS_RELEASE_DEPLOY_KEY || path.join(conf, 'release-deploy-key'), // write-restricted git push key
    state,
    inbox: path.join(state, 'inbox'),                       // the API (ets) touches <inbox>/.release-wake
    releaseDir: path.join(state, 'release'),                // root: local status.json (no secrets) for the prod API
    verify: env.ETS_RELEASE_VERIFY || path.join(env.ETS_APP_DIR || '/opt/ets', 'deploy', 'release', 'verify.mjs'),
    app: env.ETS_APP_DIR || '/opt/ets',
    updateCmd: env.ETS_UPDATE_CMD || null,                  // resolved relative to REPO_DIR when not set
    backupCmd: env.ETS_BACKUP_CMD || '/usr/local/bin/ets-backup',
    systemctl: env.ETS_SYSTEMCTL || 'systemctl',
    git: env.ETS_GIT || 'git',
    service: env.ETS_SERVICE || 'ets-backend',
  };
}

// Relative path (inside REPO_DIR) of the signed signal and the signed status file.
export const MANIFEST_REL = 'deploy/production-release.json';
export const STATUS_REL = 'deploy/production-status.json';

// The ONLY files each agent may write outside its own state directory. A path not on the list is refused — exactly
// like backup/agent-util.js writable(). The signal/status files live in the repo working copy; the agents never touch
// the keys or the conf files.
export function publisherWritable(p, repoDir) {
  const m = path.join(repoDir, MANIFEST_REL);
  return new Set([m, m + '.sig']);
}
export function deployWritable(p, repoDir) {
  const s = path.join(repoDir, STATUS_REL);
  return new Set([s, s + '.sig', path.join(p.releaseDir, 'status.json')]);
}
export function writeAllowed(allow, file, text, mode = 0o600) {
  if (!allow.has(file)) throw new Error('refused: ' + file + ' is not a file this release agent may write');
  return writeAtomic(file, text, mode);
}

// Parse a root-owned conf file (KEY=value lines, read as data — never executed). Reuses the backup parseKv.
export function readConf(file) {
  const txt = readText(file);
  if (txt === null) return null;
  return parseKv(txt);
}

// Load the allow-listed signer public keys from a directory of *.pub PEM files → [{ key_id, publicKey }].
// keyId() is derived from the public key only (safe to log); a file that does not parse as a key is skipped.
export function loadSigners(dir, keyIdFn) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.pub')) continue;
    const pem = readText(path.join(dir, n));
    if (!pem) continue;
    try { out.push({ key_id: keyIdFn(pem), publicKey: pem, file: n }); } catch { /* not a key */ }
  }
  return out;
}

// A git working copy's current HEAD commit (40 hex) or null.
export async function gitHead(p, repoDir, ref = 'HEAD') {
  const r = await run(p.git, ['-C', repoDir, 'rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  const h = r.out.trim();
  return /^[0-9a-f]{40}$/.test(h) ? h : null;
}
