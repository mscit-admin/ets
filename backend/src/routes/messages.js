// /api/messages — in-app messaging (1.12.26). A user with 'msg' composes a message to selected recipients
// (individuals, by department, by role, or everyone) within their visible scope; each recipient gets a PRIVATE 1:1
// conversation thread with the sender and can reply. Receiving and replying need no permission. A user only ever
// sees threads they are a party to (author or recipient); there is no cross-recipient visibility.
//   POST /                send a message (requirePerm 'msg', rate-limited, audited)
//   POST /resolve         preview the resolved recipient count for an audience (requirePerm 'msg')
//   GET  /recipients?q=   the individuals the sender may message, searchable (requirePerm 'msg')
//   GET  /compose-meta    the departments and roles the sender may target, scope-limited (requirePerm 'msg')
//   GET  /inbox           the caller's received conversations
//   GET  /sent            the caller's authored broadcasts (requirePerm 'msg')
//   GET  /sent/:id        the per-recipient threads of one of the caller's broadcasts (author only)
//   GET  /threads/:id     a thread the caller is a party to; marks it read for the caller's side
//   POST /threads/:id/reply   append a reply (author or recipient of that thread only)
//   GET  /unread-count    the nav badge: unread received threads (+ unread replies for 'msg' users)
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requirePerm, hasPerm } from '../middleware/auth.js';
import { tx } from '../db/pool.js';
import { query } from '../db/pool.js';
import { logAudit } from '../services/logs.js';
import { HttpError, bad, idParam, str } from '../utils/http.js';
import {
  BODY_MAX, SUBJECT_MAX, normAudience, audienceEmpty, resolveAudience, visibleRecipients,
  sendBroadcast, inbox, sent, broadcastThreads, loadThread, threadPosts, markThreadRead, sideOf, addReply, unreadCount,
} from '../services/messages.js';

const r = Router();
r.use(requireAuth);

// Per-user send ceiling (abuse guard): a compose counts once regardless of recipient count.
const perUser = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => 'u:' + req.user.id,
  handler: (req, res) => res.status(429).json({ error: 'too_many_requests', retry_after: Math.ceil(windowMs / 1000) }) });
const sendLimiter = perUser(+(process.env.ETS_MESSAGE_SEND_LIMIT || 60), 60 * 60_000);
const replyLimiter = perUser(+(process.env.ETS_MESSAGE_REPLY_LIMIT || 240), 60 * 60_000);

// Validate subject (optional) and body (required, 1..4000). Direction marks are already stripped by the body parser.
function readMessage(b) {
  const subject = typeof b?.subject === 'string' && b.subject.trim() ? str(b.subject, SUBJECT_MAX) : null;
  const body = typeof b?.body === 'string' ? b.body.trim().slice(0, BODY_MAX) : '';
  if (!body) throw bad('invalid_value', { field: 'body' });
  return { subject, body };
}

// POST / — send. Resolves the audience against the sender's scope, drops out-of-scope ids, excludes the sender.
r.post('/', requirePerm('msg'), sendLimiter, async (req, res) => {
  const { subject, body } = readMessage(req.body);
  const audience = normAudience(req.body?.audience);
  if (audienceEmpty(audience)) throw bad('invalid_value', { field: 'audience' });
  const { recipients, resolved } = await resolveAudience(req.user, audience);
  if (!recipients.length) throw bad('no_recipients');
  const out = await tx(async c => {
    const r2 = await sendBroadcast(c, req.user, { subject, body, recipients, audience: resolved });
    await logAudit(req, { db: c, action: 'message_send', entity: 'message_broadcast', entityId: r2.broadcast_id,
      summary: subject || body.slice(0, 120), newValue: { recipient_count: r2.sent, audience: resolved } });
    return r2;
  });
  res.status(201).json(out);
});

// POST /resolve — how many recipients an audience resolves to (for the compose preview). No side effect, no audit.
r.post('/resolve', requirePerm('msg'), async (req, res) => {
  const audience = normAudience(req.body?.audience);
  const { recipients } = await resolveAudience(req.user, audience);
  res.json({ count: recipients.length,
    recipients: recipients.slice(0, 50).map(u => ({ id: u.id, full_name: u.full_name, username: u.username, role: u.role })) });
});

// GET /recipients?q= — the individuals the sender may message, searchable by name / username.
r.get('/recipients', requirePerm('msg'), async (req, res) => {
  const q = str(req.query.q, 100).toLowerCase();
  let list = await visibleRecipients(req.user);
  if (q) list = list.filter(u => (u.full_name || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q));
  res.json({ recipients: list.slice(0, 50).map(u => ({ id: u.id, full_name: u.full_name, username: u.username, role: u.role })) });
});

// GET /compose-meta — the departments and roles present among the sender's visible recipients (scope-limited), so
// the "by department" / "by role" pickers only offer options the sender can actually reach.
r.get('/compose-meta', requirePerm('msg'), async (req, res) => {
  const list = await visibleRecipients(req.user);
  const roleIds = [...new Set(list.map(u => u.role))];
  const deptIds = new Set();
  const [roles, depts, apps] = await Promise.all([
    query('SELECT id, name_ar, name_en FROM roles'),
    query('SELECT id, name_ar, name_en, short_ar, short_en FROM departments ORDER BY sort'),
    query('SELECT id, department_id FROM applications'),
  ]);
  const appDept = new Map(apps.rows.map(a => [a.id, a.department_id]));
  for (const u of list) {
    for (const d of u.scope.departments) deptIds.add(d);
    for (const a of u.scope.applications) { const d = appDept.get(a); if (d) deptIds.add(d); }
    if (u.fullScope) for (const d of depts.rows) deptIds.add(d.id);   // a full-scope recipient reaches every department
  }
  res.json({
    departments: depts.rows.filter(d => deptIds.has(d.id)),
    roles: roles.rows.filter(x => roleIds.includes(x.id)),
    total_recipients: list.length,
  });
});

r.get('/inbox', async (req, res) => res.json({ threads: await inbox(req.user.id) }));

r.get('/sent', requirePerm('msg'), async (req, res) => res.json({ broadcasts: await sent(req.user.id) }));

r.get('/sent/:id', requirePerm('msg'), async (req, res) => {
  const data = await broadcastThreads(idParam(req.params.id), req.user.id);
  if (!data) throw new HttpError(404, 'not_found');
  res.json(data);
});

// GET /threads/:id — a thread the caller is a party to (author or recipient). 403 for anyone else: no cross-recipient
// leakage. Marks the caller's own side read.
r.get('/threads/:id', async (req, res) => {
  const t = await loadThread(idParam(req.params.id), req.user.id);
  if (!t) throw new HttpError(404, 'not_found');
  if (t.forbidden) throw new HttpError(403, 'forbidden');
  const side = sideOf(t, req.user.id);
  await markThreadRead(t.id, side);
  const posts = await threadPosts(t.id);
  res.json({
    thread: {
      id: t.id, broadcast_id: t.broadcast_id, subject: t.subject, created_at: t.created_at, last_post_at: t.last_post_at,
      closed_at: t.closed_at, side,
      author: { id: t.author_id, full_name: t.author_name, username: t.author_username },
      recipient: { id: t.recipient_id, full_name: t.recipient_name, username: t.recipient_username },
    },
    posts: posts.map(p => ({ id: p.id, author_id: p.author_id, author_name: p.author_name, body: p.body,
      created_at: p.created_at, mine: p.author_id === req.user.id })),
  });
});

// POST /threads/:id/reply — append a reply. Only the thread's author or recipient may post; notifies the other party.
r.post('/threads/:id/reply', replyLimiter, async (req, res) => {
  const t = await loadThread(idParam(req.params.id), req.user.id);
  if (!t) throw new HttpError(404, 'not_found');
  if (t.forbidden) throw new HttpError(403, 'forbidden');
  if (t.closed_at) throw bad('thread_closed');
  const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, BODY_MAX) : '';
  if (!body) throw bad('invalid_value', { field: 'body' });
  const out = await tx(c => addReply(c, t, req.user, body));
  res.status(201).json(out);
});

r.get('/unread-count', async (req, res) => res.json(await unreadCount(req.user.id, hasPerm(req.user, 'msg'))));

export default r;
