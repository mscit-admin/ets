// Live updates (GET /api/events, Server-Sent Events) — needs TEST_DATABASE_URL like api.test.js.
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';

let server, base, pool, live;

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    LOGIN_RATE_LIMIT: '1000', LOGIN_IP_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
    LIVE_HEARTBEAT_SECONDS: '1', LIVE_MAX_STREAMS_PER_USER: '2',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword('Passw0rd-123');
  await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password) VALUES
    ('root','Root Admin',$1,'admin',false), ('hred','HR Editor',$1,'ed',false), ('capper','Cap',$1,'obs',false)`, [h]);
  await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) SELECT id,'department','hr' FROM users WHERE username IN ('hred','capper')`);
  live = await import('../src/services/live.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
  if (skip) return;
  await live.closeAllStreams();
  server.closeAllConnections?.();
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    get cookie() { return cookie; },
    get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: (u, pw = 'Passw0rd-123') => call('POST', '/auth/login', { username: u, password: pw }),
  };
}

// Opens /api/events and collects the parsed events; next(type) waits for the next event of that type.
async function stream(c) {
  const ac = new AbortController();
  const res = await fetch(base + '/events', { headers: { cookie: c.cookie, accept: 'text/event-stream' }, signal: ac.signal });
  const s = { status: res.status, headers: res.headers, events: [], raw: '', ended: false, waiters: [] };
  if (res.status !== 200) { s.body = await res.json().catch(() => null); return s; }
  const wake = () => { for (const w of s.waiters.splice(0)) w(); };
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        const text = dec.decode(chunk, { stream: true });
        s.raw += text; buf += text;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (ev) s.events.push({ event: ev, data: JSON.parse(data), raw: block });
        }
        wake();
      }
    } catch { /* aborted */ }
    s.ended = true; wake();
  })();
  s.close = () => ac.abort();
  s.next = async (event, ms = 4000, from = 0) => {
    const t0 = Date.now();
    for (;;) {
      const e = s.events.slice(from).find(x => x.event === event);
      if (e) return e;
      if (s.ended || Date.now() - t0 > ms) return null;
      await new Promise(r => { s.waiters.push(r); setTimeout(r, 100); });
    }
  };
  s.waitEnd = async (ms = 5000) => {
    const t0 = Date.now();
    while (!s.ended && Date.now() - t0 < ms) await new Promise(r => { s.waiters.push(r); setTimeout(r, 100); });
    return s.ended;
  };
  return s;
}

const fnOf = async app => (await pool.query(`SELECT id, progress FROM functions WHERE app_id=$1 AND enabled AND removed_at IS NULL ORDER BY id LIMIT 1`, [app])).rows[0];

test('/api/events requires a signed-in session', { skip }, async () => {
  const r = await fetch(base + '/events');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'not_authenticated');
});

test('a function % update sends tracker_changed after commit, with ids only and no values', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('root')).status, 200);
  const s = await stream(c);
  assert.equal(s.status, 200);
  assert.match(s.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(s.headers.get('x-accel-buffering'), 'no');
  assert.ok(await s.next('ready'));
  const f = await fnOf('per');
  const value = f.progress === 63.5 ? 41.5 : 63.5;
  const t0 = Date.now();
  assert.equal((await c.patch('/tracker/functions/' + f.id, { progress: value })).status, 200);
  const e = await s.next('tracker_changed');
  assert.ok(e, 'tracker_changed received');
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(e.data, { type: 'tracker_changed', dept_id: 'hr', app_id: 'per' });
  // nothing but the change hint: no percentages, no function id, no value
  assert.ok(!/63\.5|41\.5/.test(e.raw) && !e.raw.includes(String(f.id)));
  // the data was committed when the event arrived: a reload sees it
  const after = await c.get('/tracker/applications/per');
  assert.equal(after.data.functions.find(x => x.id === f.id).progress, value);
  s.close();
});

test('a type change (function / report, 1.8.0) sends tracker_changed after commit — single and bulk', { skip }, async () => {
  const c = client();
  assert.equal((await c.login('root')).status, 200);
  const s = await stream(c);
  assert.ok(await s.next('ready'));
  const f = await fnOf('rec');
  const n0 = s.events.length;
  assert.equal((await c.patch('/tracker/functions/' + f.id, { item_type: 'report' })).status, 200);
  const e = await s.next('tracker_changed', 4000, n0);
  assert.deepEqual(e?.data, { type: 'tracker_changed', dept_id: 'hr', app_id: 'rec' });
  assert.ok(!e.raw.includes(String(f.id)) && !/"item_type"|"report"/.test(e.raw));     // ids only, no values
  assert.equal((await c.get('/tracker/applications/rec')).data.functions.find(x => x.id === f.id).item_type, 'report');
  const n1 = s.events.length;
  assert.equal((await c.post('/tracker/applications/rec/bulk', { field: 'item_type', value: 'function', function_ids: [f.id] })).data.updated, 1);
  const e2 = await s.next('tracker_changed', 4000, n1);
  assert.deepEqual(e2?.data, { type: 'tracker_changed', dept_id: 'hr', app_id: 'rec' });
  assert.equal((await c.get('/tracker/applications/rec')).data.functions.find(x => x.id === f.id).item_type, 'function');
  s.close();
});

test('a scoped user only hears about changes in their scope', { skip }, async () => {
  const root = client(), hr = client();
  await root.login('root'); await hr.login('hred');
  const s = await stream(hr);
  assert.ok(await s.next('ready'));
  const fin = await fnOf('acc');
  await root.patch('/tracker/functions/' + fin.id, { progress: fin.progress === 12 ? 13 : 12 });
  const hrf = await fnOf('lev');
  await root.patch('/tracker/functions/' + hrf.id, { progress: hrf.progress === 22 ? 23 : 22 });
  const e = await s.next('tracker_changed');
  assert.ok(e);
  assert.equal(e.data.app_id, 'lev');
  assert.equal(s.events.filter(x => x.event === 'tracker_changed' && x.data.dept_id === 'fin').length, 0);
  // project-wide change (settings): everyone
  const n = s.events.length;
  const cur = (await root.get('/settings')).data.settings['calc.notif_share'];
  await fetch(base + '/settings', { method: 'PUT', headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie: root.cookie },
    body: JSON.stringify({ 'calc.notif_share': cur === 0.1 ? 0.15 : 0.1 }) });
  const g = await s.next('tracker_changed', 4000, n);
  assert.ok(g);
  assert.deepEqual(g.data, { type: 'tracker_changed' });
  s.close();
});

test('sign-out closes the stream at once', { skip }, async () => {
  const c = client();
  await c.login('root');
  const s = await stream(c);
  assert.ok(await s.next('ready'));
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.ok(await s.next('session_ended', 3000), 'session_ended event');
  assert.ok(await s.waitEnd(3000), 'stream closed');
});

test('an expired session closes the stream at the next heartbeat, and the stream is no activity', { skip }, async () => {
  const c = client();
  await c.login('root');
  const sid = (await pool.query(`SELECT id, last_seen_at FROM sessions WHERE revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`)).rows[0];
  await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE id=$1`, [sid.id]);
  const s = await stream(c);
  assert.ok(await s.next('ready'));
  await new Promise(r => setTimeout(r, 1300));                 // a heartbeat
  assert.ok(s.raw.includes(': hb'), 'heartbeat comment');
  assert.equal(s.ended, false);
  const seen = (await pool.query('SELECT last_seen_at FROM sessions WHERE id=$1', [sid.id])).rows[0].last_seen_at;
  assert.ok(Date.now() - new Date(seen).getTime() > 4 * 60_000, 'opening the stream does not count as activity');
  await pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id=$1`, [sid.id]);
  assert.ok(await s.next('session_ended', 3000), 'session_ended event');
  assert.ok(await s.waitEnd(3000), 'stream closed');
});

test('streams per user are capped; the stream open is logged once, not each heartbeat', { skip }, async () => {
  const c = client();
  await c.login('capper');
  const a = await stream(c), b = await stream(c);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const third = await stream(c);
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'too_many_streams');
  a.close();
  await new Promise(r => setTimeout(r, 300));
  const d = await stream(c);
  assert.equal(d.status, 200);
  await new Promise(r => setTimeout(r, 1300));
  const uid = (await pool.query(`SELECT id FROM users WHERE username='capper'`)).rows[0].id;
  const rows = (await pool.query(`SELECT status FROM access_log WHERE user_id=$1 AND path='/api/events'`, [uid])).rows;
  assert.deepEqual(rows.map(x => x.status).sort(), [200, 200, 200, 429]);
  b.close(); d.close();
});
