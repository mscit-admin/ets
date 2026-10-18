// Live updates: the screens refresh when tracker data changes, without reloading the page.
//
//   change committed ──► publishChange()  ──► SELECT pg_notify('ets_live', …)   (after COMMIT, own statement)
//                                                   │
//   every API process: one dedicated LISTEN connection (reconnects) ◄──┘
//                                                   │
//   open streams of that process (GET /api/events) ◄┘  "event: tracker_changed"
//
// The event says only that something changed, and where (department / application ids, as hints) — never a
// value. Each browser then reloads its screen through the usual endpoints, so every scope rule still applies.
// A stream only receives hints about applications / departments in its user's scope.
//
// PostgreSQL LISTEN/NOTIFY carries the event between processes, so it works with one API process (the default
// systemd unit) and with several. The per-user stream cap is counted per process.
//
// Sessions: every heartbeat re-checks each stream's session (revoked, expired, idle, user disabled, password
// change required) without touching its last activity; a sign-out / revocation also asks every process to
// re-check that user's streams at once ('session_check').
import pg from 'pg';
import { config, dbPoolConfig } from '../config.js';
import { query } from '../db/pool.js';
import { loadUserContext } from '../middleware/auth.js';
import { logger } from './logs.js';

export const CHANNEL = 'ets_live';
const ID = /^[a-z0-9_-]{1,40}$/i;

// ---- publishing (call AFTER the transaction has committed) ----
function notify(msg) {
  return query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(msg)]).catch(e => {
    logger.warn({ err: e.message }, 'live: pg_notify failed, delivering in this process only');
    dispatch(msg);
  });
}

/** Tracker data changed. hint: { dept_id?, app_id? } — ids only, never values. Without a hint every stream is told. */
export function publishChange(hint = {}) {
  const msg = { t: 'tracker_changed' };
  if (ID.test(hint.dept_id ?? '')) msg.dept_id = hint.dept_id;
  if (ID.test(hint.app_id ?? '')) msg.app_id = hint.app_id;
  return notify(msg);
}
/** One event per distinct department of these applications ({id, department_id} rows). */
export function publishApps(apps) {
  const depts = new Map();
  for (const a of apps) if (a) depts.set(a.department_id, (depts.get(a.department_id) || new Set()).add(a.id));
  return Promise.all([...depts].map(([d, ids]) => publishChange(ids.size === 1 ? { dept_id: d, app_id: [...ids][0] } : { dept_id: d })));
}
/** Re-check the open streams of this user now (sign-out, sessions revoked, account / scope changed). */
export function publishSessionCheck(userId) {
  if (!Number.isInteger(userId)) return Promise.resolve();
  return notify({ t: 'session_check', uid: userId });
}

// ---- streams of this process ----
const streams = new Map();          // id → { res, sessionId, user, opened }
let seq = 0;
const appDept = new Map();          // application id → department id (scope check of hints)

export const streamCount = userId => [...streams.values()].filter(s => s.user.id === userId).length;

function send(s, event, data) {
  try { s.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* closed */ }
}

// May this stream's user hear about a change in this department / application?
function inScope(user, msg) {
  if (user.fullScope || (!msg.dept_id && !msg.app_id)) return true;
  const dept = msg.dept_id || appDept.get(msg.app_id);
  if (msg.app_id) return user.scope.applications.includes(msg.app_id) || user.scope.departments.includes(dept);
  return user.scope.departments.includes(dept) || user.scope.applications.some(a => appDept.get(a) === dept);
}

function dispatch(msg) {
  if (msg?.t === 'tracker_changed') {
    for (const s of streams.values()) {
      if (!inScope(s.user, msg)) continue;
      const out = { type: 'tracker_changed' };
      if (msg.dept_id) out.dept_id = msg.dept_id;
      if (msg.app_id) out.app_id = msg.app_id;
      send(s, 'tracker_changed', out);
    }
  } else if (msg?.t === 'session_check' && Number.isInteger(msg.uid)) {
    const mine = [...streams.values()].filter(s => s.user.id === msg.uid);
    if (mine.length) checkStreams(mine, { tellChanged: true }).catch(e => logger.warn({ err: e.message }, 'live: session check failed'));
  }
}

function close(s, reason) {
  if (!streams.has(s.id)) return;
  streams.delete(s.id);
  if (reason) send(s, 'session_ended', { type: 'session_ended' });
  try { s.res.end(); } catch { /* already closed */ }
  maybeStop();
}

// Is each stream's session still valid? Does not update last_seen_at: an open screen is not user activity.
async function checkStreams(list, { tellChanged = false } = {}) {
  if (!list.length) return;
  const ids = [...new Set(list.map(s => s.sessionId))];
  const rows = (await query(`SELECT id, user_id, mfa_passed, revoked_at, expires_at,
      (last_seen_at < now() - ($2 || ' minutes')::interval) AS idle FROM sessions WHERE id = ANY($1)`,
  [ids, String(config.session.idleMinutes)])).rows;
  const ok = new Map(rows.filter(r => !r.revoked_at && !r.idle && r.mfa_passed && new Date(r.expires_at) > new Date()).map(r => [r.id, r]));
  const users = new Map();
  for (const s of list) {
    if (!streams.has(s.id)) continue;
    const row = ok.get(s.sessionId);
    if (!row || row.user_id !== s.user.id) { close(s, 'session'); continue; }
    if (!users.has(s.user.id)) users.set(s.user.id, await loadUserContext(s.user.id));
    const u = users.get(s.user.id);
    if (!u || !u.is_active || u.must_change_password) { close(s, 'session'); continue; }
    const changed = JSON.stringify([u.fullScope, u.scope, u.permissions]) !== JSON.stringify([s.user.fullScope, s.user.scope, s.user.permissions]);
    s.user = u;                                     // scope / permission changes apply to later hints
    if (changed && tellChanged) send(s, 'tracker_changed', { type: 'tracker_changed' });
  }
}

async function loadAppDepts() {
  const r = await query('SELECT id, department_id FROM applications');
  appDept.clear();
  for (const a of r.rows) appDept.set(a.id, a.department_id);
}

let beat = null;
async function heartbeat() {
  const list = [...streams.values()];
  try {
    await loadAppDepts();
    await checkStreams(list);
  } catch (e) {
    logger.warn({ err: e.message }, 'live: heartbeat check failed');
  }
  for (const s of list) if (streams.has(s.id)) { try { s.res.write(': hb\n\n'); } catch { /* closed */ } }
}

// ---- the LISTEN connection (one per process, opened with the first stream, reconnects with backoff) ----
let client = null, ready = null, retry = 0, retryTimer = null, wanted = false;

function connect() {
  ready = (async () => {
    const c = new pg.Client(dbPoolConfig());
    c.on('notification', n => {
      if (n.channel !== CHANNEL) return;
      let msg; try { msg = JSON.parse(n.payload); } catch { return; }
      dispatch(msg);
    });
    const lost = e => {
      if (client !== c) return;
      client = null; ready = null;
      c.removeAllListeners('notification');
      c.end().catch(() => {});
      if (!wanted) return;
      logger.warn({ err: e?.message }, 'live: listener connection lost, reconnecting');
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      retryTimer = setTimeout(() => { retryTimer = null; if (wanted) connect().then(() => {
        // events may have been missed while disconnected: every stream reloads once
        for (const s of streams.values()) send(s, 'tracker_changed', { type: 'tracker_changed' });
      }, () => {}); }, wait);
      retryTimer.unref();
    };
    c.on('error', lost);
    c.on('end', () => lost(new Error('connection ended')));
    client = c;
    try {
      await c.connect();
      await c.query(`LISTEN ${CHANNEL}`);
      await loadAppDepts();
    } catch (e) { lost(e); throw e; }
    retry = 0;
  })();
  return ready;
}

/** Resolves when this process listens for events (first call opens the connection). */
export function listening() {
  wanted = true;
  if (!beat) { beat = setInterval(heartbeat, config.live.heartbeatMs); beat.unref(); }
  return ready || connect();
}

function maybeStop() {
  if (streams.size || !wanted) return;
  stopListening();
}

/** Closes the LISTEN connection and the heartbeat (no streams left, or shutdown). */
export function stopListening() {
  wanted = false;
  if (beat) { clearInterval(beat); beat = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  const c = client;
  client = null; ready = null;
  if (c) { c.removeAllListeners(); c.on('error', () => {}); return c.end().catch(() => {}); }
  return Promise.resolve();
}

/** Registers an open stream; returns its close function. */
export function addStream(res, { sessionId, user }) {
  const s = { id: ++seq, res, sessionId, user, opened: Date.now() };
  streams.set(s.id, s);
  return () => close(s);
}

/** Ends every stream of this process (graceful shutdown). */
export function closeAllStreams() {
  for (const s of [...streams.values()]) close(s);
  return stopListening();
}
