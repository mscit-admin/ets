// Event-driven alerts (⚡ in the proposal): created once the change has committed (callers use onCommit or call
// after their transaction), never failing the action they follow (services/notify.js deliver() logs and returns).
//   A1 approval_pending   an edit request waits for the team lead → the application's approvers (not its author)
//   A3 request_decided    a request was applied / rejected → its author
//   A4 import_pending     a result file waits for a signature → whoever can sign the stage that is missing
//   A5 import_result      a file was applied / rejected / replaced → its uploader and the first-stage signer
//   T7 excluded           functions excluded or removed → users of the application (not the people who did it)
//   T8 moved_in           items moved into an application (1.10.0) → users of that application (not who moved / approved)
//   S1 account_locked     an account's sign-in was paused → administrators
//   S7 retention_reduced  a log retention setting was lowered → administrators
import { query } from '../db/pool.js';
import { hasPerm, canSeeApp } from '../middleware/auth.js';
import { activeUsers, appMap, deliver, resolveExcept } from './notify.js';
import { logger } from './logs.js';

const safe = (name, fn) => async (...a) => {
  try { return await fn(...a); } catch (e) { logger.warn({ err: e.message, event: name }, 'notify: event failed'); return null; }
};
const appParams = a => (a ? { app_id: a.id, app_ar: a.name_ar, app_en: a.name_en } : {});
const fullName = async id => (id ? (await query('SELECT full_name FROM users WHERE id=$1', [id])).rows[0]?.full_name || null : null);
const admins = async () => (await activeUsers()).filter(u => u.role === 'admin');

// ---- A1: a new edit request (rq: edit_requests row)
// A move (1.10.0) waits for the approvers of both applications: each is told under the application they approve for
// (the source first when they approve both).
export const requestCreated = safe('request_created', async rq => {
  if (rq.status !== 'pending') return;
  const apps = await appMap();
  const app = apps.get(rq.app_id);
  if (!app) return;
  const dst = rq.target_app_id ? apps.get(rq.target_app_id) : null;
  const by = await fullName(rq.requested_by);
  const approver = (u, a) => !!a && hasPerm(u, 'apv_dept') && canSeeApp(u, a);
  const entries = [];
  for (const user of (await activeUsers()).filter(u => u.id !== rq.requested_by)) {
    const a = approver(user, app) ? app : approver(user, dst) ? dst : null;
    if (!a) continue;
    entries.push({ user, dedupeKey: `approval_pending:app=${a.id}`, mode: 'add', appId: a.id, deptId: a.department_id, link: '/approvals',
      params: { ...appParams(a), by_name: by, request_id: rq.id } });
  }
  await deliver('approval_pending', entries);
});

// After a request is decided (any way): the approvers' open «waiting for you» alert of that application closes when
// nothing is pending there any more.
export const requestsSettled = safe('requests_settled', async appId => {
  // a move (1.10.0) waits for its source application until the source lead approved it, then for its destination
  const pending = (await query(`SELECT count(*)::int AS n FROM edit_requests WHERE status='pending'
    AND ((app_id=$1 AND (kind <> 'move_function' OR source_approved_by IS NULL)) OR (target_app_id=$1 AND source_approved_by IS NOT NULL))`, [appId])).rows[0].n;
  if (!pending) await resolveExcept('approval_pending', [], { onlyKey: `approval_pending:app=${appId}` });
});

// ---- A3: decision on a request (status applied | rejected)
export const requestDecided = safe('request_decided', async (rq, { status, reason = null, result = null }) => {
  if (!['applied', 'rejected'].includes(status)) return;
  const [user] = await activeUsers([rq.requested_by]);
  if (!user) return;
  const app = (await appMap()).get(rq.app_id);
  await deliver('request_decided', [{ user, dedupeKey: `request_decided:${rq.id}`, link: '/approvals?mine=1',
    severity: status === 'rejected' ? 'warning' : 'info', appId: rq.app_id, deptId: app?.department_id,
    params: { ...appParams(app), request_id: rq.id, decision: status, reason: status === 'rejected' ? String(reason || '').slice(0, 300) : null,
      applied: result?.applied ?? null, skipped: result?.skipped ?? null } }]);
});

// ---- A4: a result file waits for signatures. able(user) → can sign a stage now (routes/imports.js abilities()).
export const importWaiting = safe('import_waiting', async (b, able) => {
  const key = `import_pending:batch=${b.id}`;
  if (b.status !== 'pending') return resolveExcept('import_pending', [], { onlyKey: key });
  const depts = (b.departments?.length ? b.departments : [b.department_id]).filter(Boolean);
  const names = depts.length === 1 ? (await query('SELECT name_ar, name_en FROM departments WHERE id=$1', [depts[0]])).rows[0] : null;
  const users = (await activeUsers()).filter(u => u.id !== b.uploaded_by && able(u));
  const keep = users.map(u => ({ userId: u.id, key }));
  await resolveExcept('import_pending', keep, { onlyKey: key });      // e.g. the team lead once they signed
  await deliver('import_pending', users.map(user => ({ user, dedupeKey: key, link: `/imports/${b.id}`,
    deptId: depts.length === 1 ? depts[0] : null,
    params: { batch_id: b.id, target: b.target, depts, stage: b.lead_by ? 'final' : b.final_by ? 'lead' : 'any',
      dept_id: depts.length === 1 ? depts[0] : null, dept_ar: names?.name_ar ?? null, dept_en: names?.name_en ?? null } })));
});

// ---- A5: a file's outcome (status applied | rejected | superseded); actorId: who caused it (not told)
export const importClosed = safe('import_closed', async (b, { status, actorId = null, result = null, reason = null }) => {
  await resolveExcept('import_pending', [], { onlyKey: `import_pending:batch=${b.id}` });
  const ids = [...new Set([b.uploaded_by, b.lead_by].filter(id => id && id !== actorId))];
  if (!ids.length) return;
  const users = await activeUsers(ids);
  await deliver('import_result', users.map(user => ({ user, dedupeKey: `import_result:${b.id}`, link: `/imports/${b.id}`,
    severity: status === 'applied' ? 'info' : 'warning',
    params: { batch_id: b.id, status, applied: result?.applied ?? null, skipped: result?.skipped ?? null,
      reason: reason ? String(reason).slice(0, 300) : null } })));
});

// ---- T7: functions of an application excluded (enabled → false) or removed. n: how many; exclude: user ids who did it.
export const functionsExcluded = safe('functions_excluded', async (appId, n, exclude = []) => {
  if (!(n > 0)) return;
  const app = (await appMap()).get(appId);
  if (!app) return;
  const by = exclude[0] ? await fullName(exclude[0]) : null;
  const users = (await activeUsers()).filter(u => !exclude.includes(u.id) && canSeeApp(u, app));
  await deliver('excluded', users.map(user => ({ user, dedupeKey: `excluded:app=${appId}`, mode: 'add', count: n,
    appId, deptId: app.department_id, link: `/app/${appId}`, params: { ...appParams(app), by_name: by } })));
});

// ---- T8: items moved into an application (1.10.0). src / dst: { id }; n: how many; exclude: who moved / approved.
// The source application is named only to readers who have it in scope.
export const itemsMovedIn = safe('items_moved_in', async (srcId, dstId, n, exclude = []) => {
  if (!(n > 0)) return;
  const apps = await appMap();
  const dst = apps.get(dstId), src = apps.get(srcId);
  if (!dst) return;
  const by = exclude[0] ? await fullName(exclude[0]) : null;
  const users = (await activeUsers()).filter(u => !exclude.includes(u.id) && canSeeApp(u, dst));
  await deliver('moved_in', users.map(user => ({ user, dedupeKey: `moved_in:app=${dstId}`, mode: 'add', count: n,
    appId: dstId, deptId: dst.department_id, link: `/app/${dstId}`,
    params: { ...appParams(dst), by_name: by, ...(src && canSeeApp(user, src) ? { from_app_id: src.id, from_app_ar: src.name_ar, from_app_en: src.name_en } : {}) } })));
});

// ---- S1: an account's sign-in was paused (services/lockout.js)
export const accountLocked = safe('account_locked', async u => {
  const list = await admins();
  await deliver('account_locked', list.map(user => ({ user, dedupeKey: `account_locked:user=${u.id}`, mode: 'add',
    link: '/logs?tab=auth', params: { username: u.username } })));
});

// ---- S7: a log retention setting was lowered (routes/settings.js)
export const retentionReduced = safe('retention_reduced', async ({ key, from, to, by }) => {
  const list = await admins();
  await deliver('retention_reduced', list.map(user => ({ user, dedupeKey: `retention_reduced:${key}:${Date.now()}`,
    link: '/settings', params: { key, from, to, by } })));
});
