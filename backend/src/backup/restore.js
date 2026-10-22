// Restore from Settings → «النسخ الاحتياطي» (1.12.0), carried out by the root backup agent. Two jobs:
//
//   restore_inspect — nothing is changed: the chosen files are fetched (local, SSH, NAS, cloud or an upload) into a
//     root-only staging directory, checked against their checksums, decrypted with the key the administrator typed
//     (wrong key → error 'wrong_key' before anything else), the database dump is restored into a temporary database
//     (ets-backup-verify: migrations, audit chains, row counts) and the configuration bundle's manifest is read.
//   restore_run — only the selected items: safety copy of what will be replaced (database: ets-backup --no-offsite;
//     files: a copy in /var/backups/ets/pre-restore-<time>/), the API stopped only when the database or ets.env is
//     replaced, the database restored in one transaction (through ets-log-protect when the superuser is reachable),
//     files put back, migrations, verify-audit, API started and checked. Any failure → automatic rollback of exactly
//     the replaced items. Progress goes to /var/lib/ets/restore/status.json (no secrets) about once a second, because
//     the database is being replaced; nginx serves it to the maintenance page while the API is down.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { run, takeSecret, keyFile, sha256File, readText, readJsonFile, writeJson, writeAtomic, ips, hostname } from './agent-util.js';
import { Tracker, restoreFraction, MODEL } from './progress.js';
import { parseArtifact, parseKv, validateConfig, cloudRemote, restoreWarnings, appSecretFp, cmpVersion, CONFIG_ITEMS, RESTORE_ITEMS } from './config.js';

const SOURCES = ['local', 'ssh', 'nas', 'cloud', 'upload'];
const say = (...a) => console.log(new Date().toISOString(), ...a);
const env = p => parseKv(readText(p.envFile) || '');
function pgEnv(p) {
  const e = env(p), out = {};
  for (const k of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY']) if (e[k]) out[k] = e[k];
  if (out.PGHOST && !/^(127\.0\.0\.1|localhost|::1|\/.*)$/.test(out.PGHOST) && !out.PGSSLMODE) out.PGSSLMODE = 'require';
  return out;
}
const appVersion = p => readJsonFile(path.join(p.app, 'backend', 'package.json'))?.version || null;

// ---------------------------------------------------------------- shared steps
function stageDir(p, id) {
  fs.mkdirSync(p.staging, { recursive: true, mode: 0o700 }); fs.chmodSync(p.staging, 0o700);
  const d = path.join(p.staging, String(id));
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
async function destConfig() {
  const row = (await query('SELECT config FROM backup_config WHERE id=1')).rows[0];
  const v = validateConfig(row?.config || {});
  if (!v.ok) throw new Error('invalid backup configuration');
  return v.value;
}
// copies NAME (+ .sha256, .meta) from the source into DIR
async function fetchOne(p, source, name, dir, uploads) {
  if (!parseArtifact(name)) throw new Error('invalid file name');
  const wanted = [name, name + '.sha256', name + '.meta'];
  if (source === 'local') {
    for (const n of wanted) if (fs.existsSync(path.join(p.backupDir, n))) fs.copyFileSync(path.join(p.backupDir, n), path.join(dir, n));
  } else if (source === 'upload') {
    const id = uploads?.[name];
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(id))) throw new Error('upload not found');
    for (const n of wanted) {
      const f = path.join(p.upload, id, n);
      if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, n));
    }
  } else {
    const c = await destConfig();
    if (source === 'nas') {
      if ((await run('mountpoint', ['-q', c.nas.dir])).code !== 0) throw new Error(`${c.nas.dir} is not mounted`);
      for (const n of wanted) if (fs.existsSync(path.join(c.nas.dir, n))) fs.copyFileSync(path.join(c.nas.dir, n), path.join(dir, n));
    } else if (source === 'ssh') {
      const ssh = `ssh -i ${p.sshKey} -p ${c.ssh.port} -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${p.knownHosts} -o ConnectTimeout=20`;
      const base = c.ssh.target.replace(/\/$/, '') + '/';
      const r = await run('rsync', ['-t', '-e', ssh, ...wanted.map(n => base + n), dir + '/']);
      if (r.code !== 0 && r.code !== 23) throw new Error('rsync: ' + r.out.trim().split('\n').pop());
    } else if (source === 'cloud') {
      const remote = cloudRemote(c);
      for (const n of wanted) {
        const r = await run('rclone', ['--config', p.rcloneConf, 'copyto', `${remote}/${n}`, path.join(dir, n)]);
        if (r.code !== 0 && n === name) throw new Error('rclone: ' + r.out.trim().split('\n').pop());
      }
    }
  }
  if (!fs.existsSync(path.join(dir, name))) throw new Error('file not found at the source: ' + name);
}
async function checksum(dir, name, onBytes) {
  const want = (readText(path.join(dir, name + '.sha256')) || '').split(/\s/)[0];
  const got = await sha256File(path.join(dir, name), onBytes);
  if (want && want !== got) throw Object.assign(new Error('checksum_mismatch'), { code: 'checksum_mismatch', file: name });
  return { sha256: got, checked: !!want };
}
// gpg --decrypt with a byte counter on the encrypted input. → throws {code:'wrong_key'} when the key does not fit
function gpgDecrypt(file, out, key, onBytes) {
  return new Promise(resolve => {
    const home = fs.mkdtempSync(path.join(path.dirname(out), '.gnupg-'));
    fs.chmodSync(home, 0o700);
    import('node:child_process').then(({ spawn }) => {
      const g = spawn('gpg', ['--batch', '--quiet', '--yes', '--pinentry-mode', 'loopback', '--passphrase-file', key, '--decrypt', '--output', out],
        { env: { ...process.env, GNUPGHOME: home }, stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      g.stderr.on('data', b => { err += b; });
      const s = fs.createReadStream(file);
      s.on('data', b => onBytes?.(b.length));
      s.pipe(g.stdin);
      g.stdin.on('error', () => {});
      g.on('close', code => { fs.rmSync(home, { recursive: true, force: true }); resolve({ ok: code === 0, err }); });
    });
  }).then(r => {
    if (!r.ok) {
      fs.rmSync(out, { force: true });
      throw Object.assign(new Error(/bad session key|decryption failed|bad passphrase/i.test(r.err) ? 'wrong_key' : 'decrypt_failed: ' + r.err.trim().split('\n').pop()),
        { code: /bad session key|decryption failed|bad passphrase/i.test(r.err) ? 'wrong_key' : 'decrypt_failed' });
    }
  });
}
// a tar from a backup: regular files and directories only, plus symbolic links inside /etc/letsencrypt; no absolute names, no "..",
// no member below a symbolic link
async function safeExtract(tarFile, dest) {
  const r = await run('tar', ['-tvf', tarFile], { full: true });
  if (r.code !== 0) throw new Error('not a tar archive');
  const names = [], links = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const type = line[0];
    const m = /^\S+\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+?)(?: -> (.+))?$/.exec(line);
    if (!m) throw new Error('unreadable archive listing');
    const n = m[1];
    if (n.startsWith('/') || n.split('/').includes('..')) throw new Error('unsafe name in archive: ' + n);
    if (!['-', 'd', 'l'].includes(type)) throw new Error('unsupported entry in archive: ' + n);
    if (type === 'l') { if (!/^(\.\/)?files\/etc\/letsencrypt\//.test(n)) throw new Error('unexpected link in archive: ' + n); links.push(n.replace(/^\.\//, '')); }
    names.push(n.replace(/^\.\//, ''));
  }
  for (const l of links) if (names.some(n => n.startsWith(l + '/'))) throw new Error('entry below a link in archive');
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const x = await run('tar', ['-xf', tarFile, '-C', dest, '--no-same-owner', '--no-same-permissions', '--no-overwrite-dir']);
  if (x.code !== 0) throw new Error('cannot extract archive');
}
function suArgs(p, db) {
  const e = pgEnv(p);
  if (process.env.ETS_SU_CONNINFO) return ['psql', ['-X', '-qtA', '--dbname', `${process.env.ETS_SU_CONNINFO} dbname=${db}`]];
  return ['runuser', ['-u', 'postgres', '--', 'env', '-i', `PATH=${process.env.PATH}`, 'psql', '-X', '-qtA', '-w',
    '-h', process.env.ETS_SU_PGHOST || '/var/run/postgresql', '-p', e.PGPORT || '5432', '-d', db]];
}
async function suQuery(p, db, sql) {
  const [cmd, args] = suArgs(p, db);
  const r = await run(cmd, [...args, '-c', sql]);
  return r.code === 0 ? r.out : null;
}
const viaSu = async p => fs.existsSync(p.protectCmd) && (await run(p.protectCmd, ['check'], { env: { ETS_ENV_FILE: p.envFile, ETS_APP_DIR: p.app } })).code === 0;
async function logsProtected(p) {
  const r = await run('psql', ['-X', '-qtA', '-c', "SELECT pg_get_userbyid(relowner) <> current_user FROM pg_class WHERE oid = to_regclass('public.audit_log')"], { env: pgEnv(p) });
  return r.out.trim() === 't';
}
function nodeArgs(p, script, args = []) {
  const e = { ETS_ENV_FILE: p.envFile };
  if (process.getuid?.() === 0 && p.runAs !== 'root') {
    return ['runuser', ['-u', p.runAs, '--', 'env', `ETS_ENV_FILE=${p.envFile}`, `PATH=${process.env.PATH}`, 'node', script, ...args], e];
  }
  return ['node', [script, ...args], e];
}
const runNode = (p, script, args) => { const [c, a, e] = nodeArgs(p, script, args); return run(c, a, { env: e, cwd: path.join(p.app, 'backend') }); };

// Byte offset where the data of a pg_restore SQL script ends (indexes, constraints, triggers follow).
export function scanSql(file) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  let pos = 0, rest = '', offset = size, seenCopy = false;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      let at = pos - rest.length;                       // latin1: one character per byte
      const lines = (rest + buf.toString('latin1', 0, n)).split('\n'); rest = lines.pop();
      for (const l of lines) {
        if (/^COPY /.test(l)) { seenCopy = true; offset = size; }
        else if (seenCopy && offset === size && /^(CREATE (UNIQUE )?INDEX|ALTER TABLE ONLY |CREATE TRIGGER)/.test(l)) offset = at;
        at += l.length + 1;
      }
      pos += n;
    }
  } finally { fs.closeSync(fd); }
  return { size, offset: Math.min(offset, size) };
}
// psql (ON_ERROR_STOP) with head + the file + tail on stdin; onProgress(bytesOfFile, event) per line of the file:
// {type:'data', table} at COPY, {type:'row'} per data line, {type:'end'} at \.
export function psqlStream(env, head, file, tail, onProgress) {
  return new Promise(resolve => {
    import('node:child_process').then(({ spawn }) => {
      const ps = spawn('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], { env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'pipe'], cwd: '/' });
      let err = '', bytes = 0, inCopy = false, rest = '';
      ps.stderr.on('data', b => { err = (err + b).slice(-4000); });
      ps.stdin.on('error', () => {});
      for (const h of head) ps.stdin.write(h);
      const s = fs.createReadStream(file);
      s.on('data', chunk => {
        bytes += chunk.length;
        const lines = (rest + chunk.toString('latin1')).split('\n'); rest = lines.pop();
        for (const l of lines) {
          if (inCopy) { if (l === '\\.') { inCopy = false; onProgress(bytes, { type: 'end' }); } else onProgress(bytes, { type: 'row' }); }
          else { const m = /^COPY (?:[^.\s]+\.)?"?([^"\s(]+)"? /.exec(l); if (m) { inCopy = true; onProgress(bytes, { type: 'data', table: m[1] }); } }
        }
        onProgress(bytes, null);
        if (!ps.stdin.write(chunk)) { s.pause(); ps.stdin.once('drain', () => s.resume()); }
      });
      s.on('end', () => { for (const t of tail) ps.stdin.write(t); ps.stdin.end(); });
      ps.on('close', code => resolve({ code: code ?? 1, out: err }));
    });
  });
}

// ---------------------------------------------------------------- inspect
export async function restoreInspect(job, p, { setJob }) {
  const prm = job.params || {};
  let key;
  try { key = takeSecret(p, prm.token, prm.ck); } finally { await setJob(job.id, { params: { ...prm, ck: null, token: null } }); }
  if (!SOURCES.includes(prm.source)) return { ok: false, result: { error: 'invalid_source' } };
  const items = Array.isArray(prm.items) ? prm.items.filter(i => RESTORE_ITEMS.includes(i)) : [];
  const files = { dump: prm.dump || null, config: prm.config || null, logs: prm.logs || null };
  for (const [k, n] of Object.entries(files)) if (n && parseArtifact(n)?.kind !== k) return { ok: false, result: { error: 'invalid_file', file: k } };
  const dir = stageDir(p, job.id);
  const kf = keyFile(p, `restore-${job.id}`, key);
  key = null;
  const t = new Tracker({ kind: 'inspect', sizes: { bytes: 0 }, skip: files.dump ? [] : ['createdb', 'restore_data', 'restore_index', 'migrate', 'verify', 'counts', 'drop'] });
  let last = 0;
  const w = (force) => { if (force || Date.now() - last > 1000) { last = Date.now(); setJob(job.id, { progress: t.snapshot() }); } };
  const result = { source: prm.source, items, files: {}, current: { hostname: hostname(), ips: ips(), app_version: appVersion(p), app_secret_fp: appSecretFp(env(p).APP_SECRET) } };
  try {
    t.begin('fetch'); w(true);
    const chosen = Object.values(files).filter(Boolean);
    for (const [i, n] of chosen.entries()) { await fetchOne(p, prm.source, n, dir, prm.uploads); t.advance('fetch', (i + 1) / chosen.length); w(); }
    const total = chosen.reduce((a, n) => a + fs.statSync(path.join(dir, n)).size, 0);
    t.count('bytes', 0, total);
    t.begin('checksum'); let done = 0;
    for (const n of chosen) {
      const c = await checksum(dir, n, b => { done += b; t.advance('checksum', done / total); w(); });
      result.files[parseArtifact(n).kind] = { name: n, size: fs.statSync(path.join(dir, n)).size, ...c, meta: readJsonFile(path.join(dir, n + '.meta')) };
    }
    t.begin('decrypt'); done = 0;
    // the configuration bundle and the logs bundle are small: decrypted here (also proves the key)
    if (files.config) {
      await gpgDecrypt(path.join(dir, files.config), path.join(dir, 'config.tar'), kf, b => { done += b; t.count('bytes', done); t.advance('decrypt', done / total); w(); });
      await safeExtract(path.join(dir, 'config.tar'), path.join(dir, 'config'));
      const m = readJsonFile(path.join(dir, 'config', 'manifest.json'));
      if (!m) throw new Error('the configuration bundle has no manifest');
      for (const f of m.files || []) {
        if (f.type !== 'file') continue;
        const local = path.join(dir, 'config', 'files', f.path);
        const h = crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex');
        if (h !== f.sha256) throw Object.assign(new Error('checksum_mismatch'), { code: 'checksum_mismatch', file: f.path });
      }
      for (const i of items.filter(x => CONFIG_ITEMS.includes(x))) if (!(m.items || []).includes(i)) throw Object.assign(new Error('item_not_in_bundle'), { code: 'item_not_in_bundle', file: i });
      result.config = { created: m.created, hostname: m.hostname, ips: m.ips, address: m.address, app_version: m.app_version, git_commit: m.git_commit,
        public_base_url: m.public_base_url, tls: m.tls, app_secret_fp: m.app_secret_fp, items: m.items, backup_key_id: m.backup_key_id, globals: m.globals?.mode };
    }
    if (files.logs) {
      await gpgDecrypt(path.join(dir, files.logs), path.join(dir, 'logs.tar'), kf, b => { done += b; t.count('bytes', done); t.advance('decrypt', done / total); w(); });
      const l = await run('tar', ['-tf', path.join(dir, 'logs.tar')], { full: true });
      result.logs = { date: parseArtifact(files.logs).date, files: l.out.split('\n').filter(Boolean).length };
    }
    if (files.dump) {
      // the verify script decrypts (a wrong key → exit 10), restores into the temporary database, migrates and checks it
      const out = path.join(dir, 'verify.json');
      const steps = [[/^decrypted/, 'decrypt', 'createdb'], [/^temporary database/, 'createdb', 'restore_data'], [/^restored into/, 'restore_index', 'migrate'],
        [/^(schema up to date|migrations applied)/, 'migrate', 'verify'], [/^(audit chains|FAILED: audit)/, 'verify', 'counts'], [/^counts:/, 'counts', 'drop']];
      const r = await run(p.verifyCmd, ['--file', path.join(dir, files.dump), '--key', kf, '--json', out, '--no-log'], {
        env: { ETS_VERIFY_DB: process.env.ETS_INSPECT_DB || 'ets_restore_check' },
        onLine: line => { for (const [re, d, nx] of steps) if (re.test(line)) { t.done(d); t.begin(nx); } w(); } });
      const v = readJsonFile(out) || {};
      if (r.code === 10 || v.wrong_key) throw Object.assign(new Error('wrong_key'), { code: 'wrong_key' });
      result.dump = { toc_entries: v.toc_entries, data_tables: v.data_tables, migrations: v.migrations, newer_than_app: !!v.newer_than_app,
        audit_ok: v.audit_ok ?? null, db_size: v.db_size || 0, tables: v.tables || [], counts: v.counts || {}, app_secret_fp: v.app_secret_fp || null,
        created: result.files.dump?.meta?.created || null, app_version: result.files.dump?.meta?.app_version || null, ok: !!v.ok, error: v.error || null };
      if (!v.ok && !v.newer_than_app) throw new Error('test restore failed: ' + (v.error || 'see the log'));
    }
    t.finish('done'); w(true);
  } catch (e) {
    t.finish('failed'); w(true);
    // nothing to restore: the key and the staged files go at once
    fs.rmSync(kf, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: false, result: { ...result, error: ['wrong_key', 'checksum_mismatch', 'item_not_in_bundle'].includes(e.code) ? e.code : String(e.message).slice(0, 300), file: e.file } };
  }
  // blocking problems and warnings for the confirm step
  const blocking = [];
  if (items.includes('db')) {
    if (result.dump?.newer_than_app) blocking.push({ code: 'newer_version', unknown: result.dump.migrations?.unknown });
    if (!(await viaSu(p)) && (await logsProtected(p))) blocking.push({ code: 'needs_superuser' });
  }
  const metas = {};
  if (files.dump) metas[files.dump] = { ...(result.files.dump?.meta || {}), app_secret_fp: result.dump?.app_secret_fp || result.files.dump?.meta?.app_secret_fp };
  if (files.config) metas[files.config] = { ...(result.files.config?.meta || {}), app_secret_fp: result.config?.app_secret_fp, tls_san: result.config?.tls?.san, hostname: result.config?.hostname };
  result.warnings = restoreWarnings(items, files, metas, { ...result.current, address: parseKv(readText(p.installConf) || '').DEF_ADDRESS });
  if (result.files.dump?.meta?.app_version && cmpVersion(result.files.dump.meta.app_version, result.current.app_version || '0') > 0) blocking.push({ code: 'newer_app_version', version: result.files.dump.meta.app_version });
  result.blocking = blocking;
  result.sizes = { bytes: Object.values(result.files).reduce((a, f) => a + (f.size || 0), 0), db_bytes: result.dump?.db_size || 0,
    data_bytes: (result.dump?.tables || []).reduce((a, x) => a + (+x.bytes || 0), 0), rows: (result.dump?.tables || []).reduce((a, x) => a + (+x.rows || 0), 0),
    logs_bytes: result.files.logs?.size || 0 };
  result.expires_at = new Date(Date.now() + 15 * 60_000).toISOString();
  return { ok: true, result };
}

// ---------------------------------------------------------------- run
const statusFile = p => path.join(p.restoreDir, 'status.json');
const activeFlag = p => path.join(p.restoreDir, 'active');
function currentTls(p) {
  const a = parseKv(readText(p.installConf) || '');
  if (a.DEF_TLS === 'existing') return { mode: 'existing', cert: a.DEF_CERT, key: a.DEF_KEY };
  if (a.DEF_TLS === 'letsencrypt') return { mode: 'letsencrypt', cert: `/etc/letsencrypt/live/${a.DEF_ADDRESS}/fullchain.pem`, key: `/etc/letsencrypt/live/${a.DEF_ADDRESS}/privkey.pem` };
  return { mode: 'selfsigned', cert: p.tlsCert, key: p.tlsKey };
}
function copyKeep(src, dst, mode, uid, gid) {
  const tmp = dst + '.ets-restore.tmp';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, tmp);
  fs.chmodSync(tmp, mode);
  if (uid !== undefined && process.getuid?.() === 0) fs.chownSync(tmp, uid, gid);
  fs.renameSync(tmp, dst);
}
function setEnvKv(text, k, v) {
  const re = new RegExp(`^${k}=.*$`, 'm');
  const line = `${k}='${v}'`;
  if (v === null) return text.replace(new RegExp(`^${k}=.*\\n?`, 'm'), '');
  return re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, '\n') + line + '\n';
}
async function health(p) {
  const port = env(p).PORT || '3000';
  const url = process.env.ETS_HEALTH_URL || `http://127.0.0.1:${port}/api/health`;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

export async function restoreRun(job, p, { setJob }) {
  const prm = job.params || {};
  const insp = (await query(`SELECT * FROM backup_jobs WHERE id=$1 AND kind='restore_inspect'`, [prm.inspect_id])).rows[0];
  const fail0 = async error => { await setJob(job.id, { status: 'failed', finished_at: new Date(), result: { error } }); return { detached: true }; };
  if (!insp || insp.status !== 'ok' || Date.now() - new Date(insp.finished_at) > 15 * 60_000) return fail0('inspection_expired');
  const ir = insp.result;
  const items = (prm.items || []).filter(i => ir.items.includes(i));
  if (!items.length || items.length !== (prm.items || []).length) return fail0('items_not_inspected');
  if (ir.blocking?.length && items.includes('db')) return fail0('blocked');
  const kf = path.join(p.run, `restore-${insp.id}.key`);
  if (!fs.existsSync(kf)) return fail0('key_expired');
  const dir = path.join(p.staging, String(insp.id));
  const has = i => items.includes(i);
  const db = has('db'), cfgItems = items.filter(i => CONFIG_ITEMS.includes(i));
  const stopApi = db || has('env');
  const sizes = { ...ir.sizes, bytes: (db ? ir.files.dump.size : 0) };
  const skip = ['fetch'];
  if (!db) skip.push('decrypt', 'restore_data', 'restore_index', 'migrate', 'verify');
  if (!db && !cfgItems.length) skip.push('safety');
  if (!stopApi) skip.push('stop', 'start', 'health');
  if (!cfgItems.length) skip.push('config');
  if (!has('logs')) skip.push('logs');
  if (!db) skip.push('checksum');
  const t = new Tracker({ kind: 'restore', sizes, skip });
  const tables = ir.dump?.tables || [];
  const status = { id: job.id, items, backup: { dump: ir.files.dump?.name || null, config: ir.files.config?.name || null, logs: ir.files.logs?.name || null,
    created: ir.dump?.created || ir.config?.created || null, source: ir.source }, rollback: null, error: null };
  fs.mkdirSync(p.restoreDir, { recursive: true }); fs.chmodSync(p.restoreDir, 0o755);
  let lastW = 0, lastPct = -1;
  const write = (force = false) => {
    const now = Date.now();
    if (!force && now - lastW < 1000) return;
    lastW = now;
    const snap = { ...status, ...t.snapshot(now), state: status.state || t.state };
    if (snap.percent < lastPct) snap.percent = lastPct;     // never backwards on screen
    lastPct = snap.percent;
    writeJson(statusFile(p), snap);
  };
  const ticker = setInterval(() => write(), 1000);
  const changed = { db: false, files: [] };     // what has been replaced (rollback covers exactly this)
  let safetyDump = null, safetyDir = null, stopped = false;
  const e0 = pgEnv(p);
  await setJob(job.id, { status: 'running', progress: t.snapshot() });
  say(`restore ${job.id}: ${items.join(', ')} from ${ir.source}`);
  const tsName = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

  const restoreDump = async (dumpFile, tr, phaseData, phaseIdx) => {
    // the list without extensions (they belong to the DBA and exist already)
    const l = await run('pg_restore', ['--list', dumpFile], { full: true });
    if (l.code !== 0) throw new Error('not a valid pg_dump archive');
    const listFile = dumpFile + '.list';
    fs.writeFileSync(listFile, l.out.split('\n').filter(x => !/^\d+; \d+ \d+ (EXTENSION|COMMENT - EXTENSION) /.test(x)).join('\n') + '\n', { mode: 0o600 });
    const su = await viaSu(p);
    const seen = new Set(); let cur = null, idxStart = 0;
    const rowsTotal = tables.reduce((x, t) => x + (+t.rows || 0), 0);
    const idxEst = Math.max(2, (sizes.data_bytes || 0) / MODEL.restore_index.rate);
    const progress = () => {
      const f = restoreFraction(tables, seen, cur);
      tr.count('rows', f.rows, f.rowsTotal); tr.count('tables', f.tables, f.tablesTotal);
      if (tr.phase(phaseData)?.state === 'running') tr.advance(phaseData, Math.min(0.99, f.frac));
    };
    const toIndex = () => {
      if (tr.phase(phaseIdx)?.state === 'running' || tr.phase(phaseIdx)?.state === 'done') return;
      if (cur) seen.add(cur.table); cur = null;
      progress(); tr.done(phaseData); tr.begin(phaseIdx); idxStart = Date.now();
    };
    tr.begin(phaseData);
    // the index / constraint phase has no counter of its own: it advances by its estimated duration (size model)
    const idxTimer = setInterval(() => { if (tr.phase(phaseIdx)?.state === 'running') tr.advance(phaseIdx, Math.min(0.95, (Date.now() - idxStart) / 1000 / idxEst)); }, 1000);
    let poll = null;
    if (su) {
      // through ets-log-protect (superuser transaction): PostgreSQL's own COPY progress. The tables are created inside
      // that transaction, so another session sees their OIDs, not their names: rows and tables are counted per OID.
      const perRel = new Map(); let seenCopy = false, idle = 0;
      poll = setInterval(async () => {
        const out = await suQuery(p, e0.PGDATABASE || 'ets', `SELECT relid::oid, tuples_processed FROM pg_stat_progress_copy WHERE datname = current_database()`);
        const line = String(out || '').split('\n').find(Boolean);
        if (line) { const [rel, n] = line.split('|'); perRel.set(rel, Math.max(perRel.get(rel) || 0, +n || 0)); seenCopy = true; idle = 0; }
        else if (seenCopy && ++idle >= 2) toIndex();
        const done = [...perRel.values()].reduce((x, v) => x + v, 0);
        tr.count('rows', done, rowsTotal); tr.count('tables', Math.max(0, perRel.size - (line ? 1 : 0)), tables.length);
        if (tr.phase(phaseData)?.state === 'running' && rowsTotal) tr.advance(phaseData, Math.min(0.99, done / rowsTotal));
      }, 1000);
    }
    let r;
    try {
      if (su) {
        r = await run(p.protectCmd, ['restore', dumpFile, listFile], { env: { ETS_ENV_FILE: p.envFile, ETS_APP_DIR: p.app } });
      } else {
        // as the application role (log tables not protected): one psql transaction — schema public emptied
        // (deploy/db/wipe-public.sql), then the SQL of the backup streamed through a counter: the pipe is small, so what
        // has been sent is what PostgreSQL has taken (COPY lines = rows; after the data, indexes and constraints)
        const sqlFile = dumpFile + '.sql';
        const g = await run('pg_restore', ['--no-owner', '--no-acl', `--use-list=${listFile}`, `--file=${sqlFile}`, dumpFile]);
        if (g.code !== 0) throw new Error('pg_restore could not read the backup: ' + g.out.trim().split('\n').pop());
        const wipe = fs.readFileSync(path.join(p.app, 'deploy', 'db', 'wipe-public.sql'), 'utf8');
        const post = scanSql(sqlFile);
        r = await psqlStream(e0, ['BEGIN;\n', wipe], sqlFile, ['COMMIT;\n'], (bytes, ev) => {
          if (ev?.type === 'data') { if (cur) seen.add(cur.table); cur = { table: ev.table, tuples: 0 }; }
          else if (ev?.type === 'row' && cur) cur.tuples++;
          else if (ev?.type === 'end' && cur) { seen.add(cur.table); cur = null; }
          if (bytes < post.offset) progress(); else toIndex();
        });
        fs.rmSync(sqlFile, { force: true });
      }
    } finally { if (poll) clearInterval(poll); clearInterval(idxTimer); }
    if (r.code !== 0) throw new Error('database restore failed (rolled back by PostgreSQL): ' + r.out.trim().split('\n').filter(l => /ERROR|psql:/.test(l)).slice(-2).join(' '));
    for (const x of tables) seen.add(x.table);
    cur = null; progress();
    if (tr.phase(phaseData)?.state === 'running') tr.done(phaseData);
    if (tr.phase(phaseIdx)?.state !== 'running') tr.begin(phaseIdx);
    tr.done(phaseIdx);
    return su;
  };
  const migrate = async su => {
    const r = su ? await run(p.protectCmd, ['migrate'], { env: { ETS_ENV_FILE: p.envFile, ETS_APP_DIR: p.app } })
      : await runNode(p, 'src/db/migrate.js');
    if (r.code !== 0) throw new Error('migrations failed: ' + r.out.trim().split('\n').pop());
  };
  const putFiles = async () => {
    const m = readJsonFile(path.join(dir, 'config', 'manifest.json'));
    const from = f => path.join(dir, 'config', 'files', f);
    const stat = f => { try { return fs.statSync(f); } catch { return null; } };
    const keep = f => { const s = stat(f); if (s) { const d = path.join(safetyDir, 'files', f); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(f, d); fs.chmodSync(d, s.mode & 0o777); } changed.files.push({ path: f, existed: !!s, mode: s ? s.mode & 0o777 : null, uid: s?.uid, gid: s?.gid }); };
    const fileOf = item => (m.files || []).filter(f => f.item === item || (item === 'tls' && f.item === 'tls_tree'));
    if (has('env')) {
      const src = fileOf('env')[0]; if (!src) throw new Error('ets.env is not in the bundle');
      const old = parseKv(fs.readFileSync(from(src.path), 'utf8'));
      if (!old.APP_SECRET || old.APP_SECRET.length < 32) throw new Error('the bundle has no usable APP_SECRET');
      // only APP_SECRET (and a rotation in progress) come from the backup: this server keeps its own database connection
      keep(p.envFile);
      let text = fs.readFileSync(p.envFile, 'utf8');
      text = setEnvKv(text, 'APP_SECRET', old.APP_SECRET);
      text = setEnvKv(text, 'APP_SECRET_OLD', old.APP_SECRET_OLD ? old.APP_SECRET_OLD : null);
      const s = stat(p.envFile);
      writeAtomic(p.envFile, text, s.mode & 0o777);
      if (process.getuid?.() === 0) fs.chownSync(p.envFile, s.uid, s.gid);
    }
    if (has('install_conf')) {
      const src = fileOf('install_conf')[0]; if (!src) throw new Error('install.conf is not in the bundle');
      keep(p.installConf); copyKeep(from(src.path), p.installConf, 0o644, 0, 0);
    }
    if (has('db_ca')) {
      const src = fileOf('db_ca')[0]; if (!src) throw new Error('db-ca.crt is not in the bundle');
      const s = stat(p.dbCa);
      keep(p.dbCa); copyKeep(from(src.path), p.dbCa, 0o640, s?.uid ?? 0, s?.gid ?? 0);
    }
    if (has('tls')) {
      const cur = currentTls(p);
      const tree = (m.files || []).filter(f => f.item === 'tls_tree');
      if (tree.length) {
        for (const f of tree) {
          if (!f.path.startsWith('/etc/letsencrypt/')) throw new Error('unexpected certificate path');
          keep(f.path);
          if (f.type === 'link') { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.rmSync(f.path, { force: true }); fs.symlinkSync(f.target, f.path); }
          else copyKeep(from(f.path), f.path, parseInt(f.mode, 8) & 0o777, 0, 0);
        }
      } else {
        const certSrc = m.tls?.cert, keySrc = m.tls?.key;
        if (!certSrc || !keySrc || !fs.existsSync(from(certSrc)) || !fs.existsSync(from(keySrc))) throw new Error('the certificate is not in the bundle');
        if (cur.mode === 'letsencrypt') throw new Error('this server uses Let\'s Encrypt: its certificate is renewed automatically');
        // the certificate and its key must belong together
        const c = new crypto.X509Certificate(fs.readFileSync(from(certSrc)));
        if (!c.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(from(keySrc))))) throw new Error('certificate and key in the bundle do not match');
        keep(cur.cert); keep(cur.key);
        copyKeep(from(certSrc), cur.cert, 0o644, 0, 0);
        copyKeep(from(keySrc), cur.key, 0o600, 0, 0);
      }
      const nt = await run(p.nginx, ['-t']);
      if (nt.code !== 0) throw new Error('nginx refuses the restored certificate: ' + nt.out.trim().split('\n').pop());
      await run(p.systemctl, ['reload', 'nginx']);
      // phones pin the certificate: the fingerprint in ets.env (pairing QR) follows it
      const certFile = tree.length ? currentTls(p).cert : cur.cert;
      if (fs.existsSync(certFile) && currentTls(p).mode !== 'letsencrypt') {
        const fp = new crypto.X509Certificate(fs.readFileSync(certFile)).fingerprint256.replace(/:/g, '').toLowerCase();
        if (!changed.files.some(f => f.path === p.envFile)) keep(p.envFile);
        const s = stat(p.envFile);
        writeAtomic(p.envFile, setEnvKv(fs.readFileSync(p.envFile, 'utf8'), 'TLS_CERT_SHA256', fp).replace(`TLS_CERT_SHA256='${fp}'`, `TLS_CERT_SHA256=${fp}`), s.mode & 0o777);
        if (process.getuid?.() === 0) fs.chownSync(p.envFile, s.uid, s.gid);
        if (!stopApi) await run(p.systemctl, ['try-restart', p.service]);
      }
    }
  };
  const undoFiles = async () => {
    for (const f of changed.files.reverse()) {
      const saved = path.join(safetyDir, 'files', f.path);
      if (f.existed && fs.existsSync(saved)) copyKeep(saved, f.path, f.mode, f.uid, f.gid);
      else if (!f.existed) fs.rmSync(f.path, { force: true });
    }
    if (changed.files.some(f => /cert|key|pem|crt|letsencrypt/.test(f.path))) await run(p.systemctl, ['reload', 'nginx']);
  };

  // jobs that were queued / running when the backup was taken come back with the data: they are not carried out
  const cancelCarried = () => query(`UPDATE backup_jobs SET status='cancelled', finished_at=now(), result=jsonb_build_object('error','restored_from_backup')
    WHERE status IN ('queued','running') AND id <> $1`, [job.id]).catch(() => {});
  let su = false, audit = null;
  try {
    // 1. checksum + decrypt the dump again (the staged file; the key typed at the inspect step)
    if (db) {
      t.begin('checksum'); write(true);
      let done = 0; const total = ir.files.dump.size;
      t.count('bytes', 0, total);
      await checksum(dir, ir.files.dump.name, b => { done += b; t.count('bytes', done); t.advance('checksum', done / total); write(); });
      t.begin('decrypt'); done = 0; t.counters.bytes.done = 0;
      await gpgDecrypt(path.join(dir, ir.files.dump.name), path.join(dir, 'db.dump'), kf, b => { done += b; t.count('bytes', done); t.advance('decrypt', done / total); write(); });
    }
    // 2. safety copy of exactly what will be replaced
    if (db || cfgItems.length) {
      t.begin('safety'); write(true);
      safetyDir = path.join(p.backupDir, `pre-restore-${tsName}`);
      fs.mkdirSync(safetyDir, { recursive: true, mode: 0o700 });
      if (db) {
        const rf = path.join(dir, 'safety.txt');
        const est = Math.max(3, (sizes.db_bytes || 0) / 25e6);
        const t0 = Date.now();
        const iv = setInterval(() => { t.advance('safety', Math.min(0.95, (Date.now() - t0) / 1000 / est)); }, 500);
        const r = await run(p.backupCmd, ['--no-offsite'], { env: { ETS_BACKUP_RESULT_FILE: rf, ETS_BACKUP_LOCK_WAIT: '900' } });
        clearInterval(iv);
        safetyDump = (readText(rf) || '').trim();
        if (r.code !== 0 || !safetyDump) throw Object.assign(new Error('the safety backup failed — nothing was changed'), { before: true });
        status.safety = { dump: path.basename(safetyDump), dir: safetyDir };
      }
      t.done('safety');
    }
    // 3. stop the API only when the database or ets.env is replaced
    if (stopApi) {
      t.begin('stop'); write(true);
      fs.writeFileSync(activeFlag(p), String(job.id), { mode: 0o644 });   // nginx shows the maintenance page
      await run(p.systemctl, ['stop', p.service]); stopped = true;
      t.done('stop');
    }
    // 4. database
    if (db) {
      write(true);
      changed.db = true;
      su = await restoreDump(path.join(dir, 'db.dump'), t, 'restore_data', 'restore_index');
      fs.rmSync(path.join(dir, 'db.dump'), { force: true });
      await cancelCarried();
    }
    // 5. files
    if (cfgItems.length) { t.begin('config'); write(true); await putFiles(); t.done('config'); }
    // 6. migrations and audit chains
    if (db) {
      t.begin('migrate'); write(true); await migrate(su); t.done('migrate');
      t.begin('verify'); write(true);
      const va = await runNode(p, 'scripts/verify-audit.js', ['--json']);
      audit = va.code === 0 ? 'ok' : 'broken';
      if (va.code !== 0 && va.code !== 2) throw new Error('verify-audit could not run: ' + va.out.trim().split('\n').pop());
      t.done('verify');
    }
    // 7. sessions end, the restore is recorded in the (restored) database, the API starts
    if (db || has('env')) await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='restore' WHERE revoked_at IS NULL`).catch(() => {});
    if (stopApi) {
      t.begin('start'); write(true); await run(p.systemctl, ['start', p.service]); stopped = false; t.done('start');
      t.begin('health'); write(true);
      if (!(await health(p))) throw new Error('the application does not answer after the restore');
      t.done('health');
    }
    fs.rmSync(activeFlag(p), { force: true });
    if (has('logs')) {
      t.begin('logs'); write(true);
      const date = ir.logs?.date || 'unknown';
      const target = path.join(p.logDir, `restored-${date}`);
      if (fs.existsSync(target)) fs.renameSync(target, `${target}-${Date.now()}`);   // never overwrites
      fs.mkdirSync(target, { recursive: true, mode: 0o750 });
      const x = await run('tar', ['-xf', path.join(dir, 'logs.tar'), '-C', target, '--no-same-owner', '--no-same-permissions']);
      if (x.code !== 0) throw Object.assign(new Error('the logs could not be extracted'), { soft: true });
      t.done('logs');
    }
    status.state = 'done'; t.finish('done');
    status.audit = audit;
    write(true);
    await record(true);
    return { detached: true };
  } catch (e) {
    say(`restore ${job.id} failed:`, e.message);
    status.error = String(e.message).slice(0, 400);
    t.fail();
    if (e.before || (!changed.db && !changed.files.length)) {
      // nothing was replaced
      if (stopped) { await run(p.systemctl, ['start', p.service]); stopped = false; }
      fs.rmSync(activeFlag(p), { force: true });
      status.state = 'failed'; t.finish('failed'); write(true);
      await record(false);
      return { detached: true };
    }
    // automatic rollback of exactly what was replaced
    status.state = 'rolling_back'; write(true);
    const rb = new Tracker({ kind: 'rollback', sizes, skip: ['migrate', ...(changed.db ? [] : ['restore_data', 'restore_index']), ...(changed.files.length ? [] : ['config']), ...(stopApi ? [] : ['stop', 'start', 'health'])] });
    const rbw = setInterval(() => { status.rollback = rb.snapshot(); }, 500);
    try {
      rb.begin('stop'); if (!stopped && stopApi) { await run(p.systemctl, ['stop', p.service]); stopped = true; } rb.done('stop');
      if (changed.db && safetyDump) {
        const sk = p.backupKey;                    // the safety backup was made with this server's key
        await gpgDecrypt(safetyDump, path.join(dir, 'safety.dump'), sk);
        // the safety backup was taken by this version: no migration needed
        await restoreDump(path.join(dir, 'safety.dump'), rb, 'restore_data', 'restore_index');
        await cancelCarried();
        await query(`UPDATE sessions SET revoked_at=now(), revoke_reason='restore' WHERE revoked_at IS NULL`).catch(() => {});
      }
      if (changed.files.length) { rb.begin('config'); await undoFiles(); rb.done('config'); }
      rb.begin('start'); if (stopApi) { await run(p.systemctl, ['start', p.service]); stopped = false; } rb.done('start');
      rb.begin('health'); if (stopApi && !(await health(p))) throw new Error('the application does not answer after the rollback'); rb.done('health');
      rb.finish('done'); status.rollback = rb.snapshot(); status.state = 'rolled_back';
    } catch (e2) {
      rb.finish('failed'); status.rollback = { ...rb.snapshot(), error: String(e2.message).slice(0, 300) }; status.state = 'rollback_failed';
      say(`restore ${job.id}: ROLLBACK FAILED:`, e2.message);
    } finally { clearInterval(rbw); }
    fs.rmSync(activeFlag(p), { force: true });
    t.finish('failed'); write(true);
    await record(false);
    return { detached: true };
  } finally {
    clearInterval(ticker);
    if (stopped) await run(p.systemctl, ['start', p.service]);
    fs.rmSync(kf, { force: true });
    fs.rmSync(path.join(dir, 'db.dump'), { force: true }); fs.rmSync(path.join(dir, 'safety.dump'), { force: true });
  }

  // the outcome, in the database that is now in place: job row, system_log, audit row (who, which backup, items, verify)
  async function record(ok) {
    const actor = prm.actor || {};
    const detail = { ok, state: status.state, items, source: ir.source, backup: status.backup, audit: status.audit || null, error: status.error,
      safety: status.safety || null, rollback: status.rollback ? { state: status.rollback.state, error: status.rollback.error || null } : null,
      by: { id: actor.id || null, username: actor.username || null }, job_id: job.id };
    try {
      await query(`INSERT INTO backup_jobs(id, kind, params, requested_by, requested_at, status, started_at, finished_at, result, progress)
        VALUES ($1,'restore_run',$2,NULL,$3,$4,$3,now(),$5,$6)
        ON CONFLICT (id) DO UPDATE SET status=$4, finished_at=now(), result=$5, progress=$6`,
      [job.id, JSON.stringify({ inspect_id: prm.inspect_id, items, actor }), job.requested_at, ok ? 'ok' : 'failed', JSON.stringify(detail), JSON.stringify(t.snapshot())]);
      await query(`SELECT setval(pg_get_serial_sequence('backup_jobs','id'), GREATEST((SELECT max(id) FROM backup_jobs), 1))`);
    } catch (e) { say('restore: job row not written:', e.message); }
    await query(`INSERT INTO system_log(level, event, message, detail) VALUES ($1, 'restore', $2, $3)`,
      [ok ? 'info' : 'error', ok ? 'restore from the web UI finished' : 'restore from the web UI failed', JSON.stringify(detail)]).catch(e => say('restore: system_log not written:', e.message));
    if (ok) {
      // the author is named by user name; the id is kept only when that account exists in the restored data
      const u = actor.id ? (await query('SELECT id FROM users WHERE id=$1 AND username=$2', [actor.id, actor.username]).catch(() => ({ rows: [] }))).rows[0] : null;
      await query(`INSERT INTO audit_log(user_id, username, action, entity, entity_id, summary, new_value, context, ip)
        VALUES ($1,$2,'restore','database',$3,$4,$5,$6,$7)`,
      [u?.id || null, actor.username || 'ets-backup-agent', status.backup.dump || status.backup.config || status.backup.logs,
        'restore from backup: ' + items.join(', '),
        JSON.stringify({ file: status.backup.dump, config: status.backup.config, logs: status.backup.logs, items, source: ir.source, backup_created: status.backup.created, verify: status.audit }),
        JSON.stringify({ via: 'web', job_id: job.id }), actor.ip || null]).catch(e => say('restore: audit row not written:', e.message));
    }
  }
}
