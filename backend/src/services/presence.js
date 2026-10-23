// Online users (1.11.0, migration 020): which signed-in sessions are working on the system now, on which screen,
// since when. Administrators only read it (routes/presence.js).
//
//   web app ── POST /api/presence {path, screen, ref} ──► report()  (every screen change; every 60 s while visible)
//                (X-ETS-Live: 1 — and the route itself never counts as activity for the idle timeout)
//   report(): validated → at most one write per session per PRESENCE_MIN_INTERVAL_SECONDS (10 s); a report in
//             between is kept and written when the interval ends (coalesced) → write(): upsert of user_presence
//             (screen_since moves only when screen or ref changes) + seconds of activity today (user_activity_daily)
//   listPresence(): rows of valid sessions seen in the last 15 minutes; 'online' ≤ 2 minutes, 'idle' 2–15 minutes;
//             the screen label is built here from the screen key and the id (names looked up; an id that no longer
//             exists → screen 'unknown'), never from text the browser sent.
//   cleanupPresence(): every 5 minutes, one API process at a time (advisory lock): rows older than 15 minutes or of
//             an ended session, daily activity older than 7 days.
// A revoked session's row is removed by a trigger at once (migration 020); a deleted session takes it with it.
import { query, pool } from '../db/pool.js';
import { config } from '../config.js';
import { getSetting } from './settings.js';
import { logger } from './logs.js';
import { bad, own } from '../utils/http.js';

export const ONLINE_SECONDS = 120;          // last report at most 2 minutes ago → online
export const IDLE_SECONDS = 15 * 60;        // 2–15 minutes → idle; older → not listed (and cleaned up)
const ACTIVE_GAP_SECONDS = 90;              // two reports at most this far apart: the time between them was active
const DAILY_KEEP_DAYS = 7;
export const LOCK_KEY = 'ets_presence_cleanup';

// Screen keys the web app may report, and the kind of id each one carries (null: none). Anything else → 'unknown'.
export const SCREENS = {
  dashboard: null, status: null, weights: null, schedule: null, reports: null, search: null,
  department: 'department', reports_dept: 'department', application: 'application',
  imports: null, import: 'import', approvals: null, notifications: null, profile: null,
  users: null, user: 'user', online_users: null, logs: null, settings: null, unknown: null,
};
// Where the administrator's link goes (built here; the path the browser sent is stored, never used as a link).
const LINKS = {
  dashboard: () => '/', status: () => '/status', weights: () => '/weights', schedule: () => '/schedule',
  reports: () => '/reports', search: () => '/search', department: r => '/department/' + r, reports_dept: r => '/reports/' + r,
  application: r => '/app/' + r, imports: () => '/imports', import: r => '/imports/' + r, approvals: () => '/approvals',
  users: () => '/users', user: r => '/users/' + r, online_users: () => '/online', logs: () => '/logs', settings: () => '/settings',
};

const PATH_RE = /^\/[A-Za-z0-9/_.~%-]{0,199}$/;
const SCREEN_RE = /^[a-z_]{1,30}$/;
const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;
const NUM_RE = /^[0-9]{1,9}$/;

/** Checks a report's body → { path, screen, ref } (unknown screen keys become 'unknown'). Throws 400. */
export function parseReport(body) {
  const b = body && typeof body === 'object' ? body : {};
  const path = typeof b.path === 'string' ? b.path : '';
  if (!PATH_RE.test(path) || path.includes('//')) throw bad('invalid_value', { field: 'path' });
  if (typeof b.screen !== 'string' || !SCREEN_RE.test(b.screen)) throw bad('invalid_value', { field: 'screen' });
  let ref = b.ref ?? null;
  if (typeof ref === 'number' && Number.isInteger(ref)) ref = String(ref);
  if (ref !== null && (typeof ref !== 'string' || !REF_RE.test(ref))) throw bad('invalid_value', { field: 'ref' });
  const screen = Object.hasOwn(SCREENS, b.screen) ? b.screen : 'unknown';
  const kind = SCREENS[screen];
  return { path, screen, ref: kind ? ref : null };
}

// The id must name an existing record of the screen's kind; otherwise the screen is stored as 'unknown'.
async function checkRef(screen, ref) {
  const kind = SCREENS[screen];
  if (!kind) return { screen, ref: null };
  if (!ref) return { screen: 'unknown', ref: null };
  let ok = false;
  if (kind === 'department') ok = (await query('SELECT 1 FROM departments WHERE id=$1', [ref])).rowCount > 0;
  else if (kind === 'application') ok = (await query('SELECT 1 FROM applications WHERE id=$1', [ref])).rowCount > 0;
  else if (kind === 'import') ok = NUM_RE.test(ref) && (await query('SELECT 1 FROM import_batches WHERE id=$1', [+ref])).rowCount > 0;
  else if (kind === 'user') ok = NUM_RE.test(ref) && (await query('SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL', [+ref])).rowCount > 0;
  return ok ? { screen, ref } : { screen: 'unknown', ref: null };
}

const timeZone = async () => (await getSetting('notify.timezone')) || 'Africa/Tripoli';

// Upsert of the session's row (only while the session is valid) and the user's active seconds today.
async function write(r) {
  const { screen, ref } = await checkRef(r.screen, r.ref);
  const q = await query(`INSERT INTO user_presence(session_id,user_id,client,current_path,current_screen,screen_ref,user_agent,ip,screen_since)
    SELECT s.id, s.user_id, $3, $4, $5, $6, $7, $8, $9::timestamptz FROM sessions s
     WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at > now() AND s.mfa_passed
    ON CONFLICT (session_id) DO UPDATE SET
      screen_since = CASE WHEN user_presence.current_screen IS DISTINCT FROM EXCLUDED.current_screen
                            OR user_presence.screen_ref IS DISTINCT FROM EXCLUDED.screen_ref
                          THEN $9::timestamptz ELSE user_presence.screen_since END,
      current_path=EXCLUDED.current_path, current_screen=EXCLUDED.current_screen, screen_ref=EXCLUDED.screen_ref,
      client=EXCLUDED.client, user_agent=EXCLUDED.user_agent, ip=EXCLUDED.ip, last_seen=now()
    RETURNING session_id`, [r.sessionId, r.userId, r.client, r.path, screen, ref, r.userAgent, r.ip, r.at]);
  if (!q.rowCount) return false;
  // the time since the user's previous report (any session) when at most ACTIVE_GAP_SECONDS: tabs never count twice
  await query(`INSERT INTO user_activity_daily(user_id, day) VALUES ($1, (now() AT TIME ZONE $2)::date)
    ON CONFLICT (user_id, day) DO UPDATE SET
      seconds = user_activity_daily.seconds + CASE WHEN now() - user_activity_daily.last_at <= make_interval(secs => $3)
        THEN GREATEST(0, round(extract(epoch FROM now() - user_activity_daily.last_at)))::int ELSE 0 END,
      last_at = now()`, [r.userId, await timeZone(), ACTIVE_GAP_SECONDS]);
  return true;
}

// Per session: { last: time of the last write, pending: report waiting for the interval to end, timer }.
const state = new Map();

/** Stores a report of this request's own session. → { stored: true } or { stored: false, coalesced: true }. */
export async function report(req) {
  const p = parseReport(req.body);
  const r = {
    ...p, sessionId: req.session.id, userId: req.user.id, ip: req.ip || null,
    client: req.get('x-ets-client') === 'mobile' ? 'mobile' : 'web',
    userAgent: (req.get('user-agent') || '').slice(0, 160) || null,
    at: new Date(),             // when the screen was reported (a coalesced write is up to 10 s later)
  };
  const every = config.presence.minIntervalMs;
  const now = Date.now();
  let s = state.get(r.sessionId);
  if (!s) { s = { last: 0, pending: null, timer: null }; state.set(r.sessionId, s); }
  if (now - s.last >= every && !s.timer) {
    s.last = now;
    await write(r);
    return { stored: true };
  }
  // a report of the screen already waiting keeps the earlier time: screen_since is when the screen was opened
  s.pending = s.pending && s.pending.screen === r.screen && s.pending.ref === r.ref ? { ...r, at: s.pending.at } : r;
  if (!s.timer) {
    s.timer = setTimeout(() => {
      s.timer = null;
      const next = s.pending;
      s.pending = null;
      if (!next) return;
      s.last = Date.now();
      write(next).catch(e => logger.warn({ err: e.message }, 'presence: coalesced write failed'));
    }, Math.max(0, s.last + every - now));
    s.timer.unref?.();
  }
  return { stored: false, coalesced: true };
}

/** Pending coalesced writes are dropped (tests, shutdown). */
export function resetPresenceState() {
  for (const s of state.values()) if (s.timer) clearTimeout(s.timer);
  state.clear();
}

// "Chrome 141 · Windows", "ETS app · Android" … from the stored user agent (shortened to 160 characters).
export function deviceSummary(ua, client) {
  const s = String(ua || '');
  if (!s) return client === 'mobile' ? 'ETS app' : '';
  const os = /Android/i.test(s) ? 'Android' : /iPhone|iPad|iOS/i.test(s) ? 'iOS' : /Windows/i.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(s) ? 'macOS' : /CrOS/i.test(s) ? 'ChromeOS' : /Linux/i.test(s) ? 'Linux' : '';
  const m = (re, name) => { const x = re.exec(s); return x ? `${name} ${x[1]}` : null; };
  const browser = (client === 'mobile' && /okhttp|Expo|ReactNative|ETS/i.test(s) ? 'ETS app' : null)
    || m(/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge') || m(/OPR\/(\d+)/, 'Opera') || m(/Firefox\/(\d+)/, 'Firefox')
    || m(/Chrom(?:e|ium)\/(\d+)/, 'Chrome') || (/Safari\//.test(s) ? m(/Version\/(\d+)/, 'Safari') || 'Safari' : null)
    || (client === 'mobile' ? 'ETS app' : '');
  return [browser, os].filter(Boolean).join(' · ');
}

// Valid session (same rule as the session check: not revoked, not expired, not idle, 2FA passed) of an active account.
const VALID = `s.revoked_at IS NULL AND s.expires_at > now() AND s.mfa_passed
  AND s.last_seen_at > now() - make_interval(mins => $1) AND u.is_active AND u.deleted_at IS NULL`;

/** The administrator's list: { rows, counts, server_now }. me: the reader's session id (their own row is marked). */
export async function listPresence({ sessionId = null } = {}) {
  const idle = config.session.idleMinutes;
  const tz = await timeZone();
  const rows = (await query(`SELECT left(p.session_id, 16) AS session_ref, COALESCE(p.session_id = $3, false) AS is_me,
      p.user_id, u.username, u.full_name, u.role_id, r.name_ar AS role_name_ar, r.name_en AS role_name_en, r.full_scope,
      COALESCE((SELECT array_agg(DISTINCT x) FROM (
        SELECT us.ref_id AS x FROM user_scopes us WHERE us.user_id=u.id AND us.kind='department'
        UNION SELECT ap.department_id FROM user_scopes us JOIN applications ap ON ap.id=us.ref_id
          WHERE us.user_id=u.id AND us.kind='application') z), '{}') AS scope_departments,
      p.client, p.current_screen, p.screen_ref, p.screen_since, p.first_seen, p.last_seen, p.user_agent, host(p.ip) AS ip,
      s.created_at AS session_created_at, COALESCE(s.login_at, s.created_at) AS login_at,
      CASE WHEN p.last_seen > now() - make_interval(secs => $4) THEN 'online' ELSE 'idle' END AS status,
      d.name_ar AS d_name_ar, d.name_en AS d_name_en,
      a.name_ar AS a_name_ar, a.name_en AS a_name_en, a.department_id AS a_dept, ad.name_ar AS ad_name_ar, ad.name_en AS ad_name_en,
      ib.id AS import_id, idp.name_ar AS ib_dept_ar, idp.name_en AS ib_dept_en,
      tu.full_name AS tu_name,
      COALESCE(act.seconds, 0) AS active_today_s
    FROM user_presence p
    JOIN sessions s ON s.id = p.session_id
    JOIN users u ON u.id = p.user_id
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN departments d ON p.current_screen IN ('department', 'reports_dept') AND d.id = p.screen_ref
    LEFT JOIN applications a ON p.current_screen = 'application' AND a.id = p.screen_ref
    LEFT JOIN departments ad ON ad.id = a.department_id
    LEFT JOIN import_batches ib ON p.current_screen = 'import' AND ib.id = CASE WHEN p.screen_ref ~ '^[0-9]{1,9}$' THEN p.screen_ref::int END
    LEFT JOIN departments idp ON idp.id = ib.department_id
    LEFT JOIN users tu ON p.current_screen = 'user' AND tu.deleted_at IS NULL AND tu.id = CASE WHEN p.screen_ref ~ '^[0-9]{1,9}$' THEN p.screen_ref::int END
    LEFT JOIN user_activity_daily act ON act.user_id = p.user_id AND act.day = (now() AT TIME ZONE $2)::date
    WHERE ${VALID} AND p.last_seen > now() - make_interval(secs => $5)
    ORDER BY (p.last_seen > now() - make_interval(secs => $4)) DESC, u.full_name, p.last_seen DESC`,
  [idle, tz, sessionId, ONLINE_SECONDS, IDLE_SECONDS])).rows;
  const sessions = (await query(`SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id=s.user_id WHERE ${VALID}`, [idle])).rows[0].n;
  const out = rows.map(x => ({
    session_ref: x.session_ref, is_me: x.is_me,
    user: { id: x.user_id, username: x.username, full_name: x.full_name, role: x.role_id, role_name_ar: x.role_name_ar, role_name_en: x.role_name_en },
    scope: { full: x.full_scope, departments: x.full_scope ? [] : x.scope_departments },
    status: x.status, client: x.client, device: deviceSummary(x.user_agent, x.client), ip: x.ip,
    screen: screenOf(x), screen_since: x.screen_since, last_seen: x.last_seen, first_seen: x.first_seen,
    login_at: x.login_at, session_created_at: x.session_created_at, active_today_s: x.active_today_s,
  }));
  const counts = { online: out.filter(x => x.status === 'online').length, idle: out.filter(x => x.status === 'idle').length,
    users: new Set(out.map(x => x.user.id)).size, sessions };
  return { rows: out, counts, server_now: new Date().toISOString(), online_seconds: ONLINE_SECONDS, idle_seconds: IDLE_SECONDS };
}

// { key, ref, name_ar, name_en, dept_id, dept_ar, dept_en, link } — key 'unknown' when the id names nothing (any more).
function screenOf(x) {
  const key = own(SCREENS, x.current_screen) !== undefined ? x.current_screen : 'unknown';
  const ref = x.screen_ref;
  const out = { key, ref: null, name_ar: null, name_en: null, dept_id: null, dept_ar: null, dept_en: null, link: null };
  const unknown = { ...out, key: 'unknown' };
  if (key === 'department' || key === 'reports_dept') {
    if (!x.d_name_ar && !x.d_name_en) return unknown;
    Object.assign(out, { ref, name_ar: x.d_name_ar, name_en: x.d_name_en, dept_id: ref });
  } else if (key === 'application') {
    if (!x.a_name_ar && !x.a_name_en) return unknown;
    Object.assign(out, { ref, name_ar: x.a_name_ar, name_en: x.a_name_en, dept_id: x.a_dept, dept_ar: x.ad_name_ar, dept_en: x.ad_name_en });
  } else if (key === 'import') {
    if (!x.import_id) return unknown;
    Object.assign(out, { ref, name_ar: '#' + x.import_id, name_en: '#' + x.import_id, dept_ar: x.ib_dept_ar, dept_en: x.ib_dept_en });
  } else if (key === 'user') {
    if (!x.tu_name) return unknown;
    Object.assign(out, { ref, name_ar: x.tu_name, name_en: x.tu_name });
  }
  out.link = LINKS[key] ? LINKS[key](encodeURIComponent(out.ref ?? '')) : null;
  return out;
}

/** Online / idle counts only (the Users page indicator; no names, no audit row). */
export async function presenceCounts() {
  const r = (await query(`SELECT
      count(*) FILTER (WHERE p.last_seen > now() - make_interval(secs => $2))::int AS online,
      count(*) FILTER (WHERE p.last_seen <= now() - make_interval(secs => $2))::int AS idle
    FROM user_presence p JOIN sessions s ON s.id=p.session_id JOIN users u ON u.id=p.user_id
    WHERE ${VALID} AND p.last_seen > now() - make_interval(secs => $3)`, [config.session.idleMinutes, ONLINE_SECONDS, IDLE_SECONDS])).rows[0];
  return r;
}

/** Distinct users online right now (valid session, last report within the online window). Counts only — no names,
 *  no rows — for the dashboard users-overview donut (routes/dashboard.js). */
export async function onlineUserCount() {
  return (await query(`SELECT count(DISTINCT p.user_id)::int AS n
    FROM user_presence p JOIN sessions s ON s.id=p.session_id JOIN users u ON u.id=p.user_id
    WHERE ${VALID} AND p.last_seen > now() - make_interval(secs => $2)`,
  [config.session.idleMinutes, ONLINE_SECONDS])).rows[0].n;
}

/** Periodic clean-up; one API process at a time. → { presence, daily } rows deleted, or { skipped: 'locked' }. */
export async function cleanupPresence() {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    const presence = (await c.query(`DELETE FROM user_presence p WHERE p.last_seen <= now() - make_interval(secs => $2)
      OR NOT EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=p.session_id AND ${VALID})`,
    [config.session.idleMinutes, IDLE_SECONDS])).rowCount;
    const daily = (await c.query(`DELETE FROM user_activity_daily WHERE day < (now() AT TIME ZONE $1)::date - $2::int`,
      [await timeZone(), DAILY_KEEP_DAYS])).rowCount;
    // this process's write throttle: sessions not heard of for an hour are forgotten
    const old = Date.now() - 3600_000;
    for (const [k, s] of state) if (!s.timer && s.last < old) state.delete(k);
    return { presence, daily };
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    c.release();
  }
}

let timer = null;
/** Every 5 minutes (server.js). */
export function startPresenceCleanup(everyMs = 5 * 60_000) {
  if (timer) return;
  const run = () => cleanupPresence().catch(e => logger.warn({ err: e.message }, 'presence clean-up failed'));
  timer = setInterval(run, everyMs);
  timer.unref();
}
