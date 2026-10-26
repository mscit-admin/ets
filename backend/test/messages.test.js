// In-app messaging (1.12.26) — against a dedicated, disposable PostgreSQL database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// Covers: the 'msg' permission (send gate + scope-limited audience), the private 1:1 thread model with no
// cross-recipient leakage, replies and the two directed notifications, read state, unread counts, validation and
// the audit row. The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool;
const id = {};

async function mkUser(username, role, { depts = [], apps = [], perms = [] } = {}) {
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  const u = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
    VALUES ($1,$2,$3,$4,false) RETURNING id`, [username, username + ' name', h, role])).rows[0].id;
  for (const d of depts) await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department',$2)`, [u, d]);
  for (const a of apps) await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'application',$2)`, [u, a]);
  for (const [p, g] of perms) await pool.query(`INSERT INTO user_permissions(user_id,permission,granted) VALUES ($1,$2,$3)`, [u, p, g]);
  id[username] = u;
  return u;
}

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  // admin (full scope, has msg from the seed); an HR lead granted msg; HR members; an observer in HR (no msg);
  // a QA in FIN (another department → out of an HR-scoped sender's reach)
  await mkUser('root', 'admin');
  await mkUser('hrlead', 'lead', { depts: ['hr'], perms: [['msg', true]] });
  await mkUser('hra', 'member', { depts: ['hr'] });
  await mkUser('hrb', 'member', { depts: ['hr'] });
  await mkUser('hrobs', 'obs', { depts: ['hr'] });
  await mkUser('finqa', 'qa', { depts: ['fin'] });
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}
const as = async u => { const c = client(); await c.login(u); return c; };
const notifTypes = uid => pool.query(
  `SELECT type, link, params FROM notifications WHERE user_id=$1 ORDER BY id`, [uid]).then(r => r.rows);

test('seed & migration 026: msg is granted to admin only', { skip }, async () => {
  const roles = (await pool.query(`SELECT id FROM roles WHERE 'msg' = ANY(permissions) ORDER BY id`)).rows.map(r => r.id);
  assert.deepEqual(roles, ['admin']);
  // a new capability: no per-user override is created by the migration itself (only our explicit test grant exists)
  const ov = (await pool.query(`SELECT u.username FROM user_permissions p JOIN users u ON u.id=p.user_id WHERE p.permission='msg'`)).rows;
  assert.deepEqual(ov.map(x => x.username), ['hrlead']);
});

test('a user without msg cannot send (403)', { skip }, async () => {
  const c = await as('hra');
  const r = await c.post('/messages', { body: 'hello', audience: { users: [id.hrb] } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'forbidden');
  assert.equal(r.data.permission, 'msg');
});

test('send to individuals: one private thread + initial post per recipient; recipients notified', { skip }, async () => {
  const c = await as('hrlead');
  const r = await c.post('/messages', { subject: 'Hi team', body: 'Please update your tasks', audience: { users: [id.hra, id.hrb] } });
  assert.equal(r.status, 201);
  assert.equal(r.data.sent, 2);
  const bid = r.data.broadcast_id;
  // one thread per recipient, each with exactly the initial post
  const th = (await pool.query(`SELECT recipient_id FROM message_threads WHERE broadcast_id=$1 ORDER BY recipient_id`, [bid])).rows.map(x => x.recipient_id);
  assert.deepEqual(th.sort((a, b) => a - b), [id.hra, id.hrb].sort((a, b) => a - b));
  const posts = (await pool.query(`SELECT count(*)::int n FROM message_posts p JOIN message_threads t ON t.id=p.thread_id WHERE t.broadcast_id=$1`, [bid])).rows[0].n;
  assert.equal(posts, 2);
  // both recipients got a message_received alert; the sender got none
  for (const u of ['hra', 'hrb']) {
    const n = await notifTypes(id[u]);
    assert.ok(n.some(x => x.type === 'message_received'), u + ' received alert');
  }
  assert.equal((await notifTypes(id.hrlead)).length, 0);
  // audit row for the send
  const a = (await pool.query(`SELECT action, entity, new_value FROM audit_log WHERE action='message_send' AND entity_id=$1`, [String(bid)])).rows[0];
  assert.ok(a, 'audit row');
  assert.equal(a.new_value.recipient_count, 2);
});

test('scope limiting: an HR-scoped sender cannot reach a FIN user, even by id or "all"', { skip }, async () => {
  const c = await as('hrlead');
  // explicit out-of-scope id is dropped
  const byId = await c.post('/messages/resolve', { audience: { users: [id.finqa, id.hra] } });
  assert.equal(byId.data.count, 1);
  assert.ok(!byId.data.recipients.some(x => x.id === id.finqa));
  // "all" for the HR lead resolves only to HR users + full-scope (root), never finqa
  const all = await c.post('/messages/resolve', { audience: { all: true } });
  const ids = all.data.recipients.map(x => x.id);
  assert.ok(!ids.includes(id.finqa), 'finqa excluded');
  assert.ok(ids.includes(id.hra) && ids.includes(id.hrb) && ids.includes(id.hrobs), 'HR users included');
  assert.ok(ids.includes(id.root), 'full-scope root reachable');
  assert.ok(!ids.includes(id.hrlead), 'sender excluded');
});

test('send by department and by role resolves the right scope-limited set', { skip }, async () => {
  const c = await as('root');            // full scope: reaches everyone
  const byDept = await c.post('/messages/resolve', { audience: { depts: ['fin'] } });
  assert.deepEqual(byDept.data.recipients.map(x => x.id).sort((a, b) => a - b), [id.finqa]);
  const byRole = await c.post('/messages/resolve', { audience: { roles: ['member'] } });
  assert.deepEqual(byRole.data.recipients.map(x => x.id).sort((a, b) => a - b), [id.hra, id.hrb].sort((a, b) => a - b));
});

test('private 1:1: a recipient sees only their own thread, not another recipient\'s', { skip }, async () => {
  const lead = await as('hrlead');
  const sendR = await lead.post('/messages', { subject: 'Sprint', body: 'kickoff', audience: { users: [id.hra, id.hrb] } });
  const bid = sendR.data.broadcast_id;
  const threads = (await pool.query(`SELECT id, recipient_id FROM message_threads WHERE broadcast_id=$1`, [bid])).rows;
  const hraThread = threads.find(t => t.recipient_id === id.hra).id;
  const hrbThread = threads.find(t => t.recipient_id === id.hrb).id;
  const hra = await as('hra');
  // hra sees their own inbox thread but not hrb's thread
  const inbox = await hra.get('/messages/inbox');
  assert.ok(inbox.data.threads.some(t => t.id === hraThread));
  assert.ok(!inbox.data.threads.some(t => t.id === hrbThread));
  // opening another recipient's thread → 403
  assert.equal((await hra.get('/messages/threads/' + hrbThread)).status, 403);
  // opening own thread works
  const own = await hra.get('/messages/threads/' + hraThread);
  assert.equal(own.status, 200);
  assert.equal(own.data.thread.side, 'recipient');
  assert.equal(own.data.posts.length, 1);
});

test('reply round-trip notifies the other party; read state and unread counts', { skip }, async () => {
  const lead = await as('hrlead');
  const sendR = await lead.post('/messages', { subject: 'Q', body: 'question?', audience: { users: [id.hra] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [sendR.data.broadcast_id])).rows[0].id;
  const beforeLead = await notifTypes(id.hrlead);

  // recipient replies → sender notified (message_reply)
  const hra = await as('hra');
  await hra.get('/messages/threads/' + tid);          // marks recipient side read
  const rep = await hra.post('/messages/threads/' + tid + '/reply', { body: 'my answer' });
  assert.equal(rep.status, 201);
  const leadNotif = await notifTypes(id.hrlead);
  assert.ok(leadNotif.length > beforeLead.length && leadNotif.at(-1).type === 'message_reply', 'sender got a reply alert');

  // the sender now has an unread reply on the sent side
  const uc = await lead.get('/messages/unread-count');
  assert.ok(uc.data.replies >= 1, 'sender unread replies');

  // sender replies → recipient notified (message_reply)
  const beforeHra = (await notifTypes(id.hra)).length;
  await lead.get('/messages/threads/' + tid);         // sender reads (clears the unread reply)
  const rep2 = await lead.post('/messages/threads/' + tid + '/reply', { body: 'thanks' });
  assert.equal(rep2.status, 201);
  const hraNotif = await notifTypes(id.hra);
  assert.ok(hraNotif.length > beforeHra && hraNotif.at(-1).type === 'message_reply', 'recipient got a reply alert');

  // recipient now has an unread inbox thread
  const uc2 = await hra.get('/messages/unread-count');
  assert.ok(uc2.data.inbox >= 1, 'recipient unread inbox');
  // thread has 3 posts total (initial + two replies)
  const own = await hra.get('/messages/threads/' + tid);
  assert.equal(own.data.posts.length, 3);
});

test('a non-party (even another msg sender) gets 403 on a thread', { skip }, async () => {
  const lead = await as('hrlead');
  const sendR = await lead.post('/messages', { body: 'private', audience: { users: [id.hra] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [sendR.data.broadcast_id])).rows[0].id;
  const root = await as('root');                       // admin, but not a party to this thread
  assert.equal((await root.get('/messages/threads/' + tid)).status, 403);
  assert.equal((await root.post('/messages/threads/' + tid + '/reply', { body: 'x' })).status, 403);
});

test('a user without msg can still receive and reply', { skip }, async () => {
  const root = await as('root');
  const sendR = await root.post('/messages', { body: 'notice for observer', audience: { users: [id.hrobs] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [sendR.data.broadcast_id])).rows[0].id;
  const obs = await as('hrobs');
  // no msg: cannot send or view sent
  assert.equal((await obs.post('/messages', { body: 'x', audience: { users: [id.root] } })).status, 403);
  assert.equal((await obs.get('/messages/sent')).status, 403);
  // but can read the received thread and reply
  const open = await obs.get('/messages/threads/' + tid);
  assert.equal(open.status, 200);
  const rep = await obs.post('/messages/threads/' + tid + '/reply', { body: 'got it' });
  assert.equal(rep.status, 201);
  // the reply notified the sender (root)
  assert.ok((await notifTypes(id.root)).some(x => x.type === 'message_reply'));
});

test('validation: empty body, empty audience, too-long body', { skip }, async () => {
  const c = await as('hrlead');
  assert.equal((await c.post('/messages', { body: '', audience: { users: [id.hra] } })).data.error, 'invalid_value');
  assert.equal((await c.post('/messages', { body: 'hi', audience: {} })).data.error, 'invalid_value');
  // no recipients resolved (all out of scope) → no_recipients
  assert.equal((await c.post('/messages', { body: 'hi', audience: { users: [id.finqa] } })).data.error, 'no_recipients');
  // 4001 chars is trimmed to 4000 and accepted (not rejected)
  const long = 'x'.repeat(4001);
  const r = await c.post('/messages', { body: long, audience: { users: [id.hra] } });
  assert.equal(r.status, 201);
  const b = (await pool.query(`SELECT char_length(body) n FROM message_broadcasts WHERE id=$1`, [r.data.broadcast_id])).rows[0].n;
  assert.equal(b, 4000);
});
