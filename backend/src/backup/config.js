// Backups (1.12.0): the configuration managed from Settings → «النسخ الاحتياطي», shared by the API (unprivileged) and the
// root backup agent (backend/scripts/backup-agent.js). Pure: validation with strict patterns, rendering of
// /etc/ets/backup.conf, /etc/ets/rclone.conf and the systemd timer drop-ins, key ids, restore selection rules.
//
// Trust boundary: the API stores the DESIRED configuration in the database; the agent runs as root and validates it
// again with these same functions before it writes anything. Nothing typed by a user reaches a shell: values are
// matched against whitelists, rendered into KEY='value' files that the scripts read as data, and the commands are
// started with argument arrays.
import crypto from 'node:crypto';

export const DEFAULT_CONFIG = Object.freeze({
  frequency_hours: 1,          // 1 | 2 | 4 | 6 | 12 | 24
  daily_time: '01:30',         // the run time when frequency_hours = 24
  logs_time: '00:45',          // the day's logs bundle: first run at or after this time
  verify: { enabled: true, weekday: 5, time: '03:00' },   // weekly test restore (0 = Sunday … 5 = Friday)
  retention: { hourly_hours: 48, daily_days: 30, weekly_weeks: 12, monthly_months: 12 },
  ssh: { enabled: false, target: '', port: 22, prune: true },
  nas: { enabled: false, dir: '', prune: true },
  // mode 's3': S3-compatible storage configured here (keys entered in the UI, stored encrypted);
  // mode 'rclone': a remote the administrator configured in /etc/ets/rclone.conf by hand (name:bucket/path)
  cloud: { enabled: false, mode: 's3', provider: 'AWS', endpoint: '', region: '', bucket: '', path: 'ets', remote: '', prune: true },
});
export const FREQUENCIES = [1, 2, 4, 6, 12, 24];
export const LIMITS = { hourly_hours: [1, 168], daily_days: [1, 3650], weekly_weeks: [0, 520], monthly_months: [0, 240] };
export const S3_PROVIDERS = ['AWS', 'Minio', 'Ceph', 'Wasabi', 'DigitalOcean', 'Cloudflare', 'Scaleway', 'IDrive', 'Other'];
export const SECRET_KEYS = ['cloud_access_key_id', 'cloud_secret_access_key'];
export const DESTS = ['ssh', 'nas', 'cloud'];

// ---------------------------------------------------------------- strict patterns (same as deploy/scripts/backup-lib.sh)
const NO_DOTDOT = s => !/(^|\/)\.\.(\/|$)/.test(s);
export const RE = {
  time: /^([01][0-9]|2[0-3]):[0-5][0-9]$/,
  sshTarget: /^([a-z_][a-z0-9_.-]{0,31})@([A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?):([A-Za-z0-9._/+-]{0,200})$/,
  nasDir: /^\/(mnt|media|srv)\/[A-Za-z0-9._@+-][A-Za-z0-9._/@+-]*$/,
  remote: /^[A-Za-z0-9_-]{1,40}:([A-Za-z0-9._/-]{0,200})$/,
  endpoint: /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?\/?$/,
  region: /^[a-z0-9-]{0,40}$/,
  bucket: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  path: /^[A-Za-z0-9._/-]{0,200}$/,
  accessKey: /^[A-Za-z0-9/+=_-]{8,128}$/,
  secretKey: /^[\x21-\x7e]{8,256}$/,                     // printable ASCII, no spaces, no line breaks
  artifact: /^ets-(?:([0-9]{8}-[0-9]{6})\.dump(?:\.gpg)?|config-([0-9]{8}-[0-9]{6})\.tar\.gpg|logs-([0-9]{8})\.tar\.gpg)$/,
};
export const validSshTarget = s => typeof s === 'string' && RE.sshTarget.test(s) && NO_DOTDOT(s.split(':')[1]) && !s.split(':')[1].startsWith('-');
export const validNasDir = s => typeof s === 'string' && RE.nasDir.test(s) && NO_DOTDOT(s) && s.length <= 200;
export const validRemote = s => typeof s === 'string' && RE.remote.test(s) && NO_DOTDOT(s.split(':')[1]);

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const bool = v => typeof v === 'boolean';
const onlyKeys = (o, keys) => Object.keys(o).every(k => keys.includes(k));

// validateConfig(input) → { ok: true, value } | { ok: false, field, reason }. Unknown keys are refused.
export function validateConfig(c) {
  const bad = (field, reason = 'invalid') => ({ ok: false, field, reason });
  if (!isObj(c)) return bad('config', 'not_an_object');
  if (!onlyKeys(c, Object.keys(DEFAULT_CONFIG))) return bad('config', 'unknown_key');
  const v = structuredClone(DEFAULT_CONFIG);
  if (c.frequency_hours !== undefined) { if (!FREQUENCIES.includes(c.frequency_hours)) return bad('frequency_hours'); v.frequency_hours = c.frequency_hours; }
  for (const k of ['daily_time', 'logs_time']) {
    if (c[k] !== undefined) { if (typeof c[k] !== 'string' || !RE.time.test(c[k])) return bad(k); v[k] = c[k]; }
  }
  if (c.verify !== undefined) {
    if (!isObj(c.verify) || !onlyKeys(c.verify, ['enabled', 'weekday', 'time'])) return bad('verify');
    const x = { ...v.verify, ...c.verify };
    if (!bool(x.enabled)) return bad('verify.enabled');
    if (!int(x.weekday, 0, 6)) return bad('verify.weekday');
    if (typeof x.time !== 'string' || !RE.time.test(x.time)) return bad('verify.time');
    v.verify = x;
  }
  if (c.retention !== undefined) {
    if (!isObj(c.retention) || !onlyKeys(c.retention, Object.keys(LIMITS))) return bad('retention');
    const x = { ...v.retention, ...c.retention };
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (!int(x[k], lo, hi)) return bad('retention.' + k, 'out_of_range');
    v.retention = x;
  }
  if (c.ssh !== undefined) {
    if (!isObj(c.ssh) || !onlyKeys(c.ssh, ['enabled', 'target', 'port', 'prune'])) return bad('ssh');
    const x = { ...v.ssh, ...c.ssh };
    if (!bool(x.enabled) || !bool(x.prune)) return bad('ssh');
    if (!int(x.port, 1, 65535)) return bad('ssh.port');
    if (typeof x.target !== 'string' || (x.target !== '' && !validSshTarget(x.target))) return bad('ssh.target');
    if (x.enabled && !x.target) return bad('ssh.target', 'required');
    v.ssh = x;
  }
  if (c.nas !== undefined) {
    if (!isObj(c.nas) || !onlyKeys(c.nas, ['enabled', 'dir', 'prune'])) return bad('nas');
    const x = { ...v.nas, ...c.nas };
    if (!bool(x.enabled) || !bool(x.prune)) return bad('nas');
    if (typeof x.dir !== 'string' || (x.dir !== '' && !validNasDir(x.dir))) return bad('nas.dir', 'outside_allowed_paths');
    if (x.enabled && !x.dir) return bad('nas.dir', 'required');
    v.nas = x;
  }
  if (c.cloud !== undefined) {
    if (!isObj(c.cloud) || !onlyKeys(c.cloud, Object.keys(DEFAULT_CONFIG.cloud))) return bad('cloud');
    const x = { ...v.cloud, ...c.cloud };
    if (!bool(x.enabled) || !bool(x.prune)) return bad('cloud');
    if (!['s3', 'rclone'].includes(x.mode)) return bad('cloud.mode');
    if (!S3_PROVIDERS.includes(x.provider)) return bad('cloud.provider');
    if (typeof x.endpoint !== 'string' || (x.endpoint && !RE.endpoint.test(x.endpoint))) return bad('cloud.endpoint');
    if (typeof x.region !== 'string' || !RE.region.test(x.region)) return bad('cloud.region');
    if (typeof x.bucket !== 'string' || (x.bucket && !RE.bucket.test(x.bucket))) return bad('cloud.bucket');
    if (typeof x.path !== 'string' || !RE.path.test(x.path) || !NO_DOTDOT(x.path)) return bad('cloud.path');
    if (typeof x.remote !== 'string' || (x.remote && !validRemote(x.remote))) return bad('cloud.remote');
    if (x.enabled && x.mode === 's3' && !x.bucket) return bad('cloud.bucket', 'required');
    if (x.enabled && x.mode === 's3' && x.provider !== 'AWS' && !x.endpoint) return bad('cloud.endpoint', 'required');
    if (x.enabled && x.mode === 'rclone' && !x.remote) return bad('cloud.remote', 'required');
    v.cloud = x;
  }
  return { ok: true, value: v };
}
export const validSecret = (k, s) => (k === 'cloud_access_key_id' ? RE.accessKey : RE.secretKey).test(String(s ?? ''));

// The parts whose change needs the administrator's password again (destinations; secrets are checked separately).
// JSON with sorted keys: a value read back from jsonb compares equal to the same value built in JavaScript
export const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
export const sameConfig = (a, b) => canon(a) === canon(b);
export const destinationsChanged = (a, b) => DESTS.some(d => canon(a?.[d]) !== canon(b?.[d]));

// ---------------------------------------------------------------- rendering (agent)
const q = v => `'${String(v)}'`;      // values passed validateConfig: no quotes, spaces or line breaks
export function cloudRemote(c) {
  if (!c.cloud.enabled) return '';
  if (c.cloud.mode === 'rclone') return c.cloud.remote;
  return `ets-cloud:${c.cloud.bucket}${c.cloud.path ? '/' + c.cloud.path.replace(/^\/+|\/+$/g, '') : ''}`;
}
export function renderBackupConf(c, { confDir = '/etc/ets', version = 0 } = {}) {
  const r = c.retention;
  return [
    '# /etc/ets/backup.conf — written by ets-backup-agent from Settings → «النسخ الاحتياطي» (configuration version ' + version + ').',
    '# Do not edit: changes are made in the web UI and this file is rewritten. Read as KEY=value data, never executed.',
    `BACKUP_FREQUENCY_HOURS=${c.frequency_hours}`,
    `BACKUP_LOGS_TIME=${q(c.logs_time)}`,
    `BACKUP_KEEP_HOURLY=${r.hourly_hours}`,
    `BACKUP_KEEP_DAILY=${r.daily_days}`,
    `BACKUP_KEEP_WEEKLY=${r.weekly_weeks}`,
    `BACKUP_KEEP_MONTHLY=${r.monthly_months}`,
    `BACKUP_VERIFY_ENABLED=${c.verify.enabled ? 'yes' : 'no'}`,
    `BACKUP_SSH_TARGET=${q(c.ssh.enabled ? c.ssh.target : '')}`,
    `BACKUP_SSH_PORT=${c.ssh.port}`,
    `BACKUP_SSH_KEY=${q(confDir + '/backup_ssh_key')}`,
    `BACKUP_SSH_PRUNE=${c.ssh.prune ? 'yes' : 'no'}`,
    `BACKUP_NAS_DIR=${q(c.nas.enabled ? c.nas.dir : '')}`,
    `BACKUP_NAS_PRUNE=${c.nas.prune ? 'yes' : 'no'}`,
    `BACKUP_RCLONE_REMOTE=${q(cloudRemote(c))}`,
    `BACKUP_RCLONE_CONFIG=${q(confDir + '/rclone.conf')}`,
    `BACKUP_RCLONE_PRUNE=${c.cloud.prune ? 'yes' : 'no'}`,
    '',
  ].join('\n');
}
// [ets-cloud] remote of /etc/ets/rclone.conf (mode 's3' only; secrets decrypted by the agent). null = leave the file alone.
export function renderRcloneConf(c, secrets) {
  if (c.cloud.mode !== 's3' || !c.cloud.enabled) return null;
  for (const k of SECRET_KEYS) if (!validSecret(k, secrets[k])) throw new Error('missing_or_invalid_secret:' + k);
  const lines = ['# written by ets-backup-agent (Settings → «النسخ الاحتياطي»); root only, mode 600', '[ets-cloud]', 'type = s3',
    `provider = ${c.cloud.provider}`, 'env_auth = false', `access_key_id = ${secrets.cloud_access_key_id}`,
    `secret_access_key = ${secrets.cloud_secret_access_key}`];
  if (c.cloud.region) lines.push(`region = ${c.cloud.region}`);
  if (c.cloud.endpoint) lines.push(`endpoint = ${c.cloud.endpoint}`);
  lines.push('no_check_bucket = true', '');
  return lines.join('\n');
}
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// systemd OnCalendar of the backup and verify timers (server local time)
export function timerSchedule(c) {
  const f = c.frequency_hours;
  const backup = f === 1 ? '*-*-* *:07:00' : f === 24 ? `*-*-* ${c.daily_time}:00` : `*-*-* 00/${f}:07:00`;
  return { backup, verify: `${WD[c.verify.weekday]} *-*-* ${c.verify.time}:00` };
}
export const renderTimerDropIn = cal => `# written by ets-backup-agent (Settings → «النسخ الاحتياطي»)\n[Timer]\nOnCalendar=\nOnCalendar=${cal}\n`;

// ---------------------------------------------------------------- import of a 1.11.0 / hand-written backup.conf (once)
export function fromBackupConf(kv, { keepDaysEnv } = {}) {
  const c = structuredClone(DEFAULT_CONFIG);
  const n = (k, lo, hi, d) => (/^[0-9]+$/.test(kv[k] ?? '') && +kv[k] >= lo && +kv[k] <= hi ? +kv[k] : d);
  c.retention.hourly_hours = n('BACKUP_KEEP_HOURLY', ...LIMITS.hourly_hours, 48);
  c.retention.daily_days = Math.max(n('BACKUP_KEEP_DAILY', ...LIMITS.daily_days, 30), /^[0-9]+$/.test(keepDaysEnv ?? '') ? Math.min(+keepDaysEnv, 3650) : 0);
  c.retention.weekly_weeks = n('BACKUP_KEEP_WEEKLY', ...LIMITS.weekly_weeks, 12);
  c.retention.monthly_months = n('BACKUP_KEEP_MONTHLY', ...LIMITS.monthly_months, 12);
  if (FREQUENCIES.includes(+kv.BACKUP_FREQUENCY_HOURS)) c.frequency_hours = +kv.BACKUP_FREQUENCY_HOURS;
  if (RE.time.test(kv.BACKUP_LOGS_TIME || '')) c.logs_time = kv.BACKUP_LOGS_TIME;
  if (kv.BACKUP_VERIFY_ENABLED === 'no') c.verify.enabled = false;
  if (validSshTarget(kv.BACKUP_SSH_TARGET || '')) Object.assign(c.ssh, { enabled: true, target: kv.BACKUP_SSH_TARGET, port: n('BACKUP_SSH_PORT', 1, 65535, 22) });
  if (validNasDir(kv.BACKUP_NAS_DIR || '')) Object.assign(c.nas, { enabled: true, dir: kv.BACKUP_NAS_DIR });
  if (validRemote(kv.BACKUP_RCLONE_REMOTE || '') && !kv.BACKUP_RCLONE_REMOTE.startsWith('ets-cloud:')) {
    Object.assign(c.cloud, { enabled: true, mode: 'rclone', remote: kv.BACKUP_RCLONE_REMOTE });
  }
  for (const [d, k] of [['ssh', 'SSH'], ['nas', 'NAS'], ['cloud', 'RCLONE']]) if (kv[`BACKUP_${k}_PRUNE`] === 'no') c[d].prune = false;
  return validateConfig(c).ok ? c : structuredClone(DEFAULT_CONFIG);
}
// KEY=value text → object (same rules as read_kv: unquoted, "double" or 'single' quoted, no expansion)
export function parseKv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2];
    const dq = /^"([^"]*)"\s*(#.*)?$/.exec(v), sq = /^'([^']*)'\s*(#.*)?$/.exec(v), pl = /^([^\s"']*)(\s+#.*|\s*)$/.exec(v);
    const val = dq ? dq[1] : sq ? sq[1] : pl ? pl[1] : null;
    if (val !== null) out[m[1]] = val;
  }
  return out;
}

// ---------------------------------------------------------------- keys and fingerprints (not secret)
// The backup key / passphrase is the first line of /etc/ets/backup.key (gpg --passphrase-file). Its id is a slow,
// salted hash (scrypt), so the id written next to each backup (<file>.meta) cannot be used to guess a passphrase.
export const keyLine = s => String(s).split('\n')[0].replace(/\r$/, '');
export function keyId(secret) {
  const k = keyLine(secret);
  if (!k) return '';
  return crypto.scryptSync(k, 'ets-backup-key-id:v1', 8, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
}
// APP_SECRET fingerprint (HMAC of a constant): tells whether a backup came from a server with the same APP_SECRET.
export const appSecretFp = secret => (secret ? crypto.createHmac('sha256', String(secret)).update('ets-app-secret-fingerprint:v1').digest('hex').slice(0, 16) : '');

// Passphrase chosen in the UI: at least 16 characters with 3 of 4 character classes, or 24+ characters; or a pasted
// key as made by the installer (48 random bytes in base64). Never a known example value.
export function passphraseProblem(p) {
  if (typeof p !== 'string') return 'invalid';
  if (/[\r\n]/.test(p) || p !== p.trim()) return 'invalid_characters';
  if (p.length > 512) return 'too_long';
  if (/^[A-Za-z0-9+/]{64}$/.test(p)) return null;                         // openssl rand -base64 48
  if (p.length < 16) return 'too_short';
  if (/change.?me|example|placeholder|password|passw0rd|backup.?key|123456|qwerty/i.test(p)) return 'too_common';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(p)).length;
  if (p.length < 24 && classes < 3) return 'too_weak';
  if (new Set(p).size < 8) return 'too_weak';
  return null;
}
// A restore key typed or pasted in the wizard (old backup.key or passphrase): one line, printable.
export const restoreKeyProblem = k => (typeof k !== 'string' || !k.trim() ? 'required' : k.length > 512 || /[\r\n\0]/.test(k.trim()) ? 'invalid' : null);

// ---------------------------------------------------------------- artifacts and the restore selection
export function parseArtifact(name) {
  const m = RE.artifact.exec(String(name));
  if (!m) return null;
  if (m[1]) return { kind: 'dump', ts: m[1] };
  if (m[2]) return { kind: 'config', ts: m[2] };
  return { kind: 'logs', ts: m[3] + '-235959', date: m[3] };
}
export const tsToIso = ts => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`;
export const RESTORE_ITEMS = ['db', 'env', 'tls', 'install_conf', 'db_ca', 'logs'];
export const CONFIG_ITEMS = ['env', 'tls', 'install_conf', 'db_ca'];

// The configuration bundle in force at a dump's time: the newest one not newer than the dump.
export function configFor(dumpName, names) {
  const d = parseArtifact(dumpName);
  if (!d || d.kind !== 'dump') return null;
  let best = null;
  for (const n of names) {
    const a = parseArtifact(n);
    if (a?.kind === 'config' && a.ts <= d.ts && (!best || a.ts > parseArtifact(best).ts)) best = n;
  }
  return best;
}

// Which items a backup point offers. point: { dump, config, logs } (names or null); metas: name → .meta JSON.
// → { items: { db: {available, reason?, from}, … } }
export function availability(point, metas = {}) {
  const out = {};
  const cfgItems = point.config ? (metas[point.config]?.items || CONFIG_ITEMS.filter(i => i !== 'db_ca')) : [];
  out.db = point.dump ? { available: true, from: point.dump } : { available: false, reason: 'no_dump' };
  for (const i of CONFIG_ITEMS) {
    out[i] = !point.config ? { available: false, reason: 'no_config' }
      : !cfgItems.includes(i) ? { available: false, reason: 'not_in_bundle', from: point.config }
        : { available: true, from: point.config };
  }
  out.logs = point.logs ? { available: true, from: point.logs } : { available: false, reason: 'no_logs' };
  return out;
}

// Validation of the chosen items against the availability → null or a reason.
export function selectionProblem(items, avail) {
  if (!Array.isArray(items) || !items.length) return 'nothing_selected';
  if (new Set(items).size !== items.length) return 'duplicate_item';
  for (const i of items) {
    if (!RESTORE_ITEMS.includes(i)) return 'unknown_item:' + i;
    if (!avail[i]?.available) return 'unavailable:' + i;
  }
  return null;
}

// Inline warnings of the selection step. current: { hostname, ips[], app_secret_fp }; metas of the chosen files.
export function restoreWarnings(items, point, metas, current) {
  const w = [];
  const has = i => items.includes(i);
  const src = metas[point.dump] || metas[point.config] || {};
  const otherSecret = src.app_secret_fp && current.app_secret_fp && src.app_secret_fp !== current.app_secret_fp;
  const otherHost = src.hostname && current.hostname && src.hostname !== current.hostname;
  if (has('db') && !has('env') && (otherSecret || (otherHost && !src.app_secret_fp))) w.push({ code: 'db_without_env', item: 'db' });
  if (has('env') && !has('db') && metas[point.config]?.app_secret_fp && metas[point.config].app_secret_fp !== current.app_secret_fp) {
    w.push({ code: 'env_without_db', item: 'env' });
  }
  if (has('tls')) {
    const san = String(metas[point.config]?.tls_san || '');
    const names = san.split(',').map(s => s.replace(/^(DNS|IPAddress|IP Address|IP):/i, '').trim()).filter(Boolean);
    const mine = [current.hostname, ...(current.ips || []), current.address].filter(Boolean);
    if (names.length && !names.some(n => mine.includes(n))) w.push({ code: 'tls_san_mismatch', item: 'tls', san: names.join(', ') });
  }
  if (has('db') && src.app_version && current.app_version && cmpVersion(src.app_version, current.app_version) > 0) {
    w.push({ code: 'newer_version', item: 'db', version: src.app_version, blocking: true });
  }
  return w;
}
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}
// The phrase typed at the confirm step: the server's host name or «استرجاع» / "RESTORE".
export const confirmPhraseOk = (s, hostname) => typeof s === 'string' && [hostname, 'استرجاع', 'RESTORE'].filter(Boolean).includes(s.trim());
