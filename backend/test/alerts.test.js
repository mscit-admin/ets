// Alert messages (1.12.29) — against a dedicated, disposable PostgreSQL database:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// Covers migration 028 (kind + response columns), sending an alert (alert-kind broadcast + threads + alert_received
// notification), the mandatory-popup source /pending-alert, responding (ack/working + optional note + responded_at +
// alert_response to the sender), the second-response and non-recipient guards, bad status, the sender's /alerts/sent
// tree with status counts, the msg gate, and that the private 1:1 model is preserved. Skipped when the variable is
// unset. The public schema is DROPPED and recreated.
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
    LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
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
// A fresh HR member (reachable by hrlead), so each test's /pending-alert ordering is independent of other tests.
let rc = 0;
const freshRecipient = () => mkUser('rcp' + (++rc), 'member', { depts: ['hr'] });

test('migration 028: kind + response columns exist', { skip }, async () => {
  const cols = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='message_threads'
       AND column_name IN ('kind','response_status','response_note','responded_at') ORDER BY column_name`)).rows.map(r => r.column_name);
  assert.deepEqual(cols, ['kind', 'responded_at', 'response_note', 'response_status']);
  const bk = (await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='message_broadcasts' AND column_name='kind'`)).rowCount;
  assert.equal(bk, 1);
});

test('sending an alert creates an alert-kind broadcast + threads; recipients get a pending alert + alert_received', { skip }, async () => {
  const a1 = await freshRecipient(), a2 = await freshRecipient();
  const c = await as('hrlead');
  const r = await c.post('/messages', { kind: 'alert', subject: 'System freeze', body: 'Stop all edits now', audience: { users: [a1, a2] } });
  assert.equal(r.status, 201);
  assert.equal(r.data.sent, 2);
  assert.equal(r.data.kind, 'alert');
  const bid = r.data.broadcast_id;
  const b = (await pool.query(`SELECT kind FROM message_broadcasts WHERE id=$1`, [bid])).rows[0];
  assert.equal(b.kind, 'alert');
  const th = (await pool.query(`SELECT kind, response_status FROM message_threads WHERE broadcast_id=$1`, [bid])).rows;
  assert.equal(th.length, 2);
  assert.ok(th.every(t => t.kind === 'alert' && t.response_status === null));
  for (const u of [a1, a2]) assert.ok((await notifTypes(u)).some(x => x.type === 'alert_received'), 'alert_received');
  // audited as alert_send with kind
  const a = (await pool.query(`SELECT new_value FROM audit_log WHERE action='alert_send' AND entity_id=$1`, [String(bid)])).rows[0];
  assert.ok(a, 'alert_send audit');
  assert.equal(a.new_value.kind, 'alert');
});

test('/pending-alert returns the next unresponded alert; /respond sets status+note+responded_at and notifies the sender', { skip }, async () => {
  const u = await freshRecipient();
  const uname = 'rcp' + rc;
  const lead = await as('hrlead');
  const r = await lead.post('/messages', { kind: 'alert', subject: 'Deploy', body: 'Acknowledge the deploy', audience: { users: [u] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [r.data.broadcast_id])).rows[0].id;
  const rec = await as(uname);
  const pa = await rec.get('/messages/pending-alert');
  assert.ok(pa.data.alert, 'a pending alert is returned');
  assert.equal(Number(pa.data.alert.thread_id), Number(tid));
  assert.equal(pa.data.alert.body, 'Acknowledge the deploy');
  assert.equal(pa.data.alert.subject, 'Deploy');
  // respond with "working" + a note
  const before = (await notifTypes(id.hrlead)).length;
  const resp = await rec.post('/messages/threads/' + tid + '/respond', { status: 'working', note: 'on it now' });
  assert.equal(resp.status, 201);
  assert.equal(resp.data.status, 'working');
  const row = (await pool.query(`SELECT response_status, response_note, responded_at FROM message_threads WHERE id=$1`, [tid])).rows[0];
  assert.equal(row.response_status, 'working');
  assert.equal(row.response_note, 'on it now');
  assert.ok(row.responded_at, 'responded_at set');
  // the note became a post (the initial alert post + the note)
  const posts = (await pool.query(`SELECT count(*)::int n FROM message_posts WHERE thread_id=$1`, [tid])).rows[0].n;
  assert.equal(posts, 2);
  // the sender got an alert_response alert
  const after = await notifTypes(id.hrlead);
  assert.ok(after.length > before && after.at(-1).type === 'alert_response', 'sender alert_response');
  assert.equal(after.at(-1).params.status, 'working');
});

test('after responding, /pending-alert returns null and a second /respond is rejected', { skip }, async () => {
  const u = await freshRecipient();
  const uname = 'rcp' + rc;
  const lead = await as('hrlead');
  const r = await lead.post('/messages', { kind: 'alert', body: 'Please ack', audience: { users: [u] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [r.data.broadcast_id])).rows[0].id;
  const rec = await as(uname);
  assert.ok((await rec.get('/messages/pending-alert')).data.alert, 'pending before');
  assert.equal((await rec.post('/messages/threads/' + tid + '/respond', { status: 'ack' })).status, 201);
  assert.equal((await rec.get('/messages/pending-alert')).data.alert, null, 'none pending after');
  const second = await rec.post('/messages/threads/' + tid + '/respond', { status: 'working' });
  assert.equal(second.status, 400);
  assert.equal(second.data.error, 'already_responded');
});

test('a non-recipient cannot respond (403); a bad status is rejected (400); a plain message is not an alert', { skip }, async () => {
  const u = await freshRecipient();
  const uname = 'rcp' + rc;
  const lead = await as('hrlead');
  const r = await lead.post('/messages', { kind: 'alert', body: 'ack me', audience: { users: [u] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [r.data.broadcast_id])).rows[0].id;
  // the sender (author) is not the recipient → 403
  assert.equal((await lead.post('/messages/threads/' + tid + '/respond', { status: 'ack' })).status, 403);
  // an unrelated admin → 403
  const root = await as('root');
  assert.equal((await root.post('/messages/threads/' + tid + '/respond', { status: 'ack' })).status, 403);
  // the recipient with a bad status → 400 bad_status
  const rec = await as(uname);
  const bad = await rec.post('/messages/threads/' + tid + '/respond', { status: 'maybe' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'bad_status');
  // a plain message thread cannot be responded to
  const msg = await lead.post('/messages', { body: 'just a message', audience: { users: [u] } });
  const mtid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1`, [msg.data.broadcast_id])).rows[0].id;
  const notAlert = await rec.post('/messages/threads/' + mtid + '/respond', { status: 'ack' });
  assert.equal(notAlert.status, 400);
  assert.equal(notAlert.data.error, 'not_alert');
});

test('the sender /alerts/sent/:id shows each recipient status + counts; no cross-recipient leakage', { skip }, async () => {
  const a1 = await freshRecipient(), a1name = 'rcp' + rc;
  const a2 = await freshRecipient();
  const lead = await as('hrlead');
  const r = await lead.post('/messages', { kind: 'alert', subject: 'Count me', body: 'respond please', audience: { users: [a1, a2] } });
  const bid = r.data.broadcast_id;
  const threads = (await pool.query(`SELECT id, recipient_id FROM message_threads WHERE broadcast_id=$1`, [bid])).rows;
  const aT = threads.find(t => t.recipient_id === a1).id;
  const bT = threads.find(t => t.recipient_id === a2).id;
  // a1 acknowledges, a2 does not respond
  const rec = await as(a1name);
  await rec.post('/messages/threads/' + aT + '/respond', { status: 'ack', note: 'done' });
  const tree = await lead.get('/messages/alerts/sent/' + bid);
  assert.equal(tree.status, 200);
  assert.equal(tree.data.counts.ack, 1);
  assert.equal(tree.data.counts.pending, 1);
  assert.equal(tree.data.counts.working, 0);
  const aBranch = tree.data.threads.find(t => t.id === aT);
  const bBranch = tree.data.threads.find(t => t.id === bT);
  assert.equal(aBranch.response_status, 'ack');
  assert.equal(aBranch.response_note, 'done');
  assert.equal(bBranch.response_status, null);
  // private 1:1: a1 cannot see a2's alert thread
  assert.equal((await rec.get('/messages/threads/' + bT)).status, 403);
  // a1's received alerts list shows only their own with their response
  const mine = await rec.get('/messages/alerts/mine');
  assert.ok(mine.data.alerts.some(a => a.id === aT && a.response_status === 'ack'));
  assert.ok(!mine.data.alerts.some(a => a.id === bT));
});

test('unread-count reports pending_alerts; a user without msg cannot send an alert but can receive and respond', { skip }, async () => {
  const root = await as('root');
  // send an alert to the observer (no msg)
  const r = await root.post('/messages', { kind: 'alert', body: 'observer, acknowledge', audience: { users: [id.hrobs] } });
  const tid = (await pool.query(`SELECT id FROM message_threads WHERE broadcast_id=$1 AND recipient_id=$2`, [r.data.broadcast_id, id.hrobs])).rows[0].id;
  const obs = await as('hrobs');
  // cannot send an alert (no msg)
  assert.equal((await obs.post('/messages', { kind: 'alert', body: 'x', audience: { users: [id.root] } })).status, 403);
  // unread-count exposes a pending alert
  const uc = await obs.get('/messages/unread-count');
  assert.ok(uc.data.pending_alerts >= 1, 'pending_alerts counted');
  // but can see the pending alert and respond (drain all pending for a clean assertion)
  let pa = await obs.get('/messages/pending-alert');
  assert.ok(pa.data.alert);
  while (pa.data.alert) {
    assert.equal((await obs.post('/messages/threads/' + pa.data.alert.thread_id + '/respond', { status: 'ack' })).status, 201);
    pa = await obs.get('/messages/pending-alert');
  }
  assert.equal((await obs.get('/messages/unread-count')).data.pending_alerts, 0);
  // the specific alert thread is responded
  assert.equal((await pool.query(`SELECT response_status FROM message_threads WHERE id=$1`, [tid])).rows[0].response_status, 'ack');
});
