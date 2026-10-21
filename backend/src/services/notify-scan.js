// Periodic alerts (⏱ in the proposal), run by the API every 15 minutes (server.js). One process at a time: the run
// takes a PostgreSQL advisory lock and gives up when another API process holds it (the unique open-summary index
// is the second line of defence). Each job remembers its last run in notify_state ('job:<name>').
//
//   security  every run      S2 failed sign-ins (15 min, per address and all together), S5 refused requests and
//                            S8 server errors (last hour)
//   daily     every day from notify.digest_hour (local time, notify.timezone):
//                            S3 audit-log hash chains, S4 unique e-mail index, S6 backup age, phones unused for
//                            notify.device_idle_days revoked, old alerts and pairing codes deleted
//   digest    work days (notify.work_days) from notify.digest_hour:
//                            T1 stuck, T2 untested, T3 failed not re-tested, T4 «نجح» below 100 %, T5 not started,
//                            A2 requests waiting (reminder / escalation), A6 files waiting, P1 department status,
//                            P3 project status, P4 close date approaching
//   weekly    with the first digest run of a week: T6 quality, P2 stalled departments
//
// Summaries are one row per user and application (scoped users) or department (full-scope users), with the count of
// that user's visible items; a summary whose condition is gone is closed (services/notify.js resolveExcept).
import { pool, query, tx } from '../db/pool.js';
import { hasPerm, canSeeApp, coversDept } from '../middleware/auth.js';
import { allSettings } from './settings.js';
import { logSystem, logger } from './logs.js';
import { verifyAll } from './logchain.js';
import { passConflict } from './passRule.js';
import { scheduleModel, projectHealth } from './health.js';
import { activeUsers, appMap, deliver, resolveExcept, restrictions, wanted } from './notify.js';
import { effectivePolicy, TYPES } from './notify-catalog.js';
import { revokeDevices } from './devices.js';
import { projectStatusData } from '../routes/tracker.js';
import { importAbilities, loadImportMeta, batchApps } from '../routes/imports.js';

export const LOCK_KEY = 'ets_notify_scan';
const DAY = 864e5;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Local date, hour and weekday (0 = Sunday) in the given time zone.
export function localParts(now, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    hourCycle: 'h23', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, weekday: WD.indexOf(p.weekday) };
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

const getState = async k => (await query('SELECT value FROM notify_state WHERE key=$1', [k])).rows[0]?.value ?? null;
const setState = (k, v) => query(`INSERT INTO notify_state(key, value) VALUES ($1,$2)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, JSON.stringify(v)]);

// Which jobs are due now (state: { job: {day} }).
export function dueJobs(lp, s, state) {
  const out = ['security'];
  const atHour = lp.hour >= s['notify.digest_hour'];
  if (atHour && state.daily?.day !== lp.date) out.push('daily');
  const work = (s['notify.work_days'] || []).includes(lp.weekday);
  if (atHour && work && state.digest?.day !== lp.date) {
    out.push('digest');
    if (!state.weekly?.day || daysBetween(state.weekly.day, lp.date) >= 6) out.push('weekly');
  }
  return out;
}

// One run. force: job names to run whatever their schedule (tests, `npm run notify-scan -- --all`).
export async function runScan({ now = new Date(), force = [] } = {}) {
  const c = await pool.connect();
  let locked = false;
  try {
    locked = (await c.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [LOCK_KEY])).rows[0].ok;
    if (!locked) return { skipped: 'locked' };
    const s = await allSettings();
    if (!s['notify.enabled']) return { skipped: 'disabled' };
    const t0 = Date.now();
    const lp = localParts(now, s['notify.timezone'] || 'Africa/Tripoli');
    const state = {};
    for (const j of ['daily', 'digest', 'weekly']) state[j] = await getState('job:' + j);
    const jobs = [...new Set([...dueJobs(lp, s, state), ...force])];
    const ctx = { now, lp, s, pol: effectivePolicy(s['notify.policy']), apps: await appMap(), users: await activeUsers() };
    ctx.rs = await restrictions(ctx.users.map(u => u.id));
    const done = {};
    for (const j of jobs) {
      try {
        done[j] = await JOBS[j](ctx);
        if (j !== 'security') await setState('job:' + j, { day: lp.date, at: now.toISOString() });
      } catch (e) {
        done[j] = { error: e.message };
        logger.warn({ err: e.message, job: j }, 'notify: scan job failed');
      }
    }
    const ms = Date.now() - t0;
    if (jobs.some(j => j !== 'security') || Object.values(done.security || {}).some(v => v > 0)) {
      await logSystem('notify_scan', 'notification check', { jobs: done, ms, local: lp });
    }
    return { jobs: done, ms };
  } finally {
    if (locked) await c.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]).catch(() => {});
    c.release();
  }
}

// Users the type may reach (permission, admin role, policy, restrictions) — eligibility per row is checked in deliver.
const reach = (ctx, type) => ctx.users.filter(u => {
  const t = TYPES[type];
  if (t.admin ? u.role !== 'admin' : t.perms?.length && !t.perms.some(p => hasPerm(u, p))) return false;
  return wanted(u, type, ctx.pol, ctx.rs.get(u.id));
});

// Delivers the entries and closes every other open summary of the type. → number of entries.
async function publish(type, entries) {
  await deliver(type, entries);
  await resolveExcept(type, entries.map(e => ({ userId: e.user.id, key: e.dedupeKey })));
  return entries.length;
}

// ---------------------------------------------------------------- tracking summaries (T1–T6)
const appP = a => ({ app_id: a.id, app_ar: a.name_ar, app_en: a.name_en });
async function deptNames() {
  return new Map((await query('SELECT id, name_ar, name_en FROM departments')).rows.map(d => [d.id, d]));
}

// groups: Map app id → { n, fn, rep, crit }. byDept: one row per department for every user (T5).
async function summaries(ctx, type, groups, { days, link, byDept = false }) {
  const depts = await deptNames();
  const entries = [];
  const add = (user, key, part, extra) => entries.push({ user, dedupeKey: key, count: part.n, severity: part.crit ? 'critical' : undefined,
    params: { fn: part.fn, rep: part.rep, days, ...extra.params }, appId: extra.appId || null, deptId: extra.deptId || null, link: extra.link });
  for (const user of reach(ctx, type)) {
    const perDept = new Map();
    for (const [appId, g] of groups) {
      const a = ctx.apps.get(appId);
      if (!a || !canSeeApp(user, a)) continue;
      if (user.fullScope || byDept) {
        if (byDept && !coversDept(user, a.department_id)) continue;
        const d = perDept.get(a.department_id) || { n: 0, fn: 0, rep: 0, crit: false };
        d.n += g.n; d.fn += g.fn; d.rep += g.rep; d.crit ||= g.crit;
        perDept.set(a.department_id, d);
      } else {
        add(user, `${type}:app=${appId}`, g, { appId, deptId: a.department_id, params: appP(a), link: `/app/${appId}${link ? '?filter=' + link : ''}` });
      }
    }
    for (const [deptId, d] of perDept) {
      const dn = depts.get(deptId);
      add(user, `${type}:dept=${deptId}`, d, { deptId, params: { dept_id: deptId, dept_ar: dn?.name_ar, dept_en: dn?.name_en }, link: `/department/${deptId}` });
    }
  }
  return publish(type, entries);
}

function group(rows, pred, crit = () => false) {
  const m = new Map();
  for (const f of rows) {
    if (!pred(f)) continue;
    const g = m.get(f.app_id) || { n: 0, fn: 0, rep: 0, crit: false };
    g.n++; f.item_type === 'report' ? g.rep++ : g.fn++; g.crit ||= crit(f);
    m.set(f.app_id, g);
  }
  return m;
}
const older = (ts, now, days) => !!ts && now - new Date(ts) > days * DAY;

async function trackingDigest(ctx) {
  const { now, s } = ctx;
  const fns = (await query(`SELECT id, app_id, item_type, progress, test_status, created_at, progress_changed_at, test_changed_at
    FROM functions WHERE enabled AND removed_at IS NULL`)).rows.map(f => ({ ...f, progress: +f.progress }));
  const N = { stuck: s['notify.stuck_days'], untested: s['notify.untested_days'], failed: s['notify.failed_retest_days'], ns: s['notify.not_started_days'] };
  const out = {};
  out.stuck = await summaries(ctx, 'stuck', group(fns, f => f.progress > 0 && f.progress < 100 && older(f.progress_changed_at, now, N.stuck),
    f => older(f.progress_changed_at, now, 2 * N.stuck)), { days: N.stuck, link: 'stuck' });
  out.untested = await summaries(ctx, 'untested', group(fns, f => f.progress >= 100 && f.test_status === 0 && older(f.progress_changed_at, now, N.untested)),
    { days: N.untested, link: 'untested' });
  out.failed_retest = await summaries(ctx, 'failed_retest', group(fns, f => f.test_status === 3 && older(f.test_changed_at, now, N.failed)),
    { days: N.failed, link: 'failed' });
  out.pass_conflict = await summaries(ctx, 'pass_conflict', group(fns, passConflict), { days: 0, link: 'conflict' });
  // T5: once the project has started; catalog items have no created_at — their first recorded change counts
  const sch = (await query('SELECT start_date FROM schedule WHERE id=1')).rows[0];
  const started = sch?.start_date && new Date(sch.start_date + 'T00:00:00') <= now;
  out.not_started = await summaries(ctx, 'not_started', started ? group(fns, f => f.progress === 0 && older(f.created_at || f.progress_changed_at, now, N.ns)) : new Map(),
    { days: N.ns, byDept: true });
  return out;
}

async function qualityWeekly(ctx) {
  const fns = (await query(`SELECT id, app_id, item_type, notif_status, review_status FROM functions WHERE enabled AND removed_at IS NULL`)).rows;
  return { quality: await summaries(ctx, 'quality', group(fns, f => f.notif_status === 3 || f.review_status === 2), { days: 0 }) };
}

// ---------------------------------------------------------------- approvals waiting (A2, A6)
async function approvalsDigest(ctx) {
  const { now, s, lp } = ctx;
  const remind = s['notify.approval_remind_hours'] * 3600e3, escalate = s['notify.approval_escalate_days'] * DAY;
  // a move (1.10.0) waits for the approvers of the application whose approval is missing: the source, then the destination
  const reqs = (await query(`SELECT id, app_id, requested_by, requested_at, kind, target_app_id, source_approved_by FROM edit_requests WHERE status='pending'`)).rows
    .map(r => ({ ...r, age: now - new Date(r.requested_at), waits: r.kind === 'move_function' && r.source_approved_by ? r.target_app_id : r.app_id }))
    .filter(r => r.age >= remind);
  const entries = [];
  for (const user of reach(ctx, 'approval_overdue')) {
    const mine = reqs.filter(r => r.requested_by !== user.id && hasPerm(user, 'apv_dept') && ctx.apps.get(r.waits) && canSeeApp(user, ctx.apps.get(r.waits)));
    const esc = user.fullScope && hasPerm(user, 'apv_final') ? reqs.filter(r => r.age >= escalate && r.requested_by !== user.id) : mine.filter(r => r.age >= escalate);
    const stage = esc.length ? 'escalate' : mine.length ? 'remind' : null;
    if (!stage) continue;
    entries.push({ user, dedupeKey: `approval_overdue:${lp.date}`, count: stage === 'escalate' ? esc.length : mine.length,
      severity: stage === 'escalate' ? 'critical' : 'warning', link: '/approvals',
      params: { stage, hours: s['notify.approval_remind_hours'], days: s['notify.approval_escalate_days'], total: mine.length } });
  }
  const out = { approval_overdue: await publish('approval_overdue', entries) };
  // A6: result files waiting longer than notify.import_overdue_days, to whoever can sign the missing stage
  const batches = (await query(`SELECT * FROM import_batches WHERE status='pending' AND uploaded_at < $1`, [new Date(now - s['notify.import_overdue_days'] * DAY)])).rows;
  const meta = await loadImportMeta();
  const appsOf = await batchApps({ query }, batches.map(b => b.id));
  const e6 = [];
  for (const user of reach(ctx, 'import_overdue')) {
    const n = batches.filter(b => { const a = importAbilities(user, b, meta, appsOf.get(b.id) || []); return a.approve_lead || a.approve_final; }).length;
    if (n) e6.push({ user, dedupeKey: `import_overdue:${lp.date}`, count: n, link: '/imports', params: { days: s['notify.import_overdue_days'] } });
  }
  out.import_overdue = await publish('import_overdue', e6);
  return out;
}

// ---------------------------------------------------------------- plan (P1–P4)
const SYSTEM_READER = { id: 0, role: 'system', permissions: [], fullScope: true, scope: { departments: [], applications: [] } };
const P_SEV = { delayed: 'critical', overdue: 'critical', at_risk: 'warning' };

async function health(ctx) {
  const st = await projectStatusData(SYSTEM_READER);
  const m = scheduleModel({ ...st.schedule, current_pct: st.total.pct }, ctx.now);
  return { st, h: projectHealth(m, st, ctx.now, st.health_gaps) };
}

async function planDigest(ctx) {
  const { st, h } = await health(ctx);
  const out = { dept_behind: 0, project_status: 0, close_approaching: 0 };
  const depts = await deptNames();
  // P1: only when a department's status changes (first run: from «on track»)
  const prev = (await getState('dept_status')) || {};
  const next = {};
  for (const d of h.departments) {
    next[d.id] = d.status;
    const was = prev[d.id] || 'on_track';
    if (!d.status || d.status === was || d.status === 'done') continue;
    if (d.status === 'on_track' && !['at_risk', 'delayed'].includes(was)) continue;
    const key = `dept_behind:dept=${d.id}:${d.status}`;
    const dn = depts.get(d.id);
    const entries = reach(ctx, 'dept_behind').filter(u => coversDept(u, d.id)).map(user => ({ user, dedupeKey: key, deptId: d.id,
      severity: P_SEV[d.status] || 'info', link: '/status',
      params: { dept_id: d.id, dept_ar: dn?.name_ar, dept_en: dn?.name_en, status: d.status, gap: d.gap, pct: d.pct, planned: h.planned } }));
    await deliver('dept_behind', entries);
    // the department's alert about its previous status is closed
    for (const sOld of ['on_track', 'at_risk', 'delayed'].filter(x => x !== d.status)) {
      await resolveExcept('dept_behind', [], { onlyKey: `dept_behind:dept=${d.id}:${sOld}` });
    }
    out.dept_behind += entries.length;
  }
  await setState('dept_status', next);
  // P3: the project's status changed
  const prevP = await getState('project_status');
  if (h.status && prevP?.status !== h.status && (prevP || ['at_risk', 'delayed', 'overdue'].includes(h.status))) {
    const bad = ['at_risk', 'delayed', 'overdue'];
    if (bad.includes(h.status) || bad.includes(prevP?.status)) {
      const key = `project_status:${h.status}`;
      const entries = reach(ctx, 'project_status').filter(u => u.fullScope).map(user => ({ user, dedupeKey: key, link: '/status',
        severity: P_SEV[h.status] || 'info', params: { from: prevP?.status || null, to: h.status, delay_days: h.delayDays > 0 ? h.delayDays : null } }));
      await deliver('project_status', entries);
      await resolveExcept('project_status', entries.map(e => ({ userId: e.user.id, key })));
      out.project_status = entries.length;
    }
  }
  await setState('project_status', { status: h.status });
  // P4: once per close date
  const end = st.schedule.end_date;
  if (end && st.total.pct < 99.95) {
    const left = Math.ceil((new Date(end + 'T00:00:00') - ctx.now) / DAY);
    const told = await getState('close_approaching');
    if (left > 0 && left <= ctx.s['notify.close_warning_days'] && told?.end !== end) {
      const entries = reach(ctx, 'close_approaching').filter(u => u.fullScope).map(user => ({ user, dedupeKey: `close_approaching:${end}`,
        link: '/status', params: { days: left, pct: st.total.pct, end } }));
      await deliver('close_approaching', entries);
      await setState('close_approaching', { end });
      out.close_approaching = entries.length;
    }
  }
  return out;
}

async function stalledWeekly(ctx) {
  const { h } = await health(ctx);
  if (!h.ready || h.status === 'not_started' || h.status === 'no_dates') return { dept_stalled: await publish('dept_stalled', []) };
  const depts = await deptNames();
  const limit = ctx.s['notify.dept_stalled_points'];
  const entries = [];
  for (const d of h.departments) {
    if (d.change30 === null || d.change30 > limit || d.pct >= 99.95) continue;
    const dn = depts.get(d.id);
    for (const user of reach(ctx, 'dept_stalled').filter(u => coversDept(u, d.id))) {
      entries.push({ user, dedupeKey: `dept_stalled:dept=${d.id}:${ctx.lp.date}`, deptId: d.id, link: '/status',
        params: { dept_id: d.id, dept_ar: dn?.name_ar, dept_en: dn?.name_en, change: d.change30, pct: d.pct } });
    }
  }
  return { dept_stalled: await publish('dept_stalled', entries) };
}

// ---------------------------------------------------------------- security and system (S2–S6, S8)
const hourKey = now => now.toISOString().slice(0, 13);
const LOGIN_FAIL = `NOT success AND (event IN ('login_bad_password','login_unknown_user','login_while_locked','login_inactive_user',
  'login_ambiguous_email') OR event LIKE 'mfa\\_%')`;

async function securityChecks(ctx) {
  const { s, now } = ctx;
  const admins = reach(ctx, 'failed_logins');
  const out = { failed_logins: 0, access_denied: 0, server_errors: 0 };
  const N = s['notify.failed_logins_threshold'];
  const rows = (await query(`SELECT host(ip) AS ip, count(*)::int AS n FROM auth_log WHERE ts > now() - interval '15 minutes' AND ${LOGIN_FAIL} GROUP BY 1`)).rows;
  const entries = [];
  for (const r of rows.filter(x => x.n >= N)) {
    for (const user of admins) entries.push({ user, dedupeKey: `failed_logins:ip=${r.ip}:${hourKey(now)}`, count: r.n, link: '/logs?tab=auth', params: { ip: r.ip, minutes: 15 } });
  }
  const total = rows.reduce((a, x) => a + x.n, 0);
  if (total >= N && !rows.some(x => x.n >= N)) {
    for (const user of admins) entries.push({ user, dedupeKey: `failed_logins:all:${hourKey(now)}`, count: total, link: '/logs?tab=auth', params: { minutes: 15 } });
  }
  if (entries.length) { await deliver('failed_logins', entries); out.failed_logins = entries.length; }
  const denied = (await query(`SELECT count(*)::int AS n FROM auth_log WHERE ts > now() - interval '1 hour' AND event IN ('access_denied','csrf_rejected')`)).rows[0].n;
  if (denied >= s['notify.access_denied_threshold']) {
    const e = reach(ctx, 'access_denied').map(user => ({ user, dedupeKey: `access_denied:${hourKey(now)}`, count: denied, link: '/logs?tab=auth' }));
    await deliver('access_denied', e); out.access_denied = e.length;
  }
  const errors = (await query(`SELECT count(*)::int AS n FROM error_log WHERE ts > now() - interval '1 hour'`)).rows[0].n;
  if (errors >= s['notify.server_errors_threshold']) {
    const e = reach(ctx, 'server_errors').map(user => ({ user, dedupeKey: `server_errors:${hourKey(now)}`, count: errors, link: '/logs?tab=error' }));
    await deliver('server_errors', e); out.server_errors = e.length;
  }
  return out;
}

async function dailySystem(ctx) {
  const { s, now, lp } = ctx;
  const out = {};
  // S3: the audit_log / auth_log hash chains
  const integ = await verifyAll();
  out.audit_integrity = await publish('audit_integrity', integ.ok ? [] : reach(ctx, 'audit_integrity').map(user => ({ user,
    dedupeKey: `audit_integrity:${lp.date}`, link: '/logs?tab=integrity', params: { tables: integ.tables.filter(t => !t.ok).map(t => t.table) } })));
  // S4: the unique e-mail index of migration 014 / 015 is missing
  const missing = (await query(`SELECT to_regclass('users_email_lower_uniq') IS NULL AS m`)).rows[0].m;
  out.email_index = await publish('email_index', missing ? reach(ctx, 'email_index').map(user => ({ user, dedupeKey: `email_index:${lp.date}`, link: '/users' })) : []);
  // S6: ets-backup writes system_log 'backup' only when it succeeds; nothing for notify.backup_max_age_hours → alert
  // (not in the first hours of a new installation)
  const H = s['notify.backup_max_age_hours'];
  const b = (await query(`SELECT (SELECT max(ts) FROM system_log WHERE event='backup') AS last, (SELECT min(ts) FROM system_log) AS first`)).rows[0];
  const stale = (!b.last || now - new Date(b.last) > H * 3600e3) && b.first && now - new Date(b.first) > H * 3600e3;
  out.backup_missing = await publish('backup_missing', stale ? reach(ctx, 'backup_missing').map(user => ({ user, dedupeKey: `backup_missing:${lp.date}`,
    link: '/logs?tab=system', params: { hours: H, last: b.last ? new Date(b.last).toISOString() : null } })) : []);
  // phones not used for notify.device_idle_days
  out.devices_revoked = (await tx(async c => {
    const ids = (await c.query(`SELECT id FROM mobile_devices WHERE revoked_at IS NULL AND COALESCE(last_seen_at, created_at) < $1`,
      [new Date(now - s['notify.device_idle_days'] * DAY)])).rows.map(r => r.id);
    return ids.length ? revokeDevices(c, null, { ids, reason: 'inactive' }) : [];
  })).length;
  // retention: read alerts after notify.retention_days, unread after twice that; used / expired pairing codes after a day
  const days = s['notify.retention_days'];
  out.purged = (await query(`DELETE FROM notifications WHERE (read_at IS NOT NULL AND read_at < now() - make_interval(days => $1))
    OR created_at < now() - make_interval(days => $1 * 2)`, [days])).rowCount;
  out.pair_codes_purged = (await query(`DELETE FROM device_pair_codes WHERE expires_at < now() - interval '1 day'`)).rowCount;
  return out;
}

const JOBS = {
  security: securityChecks,
  daily: dailySystem,
  digest: async ctx => ({ ...(await trackingDigest(ctx)), ...(await approvalsDigest(ctx)), ...(await planDigest(ctx)) }),
  weekly: async ctx => ({ ...(await qualityWeekly(ctx)), ...(await stalledWeekly(ctx)) }),
};
export const JOB_NAMES = Object.keys(JOBS);

// The scheduler of server.js: every 15 minutes (first run 30 s after start).
export function startScheduler({ everyMs = 15 * 60_000, firstMs = 30_000 } = {}) {
  const run = () => runScan().catch(e => logger.error({ err: e.message }, 'notification check failed'));
  setTimeout(run, firstMs).unref();
  return setInterval(run, everyMs).unref();
}

