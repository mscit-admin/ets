// Helpers of the root backup agent (1.12.0): fixed paths, the allow-list of files it may write, commands started without
// a shell, the single-use secret channel from the API, and small file utilities. Used by agent.js and restore.js.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Every path comes from here (environment overrides exist for the tests only).
export function agentPaths(env = process.env) {
  const conf = env.ETS_CONF_DIR || '/etc/ets';
  const state = env.ETS_STATE_DIR || '/var/lib/ets';
  return {
    conf,
    envFile: env.ETS_ENV_FILE || path.join(conf, 'ets.env'),
    installConf: env.ETS_INSTALL_CONF || path.join(conf, 'install.conf'),
    backupConf: env.ETS_BACKUP_CONF || path.join(conf, 'backup.conf'),
    rcloneConf: path.join(conf, 'rclone.conf'),
    backupKey: env.ETS_BACKUP_KEY || path.join(conf, 'backup.key'),
    sshKey: path.join(conf, 'backup_ssh_key'),
    knownHosts: path.join(conf, 'backup_known_hosts'),
    dbCa: path.join(conf, 'db-ca.crt'),
    backupDir: env.ETS_BACKUP_DIR || '/var/backups/ets',
    systemd: env.ETS_SYSTEMD_DIR || '/etc/systemd/system',
    inbox: path.join(state, 'inbox'),           // written by the API (ets): single-use secret files, wake-up file
    upload: path.join(state, 'upload'),         // written by the API (ets): uploaded backup files
    restoreDir: path.join(state, 'restore'),    // root: status.json (world-readable, no secrets), active flag
    staging: path.join(state, 'restore', 'work'), // root only (0700): fetched / uploaded files being restored
    run: env.ETS_RUN_DIR || '/run/ets-backup-agent',   // root only, tmpfs: keys of a restore in progress (≤ 15 min)
    app: env.ETS_APP_DIR || '/opt/ets',
    logDir: env.ETS_LOG_DIR || '/var/log/ets',
    backupCmd: env.ETS_BACKUP_CMD || '/usr/local/bin/ets-backup',
    verifyCmd: env.ETS_VERIFY_CMD || '/usr/local/bin/ets-backup-verify',
    protectCmd: env.ETS_LOG_PROTECT_CMD || '/usr/local/sbin/ets-log-protect',
    systemctl: env.ETS_SYSTEMCTL || 'systemctl',
    nginx: env.ETS_NGINX_CMD || 'nginx',
    service: env.ETS_SERVICE || 'ets-backend',
    runAs: env.ETS_RUN_AS || 'ets',
    tlsCert: env.ETS_TLS_CERT || '/etc/ssl/certs/ets-selfsigned.crt',
    tlsKey: env.ETS_TLS_KEY || '/etc/ssl/private/ets-selfsigned.key',
  };
}

// The only files the agent writes outside its own directories. A path that is not here is refused.
export function writable(p) {
  return new Set([p.backupConf, p.rcloneConf, p.backupKey, `${p.backupKey}.id`,
    path.join(p.systemd, 'ets-backup.timer.d', 'schedule.conf'), path.join(p.systemd, 'ets-backup-verify.timer.d', 'schedule.conf')]);
}
export function writeAllowed(p, file, text, mode = 0o600) {
  if (!writable(p).has(file)) throw new Error('refused: ' + file + ' is not a file the backup agent may write');
  return writeAtomic(file, text, mode);
}
// write to a temporary file in the same directory, then rename (readers never see half a file). → true when changed
export function writeAtomic(file, text, mode = 0o600) {
  try { if (fs.readFileSync(file, 'utf8') === text) { fs.chmodSync(file, mode); return false; } } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
  return true;
}
export const writeJson = (file, obj, mode = 0o644) => writeAtomic(file, JSON.stringify(obj) + '\n', mode);

// run(cmd, args) without a shell; onLine(line, stream) for progress. → { code, out } (out: the last 20 000 characters,
// or all of it with full: true — listings that are parsed)
export function run(cmd, args = [], { env = {}, onLine, input, cwd, timeoutMs = 0, full = false } = {}) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: cwd || '/', stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const feed = stream => {
      let buf = '';
      return chunk => {
        const s = chunk.toString('utf8');
        out = full ? out + s : (out + s).slice(-20000);
        buf += s;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine?.(line, stream); }
      };
    };
    child.stdout.on('data', feed('out'));
    child.stderr.on('data', feed('err'));
    let timer = null;
    if (timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    if (input) { child.stdin.end(input); }
    child.on('error', e => { if (timer) clearTimeout(timer); resolve({ code: 127, out: out + String(e.message) }); });
    child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

// ---------------------------------------------------------------- the secret channel API → agent
// The API writes <inbox>/<token>.sec (0600, owner ets) = AES-256-GCM(secret) with a one-time key that only the job row
// holds (params.ck). The agent reads the file, deletes it, decrypts, and removes ck from the row. Neither the file nor
// the row alone reveals the secret; both are gone within seconds; it is never logged.
export function sealSecret(secret) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(String(secret), 'utf8'), c.final()]);
  return { ck: k.toString('base64url'), blob: [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.') };
}
// AES-256-GCM(data) under a KNOWN key ck (base64url). The reverse of openWith; used by the export_key agent handler
// to encrypt /etc/ets/backup.key under the one-time key the API placed in the inbox — only the API (which holds ck in
// memory) can open the blob, so the result stored in backup_jobs.result is useless on its own.
export function sealWith(ck, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(ck, 'base64url'), iv);
  const enc = Buffer.concat([c.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function openWith(blob, ck) {
  const [iv, tag, enc] = String(blob).trim().split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(ck, 'base64url'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]);
}
export const openSecret = (blob, ck) => openWith(blob, ck).toString('utf8');
export const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;
export function takeSecret(p, token, ck) {
  if (!TOKEN_RE.test(String(token)) || !ck) throw new Error('secret_missing');
  const f = path.join(p.inbox, token + '.sec');
  let blob;
  try { blob = fs.readFileSync(f, 'utf8'); } finally { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  return openSecret(blob, ck);
}
// The reverse channel (agent ← API) for export_key: the API wrote the one-time key ck into <inbox>/<token>.sec (0600,
// owner ets); the agent reads it, deletes it, and keeps only ck in memory. ck is never in the database (only the token
// is in the job row), so neither the file (deleted at once) nor the row reveals it.
export function takeInboxKey(p, token) {
  if (!TOKEN_RE.test(String(token))) throw new Error('secret_missing');
  const f = path.join(p.inbox, token + '.sec');
  let ck;
  try { ck = fs.readFileSync(f, 'utf8').trim(); } finally { try { fs.rmSync(f, { force: true }); } catch { /* gone */ } }
  if (!ck) throw new Error('secret_missing');
  return ck;
}
// a key in the agent's tmpfs directory for gpg --passphrase-file (deleted after use / after 15 minutes)
export function keyFile(p, name, secret) {
  fs.mkdirSync(p.run, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.run, 0o700);
  const f = path.join(p.run, name + '.key');
  fs.writeFileSync(f, String(secret).split('\n')[0] + '\n', { mode: 0o600 });
  return f;
}
export function sweep(dir, maxAgeMs, filter = () => true) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!filter(e.name)) continue;
      const f = path.join(dir, e.name);
      try { if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) { fs.rmSync(f, { recursive: true, force: true }); n++; } } catch { /* raced */ }
    }
  } catch { /* no directory */ }
  return n;
}

export function sha256File(file, onBytes) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', b => { h.update(b); onBytes?.(b.length); });
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}
export const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
export const readJsonFile = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
export const ips = () => Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address);
export const hostname = () => os.hostname();
