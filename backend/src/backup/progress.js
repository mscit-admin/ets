// Real progress of the long backup jobs (1.12.0): restore, rollback, test restore / inspection, «نسخ احتياطي الآن».
// Pure: phase weights from a size model, a monotonic percentage, an ETA from a smoothed throughput (EWMA), byte / row /
// table counters, and the parser of `pg_restore --verbose` output. The backup agent feeds it and writes the snapshot to
// /var/lib/ets/restore/status.json (restore) or to the job row (other jobs) about once a second; the web UI and the
// maintenance page served by nginx only display it.

// Size model: seconds a phase takes = fixed + units / rate. The rates were measured on the end-to-end test of the
// agent (PostgreSQL 16, a 4-vCPU container, a 165 kB / 1 250-row and a 52 MB / 400 000-row database) and rounded
// down, so the first estimate is rather pessimistic; the ETA then follows the measured throughput.
export const MODEL = {
  fetch:         { fixed: 1, per: 'bytes', rate: 40e6 },    // copy from a destination / the upload area
  checksum:      { fixed: 0.2, per: 'bytes', rate: 400e6 },
  decrypt:       { fixed: 0.5, per: 'bytes', rate: 120e6 },
  safety:        { fixed: 3, per: 'db_bytes', rate: 25e6 },  // pg_dump + gpg of the current database
  stop:          { fixed: 2 },
  restore_data:  { fixed: 1, per: 'data_bytes', rate: 15e6 },
  restore_index: { fixed: 1, per: 'data_bytes', rate: 60e6 },
  config:        { fixed: 1 },
  migrate:       { fixed: 2 },
  verify:        { fixed: 1, per: 'rows', rate: 60e3 },       // verify-audit walks the hash chains
  start:         { fixed: 3 },
  health:        { fixed: 2 },
  logs:          { fixed: 0.5, per: 'logs_bytes', rate: 80e6 },
  createdb:      { fixed: 1 },
  counts:        { fixed: 1 },
  drop:          { fixed: 1 },
  dump:          { fixed: 2, per: 'db_bytes', rate: 25e6 },
  bundle:        { fixed: 1 },
  retention:     { fixed: 0.5 },
  offsite:       { fixed: 3, per: 'db_bytes', rate: 10e6 },
};
export const PLANS = {
  restore: ['fetch', 'checksum', 'decrypt', 'safety', 'stop', 'restore_data', 'restore_index', 'config', 'migrate', 'verify', 'start', 'health', 'logs'],
  rollback: ['stop', 'restore_data', 'restore_index', 'config', 'migrate', 'start', 'health'],
  inspect: ['fetch', 'checksum', 'decrypt', 'createdb', 'restore_data', 'restore_index', 'migrate', 'verify', 'counts', 'drop'],
  verify: ['checksum', 'decrypt', 'createdb', 'restore_data', 'restore_index', 'migrate', 'verify', 'counts', 'drop'],
  backup: ['dump', 'bundle', 'logs', 'retention', 'offsite'],
};

export function estimateSeconds(phase, sizes = {}) {
  const m = MODEL[phase] || { fixed: 1 };
  const units = m.per ? Math.max(0, +sizes[m.per] || 0) : 0;
  return m.fixed + (m.per ? units / m.rate : 0);
}
// phases: [keys]; skip: keys not done this time (e.g. no DB selected → no stop / restore / migrate): weight 0, shown as skipped.
// → [{key, weight, est, skipped}], weights sum to 1
export function planPhases(phases, sizes = {}, skip = []) {
  const list = phases.map(key => ({ key, est: skip.includes(key) ? 0 : estimateSeconds(key, sizes), skipped: skip.includes(key) }));
  const total = list.reduce((a, p) => a + p.est, 0) || 1;
  return list.map(p => ({ ...p, weight: p.est / total }));
}

// EWMA of a rate over time: alpha = 1 − e^(−Δt/τ), τ ≈ 10 s.
export function ewma(prev, sample, dt, tau = 10) {
  if (!(dt > 0) || !Number.isFinite(sample)) return prev;
  if (prev == null) return sample;
  const a = 1 - Math.exp(-dt / tau);
  return prev + a * (sample - prev);
}

export class Tracker {
  constructor({ kind = 'restore', phases, sizes = {}, skip = [], now = Date.now() } = {}) {
    this.kind = kind;
    this.sizes = sizes;
    this.phases = planPhases(phases || PLANS[kind], sizes, skip).map(({ skipped, ...p }) => ({ ...p, state: skipped ? 'skipped' : 'pending', frac: 0 }));
    this.startedAt = now;
    this.pct = 0;
    this.rate = null;          // smoothed % per second
    this.last = { t: now, pct: 0 };
    this.counters = {};        // name → { done, total }
    this.current = null;
    this.state = 'running';
  }
  phase(key) { return this.phases.find(p => p.key === key); }
  // starts a phase (the ones before it that were not finished count as done / skipped)
  begin(key, now = Date.now()) {
    const i = this.phases.findIndex(p => p.key === key);
    if (i < 0) return;
    for (let j = 0; j < i; j++) if (this.phases[j].state === 'pending' || this.phases[j].state === 'running') this.phases[j].state = this.phases[j].state === 'running' ? 'done' : 'skipped';
    this.phases[i].state = 'running'; this.phases[i].frac = 0; this.phases[i].startedAt = now;
    this.current = key;
    this.tick(now);
  }
  // fraction (0..1) of the current phase
  advance(key, frac, now = Date.now()) {
    const p = this.phase(key);
    if (!p || p.state !== 'running') return;
    p.frac = Math.min(1, Math.max(p.frac, Number.isFinite(frac) ? frac : 0));
    this.tick(now);
  }
  done(key, now = Date.now()) {
    const p = this.phase(key);
    if (!p) return;
    p.state = 'done'; p.frac = 1; p.finishedAt = now;
    if (this.current === key) this.current = null;
    this.tick(now);
  }
  skip(key) { const p = this.phase(key); if (p && p.state === 'pending') p.state = 'skipped'; }
  fail(key, now = Date.now()) { const p = this.phase(key || this.current); if (p) p.state = 'failed'; this.state = 'failed'; this.tick(now); }
  count(name, done, total) {
    const c = this.counters[name] || { done: 0, total: 0 };
    if (Number.isFinite(total)) c.total = Math.max(0, total);
    if (Number.isFinite(done)) c.done = Math.min(Math.max(c.done, done), c.total || Infinity);
    this.counters[name] = c;
  }
  // percentage over the phases still in the plan (skipped ones give their weight to the others), never going back
  raw() {
    const live = this.phases.filter(p => p.state !== 'skipped');
    const total = live.reduce((a, p) => a + p.weight, 0) || 1;
    const got = live.reduce((a, p) => a + p.weight * (p.state === 'done' ? 1 : p.state === 'running' || p.state === 'failed' ? p.frac : 0), 0);
    return Math.min(100, (100 * got) / total);
  }
  tick(now = Date.now()) {
    const r = this.raw();
    if (r > this.pct) this.pct = r;
    const dt = (now - this.last.t) / 1000;
    if (dt >= 0.5) {
      this.rate = ewma(this.rate, (this.pct - this.last.pct) / dt, dt);
      this.last = { t: now, pct: this.pct };
    }
  }
  finish(state = 'done', now = Date.now()) {
    if (state === 'done') { for (const p of this.phases) if (p.state === 'running') { p.state = 'done'; p.frac = 1; } this.pct = 100; }
    this.state = state; this.current = null;
    this.endedAt = now;
  }
  // remaining seconds: from the smoothed rate once there is one, else from the size model ("estimated")
  eta(now = Date.now()) {
    if (this.state !== 'running' && this.state !== 'rolling_back') return { seconds: 0, estimated: false };
    const left = 100 - this.pct;
    if (this.rate && this.rate > 0.01 && now - this.startedAt > 3000) return { seconds: Math.round(left / this.rate), estimated: false };
    const est = this.phases.filter(p => p.state === 'pending' || p.state === 'running').reduce((a, p) => a + p.est * (1 - p.frac), 0);
    return { seconds: Math.round(est), estimated: true };
  }
  snapshot(now = Date.now()) {
    const e = this.eta(now);
    return {
      kind: this.kind, state: this.state, percent: Math.round(this.pct * 10) / 10, current: this.current,
      phases: this.phases.map(p => ({ key: p.key, state: p.state, percent: Math.round(p.frac * 1000) / 10 })),
      eta_s: e.seconds, eta_estimated: e.estimated, elapsed_s: Math.round(((this.endedAt || now) - this.startedAt) / 1000),
      counters: this.counters, started_at: new Date(this.startedAt).toISOString(), updated_at: new Date(now).toISOString(),
    };
  }
}

// `pg_restore --verbose` (stderr) → an event, or null.
//   pg_restore: processing data for table "public.users"     → { type: 'data', table: 'users' }
//   pg_restore: creating INDEX "public.users_email_lower_uniq" → { type: 'index', name }
//   pg_restore: creating CONSTRAINT / FK CONSTRAINT / TRIGGER  → { type: 'constraint' | 'fk' | 'trigger', name }
//   pg_restore: creating TABLE "public.users"                → { type: 'schema', what: 'TABLE', name }
//   pg_restore: dropping TABLE users                         → { type: 'drop', name }
export function parseRestoreLine(line) {
  const s = String(line).replace(/^pg_restore:\s*/, '').trim();
  let m = /^processing data for table "(?:([^"]+)\.)?([^"]+)"$/.exec(s);
  if (m) return { type: 'data', table: m[2] };
  m = /^creating (FK CONSTRAINT|CONSTRAINT|INDEX|TRIGGER) "?(?:[^".]+\.)?([^"]+)"?/.exec(s);
  if (m) return { type: { 'FK CONSTRAINT': 'fk', CONSTRAINT: 'constraint', INDEX: 'index', TRIGGER: 'trigger' }[m[1]], name: m[2] };
  m = /^creating ([A-Z ]+?) "?(?:[^".]+\.)?([^"]+)"?$/.exec(s);
  if (m) return { type: 'schema', what: m[1], name: m[2] };
  m = /^dropping ([A-Z ]+?) (.+)$/.exec(s);
  if (m) return { type: 'drop', what: m[1], name: m[2] };
  return null;
}

// Restore progress from the table list of the inspection ({table, rows, bytes}) and what has been seen so far:
// completed tables count fully, the table being copied counts by pg_stat_progress_copy (tuples or bytes).
export function restoreFraction(tables, doneSet, current) {
  const total = tables.reduce((a, t) => a + Math.max(1, +t.bytes || 0), 0) || 1;
  let got = 0, rows = 0;
  for (const t of tables) {
    if (doneSet.has(t.table)) { got += Math.max(1, +t.bytes || 0); rows += +t.rows || 0; }
  }
  if (current?.table && !doneSet.has(current.table)) {
    const t = tables.find(x => x.table === current.table);
    if (t) {
      const f = t.rows > 0 && current.tuples != null ? Math.min(1, current.tuples / t.rows)
        : current.bytes_total > 0 ? Math.min(1, current.bytes / current.bytes_total) : 0;
      got += Math.max(1, +t.bytes || 0) * f;
      rows += Math.min(+t.rows || 0, current.tuples || 0);
    }
  }
  return { frac: Math.min(1, got / total), rows, rowsTotal: tables.reduce((a, t) => a + (+t.rows || 0), 0), tables: doneSet.size, tablesTotal: tables.length };
}
