// In-app messaging (1.12.26): a user with the 'msg' permission composes a message and sends it to selected
// recipients — specific individuals, by department, by role, or everyone (combinable). Each recipient gets a
// PRIVATE 1:1 conversation (thread) with the sender; replies go back and forth between those two only. A message
// sent to "everyone" still becomes one thread per recipient — a recipient NEVER sees another recipient's thread or
// replies. The 'msg' permission grants the ability to SEND (within the sender's visible scope); it does not widen
// who the sender can see, so the recipient set is always intersected with the sender's scope (below). Receiving and
// replying need no permission: anyone messaged can read and reply.
//
// Scope / visibility model (routes/messages.js and the compose picker both rely on this):
//   - A full-scope sender (admin / pm / tm) can message everyone.
//   - A scoped sender can message a user whose "department reach" overlaps theirs (they share at least one
//     department, directly or through an application's department), plus full-scope users (managers/admins, who can
//     see everyone anyway). It mirrors the existing canSee / scope model (middleware/auth.js): 'msg' never bypasses
//     it. A user out of scope is silently dropped from any audience; they can never be messaged.
import { query } from '../db/pool.js';
import { activeUsers, appMap } from './notify.js';
import { messagePosted, alertResponded } from './notify-events.js';
import { onCommit } from '../db/pool.js';

export const BODY_MIN = 1;
export const BODY_MAX = 4000;
export const SUBJECT_MAX = 200;
export const PREVIEW_LEN = 140;

const preview = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN) : '');

// Departments a user "reaches": scoped departments plus the departments of their scoped applications.
function userDepts(user, apps) {
  const set = new Set(user.scope.departments);
  for (const id of user.scope.applications) { const a = apps.get(id); if (a) set.add(a.department_id); }
  return set;
}

// Can sender see / message target? Symmetric. Full scope on either side → yes; otherwise their department reaches
// must overlap. Never lets a scoped sender reach a user outside their scope.
export function canSeeUser(sender, target, apps) {
  if (sender.id === target.id) return true;
  if (sender.fullScope || target.fullScope) return true;
  const a = userDepts(sender, apps), b = userDepts(target, apps);
  for (const d of a) if (b.has(d)) return true;
  return false;
}

// The active users the sender may message (excluding the sender), with the fields the picker needs. Scope-limited.
export async function visibleRecipients(sender) {
  const apps = await appMap();
  const users = await activeUsers();
  return users.filter(u => u.id !== sender.id && canSeeUser(sender, u, apps));
}

// Normalise an audience request body into { all, users:[int], depts:[str], roles:[str] }.
export function normAudience(a) {
  const o = a && typeof a === 'object' && !Array.isArray(a) ? a : {};
  const ints = v => (Array.isArray(v) ? [...new Set(v.filter(x => Number.isInteger(x) && x >= 1))] : []);
  const strs = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x.length <= 64))] : []);
  return { all: !!o.all, users: ints(o.users), depts: strs(o.depts), roles: strs(o.roles) };
}
export const audienceEmpty = a => !a.all && !a.users.length && !a.depts.length && !a.roles.length;

// Resolve an audience to the concrete recipient user objects the sender is ALLOWED to reach. Always scope-limited:
// the candidate set is taken only from the sender's visible recipients, so out-of-scope ids/depts/roles contribute
// nothing. The sender is always excluded. Returns { recipients: [user], resolved: {...} }.
export async function resolveAudience(sender, audience) {
  const apps = await appMap();
  const visible = await visibleRecipients(sender);         // already scope-limited and sender-excluded
  const byDept = new Map(visible.map(u => [u.id, userDepts(u, apps)]));
  const want = normAudience(audience);
  const idSet = new Set(want.users);
  const deptSet = new Set(want.depts);
  const roleSet = new Set(want.roles);
  const chosen = new Map();
  for (const u of visible) {
    let take = want.all;
    if (!take && idSet.has(u.id)) take = true;
    if (!take && roleSet.size && roleSet.has(u.role)) take = true;
    if (!take && deptSet.size) { for (const d of byDept.get(u.id)) if (deptSet.has(d)) { take = true; break; } }
    if (take) chosen.set(u.id, u);
  }
  return { recipients: [...chosen.values()], resolved: want };
}

export const KINDS = ['message', 'alert'];
export const normKind = k => (k === 'alert' ? 'alert' : 'message');
// The two response statuses an alert recipient must choose from (1.12.29): «موافق على التنبيه» / «أنتظر — أعمل على المنصة».
export const RESPONSE_STATUSES = ['ack', 'working'];

// Create the broadcast + one thread per recipient + the initial post in each, in one transaction. kind: 'message'
// (the default) or 'alert'. Fires a 'message_received' (or, for an alert, 'alert_received') alert to each recipient
// after commit. The thread carries a denormalised copy of the kind. Returns { broadcast_id, sent, kind }.
export async function sendBroadcast(db, sender, { subject, body, recipients, audience, kind = 'message' }) {
  const subj = subject ? subject.slice(0, SUBJECT_MAX) : null;
  const k = normKind(kind);
  const b = (await db.query(
    `INSERT INTO message_broadcasts(author_id, subject, body, audience, recipient_count, kind)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
    [sender.id, subj, body, JSON.stringify(audience), recipients.length, k])).rows[0];
  const fromName = sender.full_name || sender.username;
  const notifType = k === 'alert' ? 'alert_received' : 'message_received';
  for (const r of recipients) {
    const th = (await db.query(
      `INSERT INTO message_threads(broadcast_id, author_id, recipient_id, subject, kind, last_post_at, author_read_at)
       VALUES ($1,$2,$3,$4,$5, now(), now()) RETURNING id`,
      [b.id, sender.id, r.id, subj, k])).rows[0];
    const post = (await db.query(
      `INSERT INTO message_posts(thread_id, author_id, body) VALUES ($1,$2,$3) RETURNING id`,
      [th.id, sender.id, body])).rows[0];
    onCommit(db, () => messagePosted({ type: notifType, toUserId: r.id, fromName, subject: subj,
      preview: preview(body), threadId: th.id, postId: post.id }));
  }
  return { broadcast_id: b.id, sent: recipients.length, kind: k };
}

// The recipient's next PENDING mandatory alert (an alert thread with no response yet), oldest first, or null. Carries
// the alert's subject, body (its first post), sender and thread id — what the blocking popup needs. The partial index
// message_threads_pending_alert serves this hot-path lookup.
export async function pendingAlert(userId) {
  const t = (await query(
    `SELECT t.id, t.broadcast_id, t.subject, t.created_at,
            au.full_name AS from_name, au.username AS from_username,
            (SELECT p.body FROM message_posts p WHERE p.thread_id = t.id ORDER BY p.created_at, p.id LIMIT 1) AS body
       FROM message_threads t
       JOIN users au ON au.id = t.author_id
      WHERE t.recipient_id = $1 AND t.kind = 'alert' AND t.response_status IS NULL
      ORDER BY t.created_at, t.id LIMIT 1`, [userId])).rows[0];
  if (!t) return null;
  return { thread_id: Number(t.id), broadcast_id: t.broadcast_id, subject: t.subject, body: t.body,
    from_name: t.from_name, from_username: t.from_username, created_at: t.created_at };
}

// The count of a user's pending mandatory alerts (for the nav badge / the gate signal).
export async function pendingAlertCount(userId) {
  return (await query(
    `SELECT count(*)::int AS n FROM message_threads
      WHERE recipient_id = $1 AND kind = 'alert' AND response_status IS NULL`, [userId])).rows[0].n;
}

// The recipient answers an alert: set the status (+ optional note + responded_at), post the note as a message_post
// (so it appears in the thread), mark the recipient's side read, and notify the sender ('alert_response'). The caller
// (route) has already verified the thread belongs to this recipient; here we also require it be an UNRESPONDED ALERT
// thread. Returns { ok, status } or { error } (bad_status | not_alert | already_responded).
export async function respondAlert(db, thread, responder, status, note) {
  if (thread.kind !== 'alert') return { error: 'not_alert' };
  if (thread.response_status) return { error: 'already_responded' };
  if (!RESPONSE_STATUSES.includes(status)) return { error: 'bad_status' };
  const noteText = typeof note === 'string' && note.trim() ? note.trim().slice(0, BODY_MAX) : null;
  await db.query(
    `UPDATE message_threads SET response_status = $2, response_note = $3, responded_at = now(),
            last_post_at = now(), recipient_read_at = now()
      WHERE id = $1`, [thread.id, status, noteText]);
  if (noteText) {
    await db.query(`INSERT INTO message_posts(thread_id, author_id, body) VALUES ($1,$2,$3)`,
      [thread.id, responder.id, noteText]);
  }
  const fromName = responder.full_name || responder.username;
  onCommit(db, () => alertResponded({ toUserId: thread.author_id, fromName, subject: thread.subject,
    status, note: noteText ? preview(noteText) : null, threadId: thread.id }));
  return { ok: true, status };
}

// An author's alert broadcast with every recipient's thread, response and posts — for the sender's TREE view. Author
// only (enforced by the WHERE clause). Returns null when the broadcast is not an alert the caller authored.
export async function alertSent(broadcastId, authorId) {
  const b = (await query(
    `SELECT id, subject, body, created_at, recipient_count FROM message_broadcasts
      WHERE id = $1 AND author_id = $2 AND kind = 'alert'`, [broadcastId, authorId])).rows[0];
  if (!b) return null;
  const threads = (await query(
    `SELECT t.id, t.recipient_id, t.response_status, t.response_note, t.responded_at, t.last_post_at, t.created_at,
            ru.full_name AS recipient_name, ru.username AS recipient_username
       FROM message_threads t
       JOIN users ru ON ru.id = t.recipient_id
      WHERE t.broadcast_id = $1
      ORDER BY t.responded_at NULLS FIRST, t.recipient_id`, [broadcastId])).rows;
  const ids = threads.map(t => t.id);
  const postsByThread = new Map(ids.map(id => [String(id), []]));
  if (ids.length) {
    const posts = (await query(
      `SELECT p.id, p.thread_id, p.author_id, p.body, p.created_at, u.full_name AS author_name
         FROM message_posts p LEFT JOIN users u ON u.id = p.author_id
        WHERE p.thread_id = ANY($1) ORDER BY p.created_at, p.id`, [ids])).rows;
    for (const p of posts) postsByThread.get(String(p.thread_id))?.push({ id: p.id, author_id: p.author_id,
      author_name: p.author_name, body: p.body, created_at: p.created_at, mine: p.author_id === authorId });
  }
  const counts = { ack: 0, working: 0, pending: 0 };
  for (const t of threads) counts[t.response_status || 'pending']++;
  return {
    broadcast: { id: b.id, subject: b.subject, body: b.body, preview: preview(b.body), created_at: b.created_at,
      recipient_count: b.recipient_count },
    counts,
    threads: threads.map(t => ({ id: t.id, recipient_id: t.recipient_id, recipient_name: t.recipient_name,
      recipient_username: t.recipient_username, response_status: t.response_status, response_note: t.response_note,
      responded_at: t.responded_at, last_post_at: t.last_post_at, created_at: t.created_at,
      posts: postsByThread.get(String(t.id)) || [] })),
  };
}

// The recipient's received alerts with their own response (for the «التنبيهات» recipient view). Newest first.
export async function myAlerts(userId, { limit = 50 } = {}) {
  const rows = (await query(
    `SELECT t.id, t.broadcast_id, t.subject, t.response_status, t.response_note, t.responded_at,
            t.last_post_at, t.created_at,
            au.full_name AS from_name, au.username AS from_username,
            (SELECT p.body FROM message_posts p WHERE p.thread_id = t.id ORDER BY p.created_at, p.id LIMIT 1) AS body
       FROM message_threads t
       JOIN users au ON au.id = t.author_id
      WHERE t.recipient_id = $1 AND t.kind = 'alert'
      ORDER BY (t.response_status IS NULL) DESC, t.created_at DESC LIMIT $2`, [userId, limit])).rows;
  return rows.map(r => ({ id: r.id, broadcast_id: r.broadcast_id, subject: r.subject, preview: preview(r.body),
    response_status: r.response_status, response_note: r.response_note, responded_at: r.responded_at,
    last_post_at: r.last_post_at, created_at: r.created_at, from_name: r.from_name, from_username: r.from_username }));
}

// A thread the user is a party to (author or recipient), or null. Includes both party ids and names.
export async function loadThread(id, userId) {
  const t = (await query(
    `SELECT t.id, t.broadcast_id, t.author_id, t.recipient_id, t.subject, t.kind, t.created_at, t.last_post_at,
            t.author_read_at, t.recipient_read_at, t.closed_at,
            t.response_status, t.response_note, t.responded_at,
            au.full_name AS author_name, au.username AS author_username,
            ru.full_name AS recipient_name, ru.username AS recipient_username
       FROM message_threads t
       JOIN users au ON au.id = t.author_id
       JOIN users ru ON ru.id = t.recipient_id
      WHERE t.id = $1`, [id])).rows[0];
  if (!t) return null;
  if (t.author_id !== userId && t.recipient_id !== userId) return { forbidden: true };
  return t;
}

export const sideOf = (thread, userId) => (thread.author_id === userId ? 'author' : 'recipient');

// The posts of a thread, oldest first.
export async function threadPosts(threadId) {
  return (await query(
    `SELECT p.id, p.thread_id, p.author_id, p.body, p.created_at, u.full_name AS author_name, u.username AS author_username
       FROM message_posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.thread_id = $1 ORDER BY p.created_at, p.id`, [threadId])).rows;
}

// Mark the caller's side of a thread read (up to now).
export async function markThreadRead(threadId, side) {
  const col = side === 'author' ? 'author_read_at' : 'recipient_read_at';
  await query(`UPDATE message_threads SET ${col} = now() WHERE id = $1`, [threadId]);
}

// Append a post by the caller; bump last_post_at; mark the caller's own side read; notify the OTHER party.
export async function addReply(db, thread, poster, body) {
  const post = (await db.query(
    `INSERT INTO message_posts(thread_id, author_id, body) VALUES ($1,$2,$3) RETURNING id`,
    [thread.id, poster.id, body])).rows[0];
  const side = sideOf(thread, poster.id);
  const mine = side === 'author' ? 'author_read_at' : 'recipient_read_at';
  await db.query(`UPDATE message_threads SET last_post_at = now(), ${mine} = now() WHERE id = $1`, [thread.id]);
  const otherId = side === 'author' ? thread.recipient_id : thread.author_id;
  const fromName = poster.full_name || poster.username;
  onCommit(db, () => messagePosted({ type: 'message_reply', toUserId: otherId, fromName, subject: thread.subject,
    preview: preview(body), threadId: thread.id, postId: post.id }));
  return { post_id: post.id };
}

// The current user's inbox: threads where they are the recipient, newest first, with unread flag + last preview.
export async function inbox(userId, { limit = 50 } = {}) {
  const rows = (await query(
    `SELECT t.id, t.broadcast_id, t.subject, t.last_post_at, t.created_at,
            (t.recipient_read_at IS NULL OR t.recipient_read_at < t.last_post_at) AS unread,
            au.full_name AS from_name, au.username AS from_username,
            lp.body AS last_body, lp.author_id AS last_author_id
       FROM message_threads t
       JOIN users au ON au.id = t.author_id
       JOIN LATERAL (SELECT body, author_id FROM message_posts WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) lp ON true
      WHERE t.recipient_id = $1 AND t.kind = 'message'
      ORDER BY t.last_post_at DESC LIMIT $2`, [userId, limit])).rows;
  return rows.map(r => ({ id: r.id, broadcast_id: r.broadcast_id, subject: r.subject, last_post_at: r.last_post_at,
    created_at: r.created_at, unread: r.unread, from_name: r.from_name, from_username: r.from_username,
    preview: preview(r.last_body), last_mine: false }));
}

// The sender's "sent" view: the broadcasts they authored, with recipient counts, reply counts and unread-reply flag.
export async function sent(userId, { limit = 50 } = {}) {
  const rows = (await query(
    `SELECT b.id, b.subject, b.body, b.audience, b.recipient_count, b.created_at, b.kind,
            (SELECT count(*)::int FROM message_posts p JOIN message_threads t ON t.id = p.thread_id
               WHERE t.broadcast_id = b.id AND p.author_id <> b.author_id) AS reply_count,
            (SELECT count(*)::int FROM message_threads t
               WHERE t.broadcast_id = b.id AND (t.author_read_at IS NULL OR t.author_read_at < t.last_post_at)) AS unread_replies
       FROM message_broadcasts b
      WHERE b.author_id = $1 AND b.kind = 'message'
      ORDER BY b.created_at DESC LIMIT $2`, [userId, limit])).rows;
  return rows.map(r => ({ id: r.id, subject: r.subject, preview: preview(r.body), audience: r.audience,
    recipient_count: r.recipient_count, created_at: r.created_at, kind: r.kind, reply_count: r.reply_count,
    unread_replies: r.unread_replies }));
}

// The sender's ALERT list (1.12.29): the alert broadcasts they authored, each with its response counts
// (N موافق / M أنتظر / K لم يردّوا) for the «التنبيهات» sender view. Newest first.
export async function alertsSent(userId, { limit = 50 } = {}) {
  const rows = (await query(
    `SELECT b.id, b.subject, b.body, b.recipient_count, b.created_at,
            (SELECT count(*)::int FROM message_threads t WHERE t.broadcast_id = b.id AND t.response_status = 'ack') AS ack,
            (SELECT count(*)::int FROM message_threads t WHERE t.broadcast_id = b.id AND t.response_status = 'working') AS working,
            (SELECT count(*)::int FROM message_threads t WHERE t.broadcast_id = b.id AND t.response_status IS NULL) AS pending
       FROM message_broadcasts b
      WHERE b.author_id = $1 AND b.kind = 'alert'
      ORDER BY b.created_at DESC LIMIT $2`, [userId, limit])).rows;
  return rows.map(r => ({ id: r.id, subject: r.subject, preview: preview(r.body), recipient_count: r.recipient_count,
    created_at: r.created_at, counts: { ack: r.ack, working: r.working, pending: r.pending } }));
}

// The per-recipient threads of one of the caller's own broadcasts (author only — enforced by the WHERE clause).
export async function broadcastThreads(broadcastId, authorId) {
  const b = (await query(`SELECT id, subject, body, created_at, recipient_count FROM message_broadcasts WHERE id = $1 AND author_id = $2`,
    [broadcastId, authorId])).rows[0];
  if (!b) return null;
  const threads = (await query(
    `SELECT t.id, t.recipient_id, t.last_post_at, t.created_at,
            (t.author_read_at IS NULL OR t.author_read_at < t.last_post_at) AS unread,
            ru.full_name AS recipient_name, ru.username AS recipient_username,
            (SELECT count(*)::int FROM message_posts p WHERE p.thread_id = t.id) AS post_count,
            lp.body AS last_body
       FROM message_threads t
       JOIN users ru ON ru.id = t.recipient_id
       JOIN LATERAL (SELECT body FROM message_posts WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) lp ON true
      WHERE t.broadcast_id = $1
      ORDER BY t.last_post_at DESC`, [broadcastId])).rows;
  return { broadcast: { id: b.id, subject: b.subject, preview: preview(b.body), created_at: b.created_at,
    recipient_count: b.recipient_count },
    threads: threads.map(t => ({ id: t.id, recipient_id: t.recipient_id, recipient_name: t.recipient_name,
      recipient_username: t.recipient_username, last_post_at: t.last_post_at, created_at: t.created_at,
      unread: t.unread, post_count: t.post_count, preview: preview(t.last_body) })) };
}

// Unread counts for the nav badge: inbox threads with a message the recipient has not read; for 'msg' users also
// the sent threads with an unread reply. hasMsg: whether the caller holds 'msg' (sent side only counts then).
export async function unreadCount(userId, hasMsg) {
  const inboxN = (await query(
    `SELECT count(*)::int AS n FROM message_threads
      WHERE recipient_id = $1 AND kind = 'message' AND (recipient_read_at IS NULL OR recipient_read_at < last_post_at)`, [userId])).rows[0].n;
  let sentN = 0;
  if (hasMsg) {
    sentN = (await query(
      `SELECT count(*)::int AS n FROM message_threads
        WHERE author_id = $1 AND (author_read_at IS NULL OR author_read_at < last_post_at)`, [userId])).rows[0].n;
  }
  // pending mandatory alerts for this user (1.12.29): unresponded alert threads addressed to them
  const pendingAlerts = (await query(
    `SELECT count(*)::int AS n FROM message_threads
      WHERE recipient_id = $1 AND kind = 'alert' AND response_status IS NULL`, [userId])).rows[0].n;
  return { inbox: inboxN, replies: sentN, pending_alerts: pendingAlerts, total: inboxN + sentN + pendingAlerts };
}
