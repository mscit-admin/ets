// /api/backups — Settings → «النسخ الاحتياطي» (1.12.0). System administrators only (cfg + the admin role).
// The API runs unprivileged and never executes anything as root: it stores the desired configuration and queues jobs
// (backup_jobs) that the root backup agent validates again and carries out (backend/src/backup/agent.js).
//
//   GET    /                  configuration (secrets: only «saved» flags), status, summary, recent jobs, escrow
//   PUT    /config            configuration; destinations / secrets need the password (and 2FA code) again
//   POST   /escrow            the administrator attests that the backup key / passphrase is escrowed
//   POST   /passphrase        a new backup passphrase (password + 2FA again); old backups still need the old key
//   POST   /jobs              backup_now | verify_now | test_destination | generate_ssh_key (rate-limited)
//   GET    /jobs/:id          a job's status, progress and result (polled by the UI)
//   POST   /restore/plan      what a backup point offers (available items, reasons, warnings) — no key needed
//   POST   /upload            an encrypted backup file to restore from (raw body, size limit)
//   POST   /restore/inspect   password + 2FA + the backup key → inspection job (nothing is changed)
//   POST   /restore/run       confirmation phrase → the restore job (the agent stops / starts the API as needed)
//   GET    /restore/status    the progress file of the current / last restore
// Every change and every request is in the change history with readable sentences; secrets never are.
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import rateLimit from 'express-rate-limit';
import { query, tx } from '../db/pool.js';
import { config as appConfig } from '../config.js';
import { requireAuth, requirePerm, requireAdmin } from '../middleware/auth.js';
import { HttpError, idParam, notFound } from '../utils/http.js';
import { logAudit, logSystem } from '../services/logs.js';
import { encrypt } from '../services/crypto.js';
import { allSettings } from '../services/settings.js';
import { backupSummary } from '../services/backup-status.js';
import { activeUsers, deliver } from '../services/notify.js';
import { reauth } from './auth.js';
import { DEFAULT_CONFIG, LIMITS, FREQUENCIES, S3_PROVIDERS, SECRET_KEYS, validateConfig, validSecret, destinationsChanged,
  passphraseProblem, restoreKeyProblem, parseArtifact, configFor, availability, selectionProblem, restoreWarnings, appSecretFp,
  confirmPhraseOk, RESTORE_ITEMS, cmpVersion, parseKv, keyId, sameConfig, canon } from '../backup/config.js';
import { agentPaths, sealSecret, readJsonFile } from '../backup/agent-util.js';

const r = Router();
r.use(requireAuth, requirePerm('cfg'), requireAdmin);

const P = () => agentPaths();
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const UPLOAD_MAX_BYTES = Math.max(1, +(process.env.ETS_UPLOAD_MAX_MB || 4096)) * 1024 * 1024;
const JOB_KINDS_UI = ['backup_now', 'verify_now', 'test_destination', 'generate_ssh_key'];
const WRONG_KEY_LIMIT = 3, WRONG_KEY_WINDOW_MIN = 15;

const perUser = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u:' + req.user.id,
  handler: (req, res) => res.status(429).json({ error: 'too_many_requests', retry_after: Math.ceil(windowMs / 1000) }) });
const jobLimiter = perUser(+(process.env.ETS_BACKUP_JOB_LIMIT || 20), 10 * 60_000);
const restoreLimiter = perUser(+(process.env.ETS_RESTORE_LIMIT || 10), 15 * 60_000);
const uploadLimiter = perUser(10, 60 * 60_000);

// ---------------------------------------------------------------- helpers
async function loadConfig() {
  const row = (await query('SELECT * FROM backup_config WHERE id=1')).rows[0];
  if (row) return row;
  return { config: structuredClone(DEFAULT_CONFIG), secrets: {}, version: 0, source: 'default', escrow_confirmed_at: null, key_id: null };
}
const secretFlags = s => Object.fromEntries(SECRET_KEYS.map(k => [k, !!s?.[k]]));
function escrowState(row, keyIdNow) {
  const at = row.escrow_confirmed_at ? new Date(row.escrow_confirmed_at) : null;
  const due = !!(!at || Date.now() - at > 365 * 864e5 || (row.key_changed_at && at < new Date(row.key_changed_at)));
  return { confirmed_at: at, confirmed_by: row.escrow_confirmed_by || null, due, key_id: keyIdNow || row.key_id || null };
}
function wake() {
  // the agent starts at once (ets-backup-agent.path); otherwise within 30 s (ets-backup-agent.timer)
  try { fs.writeFileSync(path.join(P().inbox, '.wake'), String(Date.now()), { mode: 0o600 }); } catch { /* the timer picks it up */ }
}
const publicJob = j => j && ({ id: Number(j.id), kind: j.kind, status: j.status, requested_at: j.requested_at, started_at: j.started_at, finished_at: j.finished_at,
  requested_by: j.requested_by, by_name: j.by_name || null, params: Object.fromEntries(Object.entries(j.params || {}).filter(([k]) => !['ck', 'token', 'uploads'].includes(k))),
  progress: j.progress || null, result: j.result || null, log: j.log || null });
async function queue(kind, params, req, client = null) {
  const q = client || { query };
  try {
    return (await q.query(`INSERT INTO backup_jobs(kind, params, requested_by) VALUES ($1,$2,$3) RETURNING *`, [kind, JSON.stringify(params), req.user.id])).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'job_already_queued');
    throw e;
  }
}
function putSecret(secret) {
  const { ck, blob } = sealSecret(secret);
  const token = crypto.randomBytes(24).toString('base64url');
  const dir = P().inbox;
  try { fs.writeFileSync(path.join(dir, token + '.sec'), blob, { mode: 0o600, flag: 'wx' }); }
  catch (e) { throw new HttpError(503, 'backup_agent_unavailable', { reason: e.code }); }
  return { token, ck };
}
const twoFactor = req => reauth(req, { password: req.body?.password, secondFactor: true, events: ['backup_reauth_bad_password', 'backup_reauth_bad_code'] });
function current() {
  const a = parseKv((() => { try { return fs.readFileSync(P().installConf, 'utf8'); } catch { return ''; } })());
  return { hostname: os.hostname(), ips: Object.values(os.networkInterfaces()).flat().filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address),
    address: a.DEF_ADDRESS || null, app_version: pkg.version, app_secret_fp: appSecretFp(appConfig.appSecret) };
}

// ---------------------------------------------------------------- overview
r.get('/', async (req, res) => {
  const row = await loadConfig();
  const st = (await query('SELECT data, applied_version, apply_error, agent_seen_at FROM backup_status WHERE id=1')).rows[0] || {};
  const jobs = (await query(`SELECT j.*, u.full_name AS by_name FROM backup_jobs j LEFT JOIN users u ON u.id=j.requested_by
    ORDER BY j.id DESC LIMIT 15`)).rows.map(publicJob);
  const s = await allSettings();
  res.json({
    config: row.config, secrets: secretFlags(row.secrets), version: row.version, source: row.source,
    applied_version: st.applied_version ?? null, apply_error: st.apply_error || null,
    agent: { seen_at: st.agent_seen_at || null, ok: !!st.agent_seen_at && Date.now() - new Date(st.agent_seen_at) < 3 * 60_000 },
    escrow: escrowState(row, st.data?.key_id), status: st.data || null, summary: await backupSummary(s), jobs,
    limits: { retention: LIMITS, frequencies: FREQUENCIES, providers: S3_PROVIDERS, upload_max_bytes: UPLOAD_MAX_BYTES },
    current: current(),
  });
});

// ---------------------------------------------------------------- configuration
r.put('/config', async (req, res) => {
  const v = validateConfig(req.body?.config);
  if (!v.ok) throw new HttpError(400, 'invalid_backup_config', { key: v.field, reason: v.reason });
  const row = await loadConfig();
  const inSecrets = req.body?.secrets && typeof req.body.secrets === 'object' ? req.body.secrets : {};
  const secrets = { ...(row.secrets || {}) };
  const secretChanges = [];
  for (const k of SECRET_KEYS) {
    if (!Object.hasOwn(inSecrets, k) || inSecrets[k] === undefined || inSecrets[k] === '') continue;   // empty = keep
    if (inSecrets[k] === null) { if (secrets[k]) { delete secrets[k]; secretChanges.push(k); } continue; }
    if (!validSecret(k, inSecrets[k])) throw new HttpError(400, 'invalid_backup_config', { key: 'cloud.' + k, reason: 'invalid' });
    secrets[k] = encrypt(inSecrets[k], 'backup:' + k);
    secretChanges.push(k);
  }
  const c = v.value;
  if (c.cloud.enabled && c.cloud.mode === 's3' && SECRET_KEYS.some(k => !secrets[k])) {
    throw new HttpError(400, 'invalid_backup_config', { key: 'cloud.cloud_secret_access_key', reason: 'required' });
  }
  const destChanged = destinationsChanged(row.config, c);
  // destinations and credentials: the administrator confirms with the password (and the 2FA code) again
  if (destChanged || secretChanges.length) await twoFactor(req);
  const oldC = row.config;
  if (sameConfig(oldC, c) && !secretChanges.length) return res.json({ ok: true, version: row.version, unchanged: true });
  const out = await tx(async cl => {
    const n = (await cl.query(`INSERT INTO backup_config(id, config, secrets, version, source, updated_by) VALUES (1,$1,$2,1,'ui',$3)
      ON CONFLICT (id) DO UPDATE SET config=$1, secrets=$2, version=backup_config.version+1, source='ui', updated_at=now(), updated_by=$3
      RETURNING version`, [JSON.stringify(c), JSON.stringify(secrets), req.user.id])).rows[0].version;
    // the change history: old → new of every changed field; secrets only as «changed»
    const flat = (o, pre = '') => Object.entries(o || {}).flatMap(([k, x]) => (x && typeof x === 'object' && !Array.isArray(x) ? flat(x, pre + k + '.') : [[pre + k, x]]));
    const before = Object.fromEntries(flat(oldC)), after = Object.fromEntries(flat(c));
    const changes = Object.keys({ ...before, ...after }).filter(k => canon(before[k]) !== canon(after[k]))
      .map(k => ({ field: k, old: before[k] ?? null, new: after[k] ?? null }));
    for (const k of secretChanges) changes.push({ field: 'cloud.' + k, old: row.secrets?.[k] ? '••••' : null, new: secrets[k] ? '•••• (changed)' : null, secret: true });
    await logAudit(req, { db: cl, action: 'update', entity: 'backup_config', entityId: String(n), summary: changes.map(x => x.field).join(', ').slice(0, 200),
      oldValue: Object.fromEntries(changes.map(x => [x.field, x.old])), newValue: Object.fromEntries(changes.map(x => [x.field, x.new])),
      context: { via: 'backup_settings', changes, reauth: destChanged || secretChanges.length > 0 } });
    return n;
  });
  wake();
  res.json({ ok: true, version: out });
});

r.post('/escrow', async (req, res) => {
  if (req.body?.confirmed !== true) throw new HttpError(400, 'confirmation_required');
  const row = await loadConfig();
  if (!row.version) await query(`INSERT INTO backup_config(id, config) VALUES (1,$1) ON CONFLICT (id) DO NOTHING`, [JSON.stringify(DEFAULT_CONFIG)]);
  const kid = (await query('SELECT data->>\'key_id\' AS k FROM backup_status WHERE id=1')).rows[0]?.k || row.key_id || null;
  await tx(async cl => {
    await cl.query('UPDATE backup_config SET escrow_confirmed_at=now(), escrow_confirmed_by=$1 WHERE id=1', [req.user.id]);
    await logAudit(req, { db: cl, action: 'escrow_confirm', entity: 'backup_config', entityId: kid, summary: 'backup key escrow confirmed',
      newValue: { key_id: kid, confirmed_at: new Date().toISOString() } });
  });
  res.json({ ok: true });
});

r.post('/passphrase', restoreLimiter, async (req, res) => {
  const pp = req.body?.passphrase;
  const problem = passphraseProblem(pp);
  if (problem) throw new HttpError(400, 'weak_passphrase', { reason: problem });
  await twoFactor(req);
  const { token, ck } = putSecret(pp);
  const job = await tx(async cl => {
    const j = await queue('set_passphrase', { token, ck, key_id: keyId(pp) }, req, cl);
    await logAudit(req, { db: cl, action: 'passphrase_change', entity: 'backup_config', entityId: String(j.id), summary: 'new backup passphrase',
      newValue: { key_id: keyId(pp), passphrase: '••••' } });
    return j;
  });
  wake();
  res.status(202).json({ job: publicJob(job) });
});

// ---------------------------------------------------------------- jobs
r.post('/jobs', jobLimiter, async (req, res) => {
  const kind = req.body?.kind;
  if (!JOB_KINDS_UI.includes(kind)) throw new HttpError(400, 'invalid_job_kind');
  const params = {};
  if (kind === 'test_destination') {
    if (!['ssh', 'nas', 'cloud'].includes(req.body?.dest)) throw new HttpError(400, 'invalid_destination');
    params.dest = req.body.dest;
  }
  if (kind === 'generate_ssh_key') {
    params.rotate = req.body?.rotate === true;
    await twoFactor(req);     // a key that opens a destination
  }
  if (kind === 'backup_now') {
    const st = (await query('SELECT data FROM backup_status WHERE id=1')).rows[0]?.data;
    const cfg = (await loadConfig()).config;
    params.db_bytes = (st?.local || []).find(f => f.kind === 'dump')?.meta?.db_size || 0;
    params.dests = ['ssh', 'nas', 'cloud'].filter(d => cfg[d]?.enabled).length;
  }
  const job = await tx(async cl => {
    const j = await queue(kind, params, req, cl);
    await logAudit(req, { db: cl, action: 'backup_job', entity: 'backup_job', entityId: String(j.id), summary: kind, newValue: { kind, ...params } });
    return j;
  });
  wake();
  res.status(202).json({ job: publicJob(job) });
});

r.get('/jobs/:id', async (req, res) => {
  const j = (await query(`SELECT j.*, u.full_name AS by_name FROM backup_jobs j LEFT JOIN users u ON u.id=j.requested_by WHERE j.id=$1`, [idParam(req.params.id)])).rows[0];
  if (!j) throw notFound();
  res.json({ job: publicJob(j) });
});

// ---------------------------------------------------------------- restore
const SOURCES = ['local', 'ssh', 'nas', 'cloud', 'upload'];
// names on a source, with their .meta when known (local files and uploads); destinations: names only
async function sourceFiles(source, uploads) {
  const st = (await query('SELECT data FROM backup_status WHERE id=1')).rows[0]?.data || {};
  if (source === 'local') return { names: (st.local || []).map(f => f.name), metas: Object.fromEntries((st.local || []).map(f => [f.name, f.meta || {}])) };
  if (source === 'upload') {
    const names = [], metas = {};
    for (const [name, id] of Object.entries(uploads || {})) {
      if (!parseArtifact(name) || !/^[A-Za-z0-9_-]{16,64}$/.test(String(id))) continue;
      if (!fs.existsSync(path.join(P().upload, id, name))) continue;
      names.push(name); metas[name] = readJsonFile(path.join(P().upload, id, name + '.meta')) || {};
    }
    return { names, metas };
  }
  const names = st.destinations?.[source] || [];
  const local = Object.fromEntries((st.local || []).map(f => [f.name, f.meta || {}]));
  return { names, metas: Object.fromEntries(names.filter(n => local[n]).map(n => [n, local[n]])) };
}
function pickPoint(body, names) {
  const has = n => n && names.includes(n);
  const dump = body?.dump ? (has(body.dump) && parseArtifact(body.dump)?.kind === 'dump' ? body.dump : '!') : null;
  if (dump === '!') throw new HttpError(400, 'backup_file_not_found', { file: 'dump' });
  let cfg = body?.config ?? undefined;
  if (cfg === undefined) cfg = dump ? configFor(dump, names) : null;                // the bundle in force at the dump's time
  else if (cfg !== null && !(has(cfg) && parseArtifact(cfg)?.kind === 'config')) throw new HttpError(400, 'backup_file_not_found', { file: 'config' });
  const logs = body?.logs ? (has(body.logs) && parseArtifact(body.logs)?.kind === 'logs' ? body.logs : '!') : null;
  if (logs === '!') throw new HttpError(400, 'backup_file_not_found', { file: 'logs' });
  return { dump, config: cfg, logs };
}
async function plan(body) {
  if (!SOURCES.includes(body?.source)) throw new HttpError(400, 'invalid_source');
  const { names, metas } = await sourceFiles(body.source, body.uploads);
  const point = pickPoint(body, names);
  const avail = availability(point, metas);
  const items = Array.isArray(body?.items) ? body.items : [];
  const warnings = items.length ? restoreWarnings(items, point, metas, current()) : [];
  return { source: body.source, point, available: avail, warnings, metas: Object.fromEntries(Object.entries(metas).filter(([n]) => Object.values(point).includes(n))) };
}
r.post('/restore/plan', async (req, res) => {
  const p = await plan(req.body);
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  res.json({ ...p, problem: items.length ? selectionProblem(items, p.available) : null });
});

// raw upload of one encrypted backup file (or its .sha256 / .meta); the restore wizard then inspects it
r.post('/upload', uploadLimiter, async (req, res) => {
  const name = String(req.query.name || '');
  const base = name.replace(/\.(sha256|meta)$/, '');
  if (!parseArtifact(base) || !/\.gpg(\.(sha256|meta))?$/.test(name)) throw new HttpError(400, 'invalid_file_name');
  const len = +req.headers['content-length'] || 0;
  const max = name === base ? UPLOAD_MAX_BYTES : 64 * 1024;
  if (len > max) throw new HttpError(413, 'file_too_large', { max });
  let id = String(req.query.upload_id || '');
  if (id && !/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new HttpError(400, 'invalid_upload_id');
  id ||= crypto.randomBytes(16).toString('base64url');
  const dir = path.join(P().upload, id);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { throw new HttpError(503, 'backup_agent_unavailable', { reason: e.code }); }
  const file = path.join(dir, name);
  let n = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file + '.part', { mode: 0o600 });
    req.on('data', b => { n += b.length; if (n > max) { req.unpipe(out); out.destroy(); reject(new HttpError(413, 'file_too_large', { max })); } });
    req.on('aborted', () => reject(new HttpError(400, 'upload_aborted')));
    out.on('error', reject);
    out.on('finish', resolve);
    req.pipe(out);
  }).catch(e => { fs.rmSync(file + '.part', { force: true }); throw e; });
  fs.renameSync(file + '.part', file);
  await logAudit(req, { action: 'backup_upload', entity: 'backup_file', entityId: name, summary: `${name} (${n} bytes)`, newValue: { name, size: n } });
  res.json({ upload_id: id, name, size: n });
});

async function wrongKeyLock() {
  const rows = (await query(`SELECT finished_at FROM backup_jobs WHERE kind='restore_inspect' AND result->>'error'='wrong_key'
    AND finished_at > now() - make_interval(mins => $1) ORDER BY finished_at`, [WRONG_KEY_WINDOW_MIN])).rows;
  if (rows.length < WRONG_KEY_LIMIT) return null;
  const until = new Date(new Date(rows[rows.length - WRONG_KEY_LIMIT].finished_at).getTime() + WRONG_KEY_WINDOW_MIN * 60_000);
  return until > new Date() ? until : null;
}

r.post('/restore/inspect', restoreLimiter, async (req, res) => {
  const until = await wrongKeyLock();
  if (until) throw new HttpError(429, 'restore_locked', { retry_after: Math.ceil((until - Date.now()) / 1000), until });
  const keyProblem = restoreKeyProblem(req.body?.key);
  if (keyProblem) throw new HttpError(400, 'backup_key_required', { reason: keyProblem });
  const p = await plan(req.body);
  const items = req.body?.items;
  const problem = selectionProblem(items, p.available);
  if (problem) throw new HttpError(400, 'invalid_restore_selection', { reason: problem });
  if (p.warnings.some(w => w.blocking)) throw new HttpError(409, 'restore_blocked', { warnings: p.warnings });
  // the three factors: password, 2FA code (when enabled) — checked here —, the backup key (checked by the agent)
  await twoFactor(req);
  const open = (await query(`SELECT 1 FROM backup_jobs WHERE kind IN ('restore_inspect','restore_run') AND status IN ('queued','running')`)).rowCount;
  if (open) throw new HttpError(409, 'restore_in_progress');
  const { token, ck } = putSecret(req.body.key.trim());
  const files = Object.fromEntries(Object.entries(p.point).filter(([, n]) => n && items.some(i => p.available[i]?.from === n)));
  const job = await tx(async cl => {
    const j = await queue('restore_inspect', { token, ck, source: p.source, ...{ dump: null, config: null, logs: null }, ...files, items,
      uploads: p.source === 'upload' ? req.body.uploads : undefined }, req, cl);
    await logAudit(req, { db: cl, action: 'restore_inspect', entity: 'backup_job', entityId: String(j.id), summary: `inspect ${Object.values(files).join(', ')}`,
      newValue: { source: p.source, files, items } });
    return j;
  });
  wake();
  res.status(202).json({ job: publicJob(job), warnings: p.warnings });
});

r.post('/restore/run', restoreLimiter, async (req, res) => {
  const ins = (await query(`SELECT * FROM backup_jobs WHERE id=$1 AND kind='restore_inspect'`, [idParam(String(req.body?.inspect_id ?? ''), 'inspect_id')])).rows[0];
  if (!ins || ins.requested_by !== req.user.id) throw notFound();
  if (ins.status !== 'ok' || Date.now() - new Date(ins.finished_at) > 15 * 60_000) throw new HttpError(409, 'inspection_expired');
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length || items.some(i => !ins.result.items.includes(i)) || new Set(items).size !== items.length) {
    throw new HttpError(400, 'invalid_restore_selection', { reason: 'items_not_inspected' });
  }
  if (items.includes('db') && ins.result.blocking?.length) throw new HttpError(409, 'restore_blocked', { blocking: ins.result.blocking });
  if (!confirmPhraseOk(req.body?.confirm, os.hostname())) throw new HttpError(400, 'confirmation_phrase_mismatch');
  const job = await tx(async cl => {
    const j = await queue('restore_run', { inspect_id: Number(ins.id), items, actor: { id: req.user.id, username: req.user.username, ip: req.ip || null } }, req, cl);
    await logAudit(req, { db: cl, action: 'restore_start', entity: 'backup_job', entityId: String(j.id),
      summary: `restore ${items.join(', ')} from ${ins.result.source}`,
      newValue: { items, source: ins.result.source, files: Object.fromEntries(Object.entries(ins.result.files || {}).map(([k, f]) => [k, f.name])),
        backup_created: ins.result.dump?.created || ins.result.config?.created || null } });
    return j;
  });
  await logSystem('restore_requested', 'restore requested from the web UI', { job_id: Number(job.id), items, by: req.user.username });
  // S11: every administrator is told that a restore starts (in-app and phone)
  const admins = (await activeUsers()).filter(u => u.role === 'admin');
  await deliver('restore_event', admins.map(user => ({ user, dedupeKey: `restore_event:start:${job.id}`, link: '/settings#backups',
    params: { stage: 'started', by: req.user.full_name || req.user.username, created: ins.result.dump?.created || ins.result.config?.created || null, items } })));
  wake();
  res.status(202).json({ job: publicJob(job) });
});

r.get('/restore/status', async (req, res) => {
  const s = readJsonFile(path.join(P().restoreDir, 'status.json'));
  res.json({ status: s });
});

export const _test = { wrongKeyLock, plan, current, cmpVersion, RESTORE_ITEMS };
export default r;
