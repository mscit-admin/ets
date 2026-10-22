// Filters of the Approvals screen (1.12.1): GET /approvals?dept=&app=&kind=&field=&requester=&decided_by=&from=&to=&q=
// &awaiting=1, the choices of GET /approvals/facets, «approve all shown» (approve-all with the listed ids) and the Excel
// export with the same filters. Every filter only narrows what the reader may already see: a lead of one department
// never reaches another department's requests through them, and the choices list only what the reader may see.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
// The public schema of that database is DROPPED and recreated. Skipped when the variable is unset.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Passw0rd-123';

let server, base, pool, live;
const ids = {};
const rq = {};

// [username, role, scopes ([kind, ref])]
const USERS = [
  ['root', 'admin'],
  ['lead_hr', 'lead', [['department', 'hr']]],
  ['lead_fin', 'lead', [['department', 'fin']]],
  ['mgr_both', 'mgr', [['department', 'hr'], ['department', 'fin']]],      // 'mov' without 'apv_dept': a move is a request
  ['member_hr', 'member', [['department', 'hr']]],
  ['member_hr2', 'member', [['department', 'hr']]],
  ['member_fin', 'member', [['department', 'fin']]],
];

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'x-requested-with': 'ets', 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : type.includes('spreadsheetml') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data };
  };
  return { get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b),
    login: u => call('POST', '/auth/login', { username: u, password: PW }) };
}
const as = async u => { const c = client(); const r = await c.login(u); assert.equal(r.data.stage, 'done', u); return c; };
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const fn = (app, code) => one('SELECT * FROM functions WHERE app_id=$1 AND code=$2', [app, code]);
// the ids of the requests a user sees with these filters
const seen = async (c, q) => {
  const r = await c.get('/approvals' + q);
  assert.equal(r.status, 200, q + ' ' + JSON.stringify(r.data));
  return r.data.requests.map(x => x.id).sort((a, b) => a - b);
};
const sorted = a => [...a].sort((x, y) => x - y);

before(async () => {
  if (skip) return;
  Object.assign(process.env, {
    DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
    LOG_DIR: new URL('../logs-test', import.meta.url).pathname, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4',
    MAX_FAILED_LOGINS: '50', LOGIN_RATE_LIMIT: '1000', API_RATE_LIMIT: '100000', ETS_ENV_FILE: 'none',
  });
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  const { hashPassword } = await import('../src/services/passwords.js');
  const h = await hashPassword(PW);
  for (const [u, role, scopes = []] of USERS) {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$2,$3,$4,false) RETURNING id`, [u, 'Full ' + u, h, role])).rows[0].id;
    ids[u] = id;
    for (const [k, r] of scopes) await pool.query('INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,$2,$3)', [id, k, r]);
  }
  live = await import('../src/services/live.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}/api`;

  // the requests: hr (ess progress, per test status — then rejected, ess progress by a second member), fin (acc
  // progress), and a move from per (hr) to acc (fin)
  const mh = await as('member_hr'), mh2 = await as('member_hr2'), mf = await as('member_fin'), mgr = await as('mgr_both');
  const req = async (c, path, body) => {
    const r = await (body.to_app_id ? c.post(path, body) : c.patch(path, body));
    assert.equal(r.status, 202, path + ' ' + JSON.stringify(r.data));
    return r.data.request_id;
  };
  const f1 = await fn('ess', 'D1'), f2 = await fn('per', 'D1'), f3 = await fn('acc', 'D1'), f4 = await fn('ess', 'D2'), f5 = await fn('per', 'D3');
  rq.essProgress = await req(mh, '/tracker/functions/' + f1.id, { progress: f1.progress === 30 ? 31 : 30 });
  rq.perTest = await req(mh2, '/tracker/functions/' + f2.id, { test_status: f2.test_status === 3 ? 0 : 3 });
  rq.accProgress = await req(mf, '/tracker/functions/' + f3.id, { progress: f3.progress === 30 ? 31 : 30 });
  rq.essProgress2 = await req(mh2, '/tracker/functions/' + f4.id, { progress: f4.progress === 45 ? 46 : 45 });
  rq.move = await req(mgr, `/tracker/functions/${f5.id}/move`, { to_app_id: 'acc', reason: 'Belongs to the accounts module' });
  assert.equal((await (await as('lead_hr')).post(`/approvals/${rq.perTest}/reject`, { reason: 'not yet' })).status, 200);
});

after(async () => {
  if (skip) return;
  await live.closeAllStreams();
  server.closeAllConnections?.();
  server.close();
  await new Promise(r => setTimeout(r, 200));
  await pool.end();
});

test('filters: department, application, requester, kind and changed field narrow the list', { skip }, async () => {
  const root = await as('root');
  const all = await seen(root, '?status=');
  assert.deepEqual(all, sorted(Object.values(rq)));
  assert.deepEqual(await seen(root, '?status=&dept=fin'), sorted([rq.accProgress, rq.move]));        // a move: both departments
  assert.deepEqual(await seen(root, '?status=&dept=hr'), sorted([rq.essProgress, rq.perTest, rq.essProgress2, rq.move]));
  assert.deepEqual(await seen(root, '?status=&app=acc'), sorted([rq.accProgress, rq.move]));          // ... and both applications
  assert.deepEqual(await seen(root, '?status=&app=ess'), sorted([rq.essProgress, rq.essProgress2]));
  assert.deepEqual(await seen(root, `?status=&requester=${ids.member_hr2}`), sorted([rq.perTest, rq.essProgress2]));
  assert.deepEqual(await seen(root, '?status=&kind=move_function'), [rq.move]);
  assert.deepEqual(await seen(root, '?status=&kind=function&dept=hr'), sorted([rq.essProgress, rq.perTest, rq.essProgress2]));
  assert.deepEqual(await seen(root, '?status=&field=test_status'), [rq.perTest]);
  assert.deepEqual(await seen(root, '?status=&field=move'), [rq.move]);
  assert.deepEqual(await seen(root, '?status=&field=progress&app=ess&requester=' + ids.member_hr), [rq.essProgress]);
  // with the status (pending by default on the screen)
  assert.deepEqual(await seen(root, '?status=pending&dept=hr'), sorted([rq.essProgress, rq.essProgress2, rq.move]));
  assert.deepEqual(await seen(root, '?status=rejected'), [rq.perTest]);
});

test('filters: decided by, dates and free text', { skip }, async () => {
  const root = await as('root');
  assert.deepEqual(await seen(root, `?status=&decided_by=${ids.lead_hr}`), [rq.perTest]);
  assert.deepEqual(await seen(root, `?status=&decided_by=${ids.lead_fin}`), []);
  const today = (await one(`SELECT to_char(now()::date, 'YYYY-MM-DD') AS d`)).d;
  const tomorrow = (await one(`SELECT to_char(now()::date + 1, 'YYYY-MM-DD') AS d`)).d;
  const yesterday = (await one(`SELECT to_char(now()::date - 1, 'YYYY-MM-DD') AS d`)).d;
  assert.equal((await seen(root, `?status=&from=${today}&to=${today}`)).length, 5);
  assert.deepEqual(await seen(root, `?status=&from=${tomorrow}`), []);
  assert.deepEqual(await seen(root, `?status=&to=${yesterday}`), []);
  // a request number (with or without «#»), a requester, an application, a function code / name
  // (a bare number also matches text such as an item code «D3»; «#n» is that request only)
  assert.ok((await seen(root, `?status=&q=${rq.accProgress}`)).includes(rq.accProgress));
  assert.deepEqual(await seen(root, `?status=&q=${encodeURIComponent('#' + rq.accProgress)}`), [rq.accProgress]);
  assert.deepEqual(await seen(root, `?status=&q=${encodeURIComponent('#' + rq.move)}`), [rq.move]);
  assert.deepEqual(await seen(root, '?status=&q=member_fin'), [rq.accProgress]);
  assert.deepEqual(await seen(root, '?status=&q=' + encodeURIComponent('full MEMBER_HR2')), sorted([rq.perTest, rq.essProgress2]));
  const acc = await one(`SELECT name_en FROM applications WHERE id='acc'`);
  assert.deepEqual(await seen(root, '?status=&q=' + encodeURIComponent(acc.name_en)), sorted([rq.accProgress, rq.move]));
  const f = await fn('per', 'D1');
  assert.ok((await seen(root, '?status=&q=' + encodeURIComponent(f.name_ar))).includes(rq.perTest));
  // LIKE wildcards are plain text
  assert.deepEqual(await seen(root, '?status=&q=%25'), []);
  assert.deepEqual(await seen(root, '?status=&q=mgr%25both'), []);
  assert.deepEqual(await seen(root, '?status=&q=mgr_both'), [rq.move]);
});

test('filters: refused values are 400 before any query', { skip }, async () => {
  const root = await as('root');
  for (const [q, field] of [['kind=bogus', 'kind'], ['field=DROP%20TABLE', 'field'], ['requester=abc', 'requester'], ['requester=0', 'requester'],
    ['decided_by=99999999999', 'decided_by'], ['from=2024-02-31', 'from'], ['to=yesterday', 'to']]) {
    const r = await root.get('/approvals?' + q);
    assert.equal(r.status, 400, q);
    assert.deepEqual([r.data.error, r.data.field], ['invalid_value', field], q);
  }
  // an unknown department / application simply matches nothing
  assert.deepEqual(await seen(root, '?status=&dept=nope&app=nope'), []);
});

test('scope: a lead never reaches another department\'s requests through the filters', { skip }, async () => {
  const hr = await as('lead_hr'), fin = await as('lead_fin');
  assert.deepEqual(await seen(hr, '?status='), sorted([rq.essProgress, rq.perTest, rq.essProgress2, rq.move]));
  // fin's own request stays out of reach, whatever is asked for
  assert.deepEqual(await seen(hr, '?status=&dept=fin'), [rq.move]);                 // the move only: its source is hr
  assert.deepEqual(await seen(hr, '?status=&app=acc'), [rq.move]);
  assert.deepEqual(await seen(hr, `?status=&requester=${ids.member_fin}`), []);
  assert.deepEqual(await seen(hr, `?status=&q=${encodeURIComponent('#' + rq.accProgress)}`), []);
  assert.deepEqual(await seen(hr, '?status=&q=member_fin'), []);
  // and the other way round
  assert.deepEqual(await seen(fin, '?status=&dept=hr'), [rq.move]);                 // the move only: its destination is fin
  assert.deepEqual(await seen(fin, `?status=&requester=${ids.member_hr}`), []);
  // a member sees only their own requests, filters or not
  const m = await as('member_hr2');
  assert.deepEqual(await seen(m, '?status='), sorted([rq.perTest, rq.essProgress2]));
  assert.deepEqual(await seen(m, `?status=&requester=${ids.member_hr}`), []);
  assert.deepEqual(await seen(m, '?status=&dept=hr&kind=function'), sorted([rq.perTest, rq.essProgress2]));
});

test('awaiting=1: only the requests the reader may approve now', { skip }, async () => {
  const hr = await as('lead_hr'), fin = await as('lead_fin');
  // the move waits for the source (hr) first
  assert.deepEqual(await seen(hr, '?awaiting=1'), sorted([rq.essProgress, rq.essProgress2, rq.move]));
  assert.deepEqual(await seen(fin, '?awaiting=1'), [rq.accProgress]);
  assert.deepEqual(await seen(await as('member_hr'), '?awaiting=1'), []);            // never one's own request
  assert.deepEqual(await seen(hr, '?awaiting=1&app=ess&requester=' + ids.member_hr2), [rq.essProgress2]);
});

test('facets: the choices come only from the requests the reader may see', { skip }, async () => {
  const hr = (await (await as('lead_hr')).get('/approvals/facets?status=')).data;
  assert.deepEqual(hr.departments.map(d => d.id).sort(), ['fin', 'hr']);              // fin: the move's destination
  assert.deepEqual(hr.applications.map(a => a.id).sort(), ['acc', 'ess', 'per']);
  assert.ok(hr.applications.every(a => a.department_id && a.name_ar && a.name_en));
  assert.deepEqual(hr.requesters.map(u => u.id).sort(), sorted([ids.member_hr, ids.member_hr2, ids.mgr_both]));
  assert.ok(!hr.requesters.some(u => u.id === ids.member_fin), 'no requester of a request out of reach');
  assert.deepEqual(hr.deciders.map(u => u.id), [ids.lead_hr]);
  assert.deepEqual(hr.kinds, ['function', 'move_function']);
  assert.deepEqual(hr.fields, ['move', 'progress', 'test_status']);
  // with a status: the rejected request drops out, with its changed field and its decider
  const pend = (await (await as('lead_hr')).get('/approvals/facets?status=pending')).data;
  assert.deepEqual(pend.fields, ['move', 'progress']);
  assert.deepEqual(pend.deciders, []);
  // a member: their own requests only
  const m = (await (await as('member_fin')).get('/approvals/facets')).data;
  assert.deepEqual([m.departments.map(d => d.id), m.applications.map(a => a.id), m.requesters.map(u => u.id)], [['fin'], ['acc'], [ids.member_fin]]);
  // the administrator: everything
  const root = (await (await as('root')).get('/approvals/facets')).data;
  assert.deepEqual(root.requesters.map(u => u.id).sort(), sorted([ids.member_hr, ids.member_hr2, ids.member_fin, ids.mgr_both]));
});

test('export: the same filters, the same scope; the sheet says them in words', { skip }, async () => {
  const sheet = async buf => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.worksheets[0];
    const rows = [];
    for (let i = 5; i <= ws.rowCount; i++) rows.push(ws.getRow(i).values.slice(1));
    return { sub: String(ws.getRow(2).values.slice(1).join(' ')), rows };
  };
  const root = await as('root');
  const r = await root.get(`/export/approvals.xlsx?lang=en&status=&dept=fin&kind=function&requester=${ids.member_fin}`);
  assert.equal(r.status, 200, String(r.data));
  const s = await sheet(r.data);
  assert.deepEqual([...new Set(s.rows.map(x => x[0]))], [rq.accProgress]);
  assert.match(s.sub, /Department: Finance/);
  assert.match(s.sub, /Request type: Function edit/);
  assert.match(s.sub, /Requested by: Full member_fin/);
  // the audit row keeps the raw filters
  const au = await one(`SELECT new_value FROM audit_log WHERE action='export' AND entity='approvals' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(au.new_value.filters, { dept: 'fin', kind: 'function', requester: String(ids.member_fin) });
  // a lead exporting another department's requests gets none of them
  const hr = await as('lead_hr');
  const r2 = await hr.get(`/export/approvals.xlsx?lang=en&status=&requester=${ids.member_fin}`);
  assert.equal(r2.status, 200);
  assert.deepEqual((await sheet(r2.data)).rows.filter(x => x[0] === rq.accProgress), []);
});

test('approve all shown: only the listed ids, and only those the reader may approve', { skip }, async () => {
  const hr = await as('lead_hr');
  // the screen filtered by one requester sends the ids it lists
  const shown = (await hr.get(`/approvals?app=ess&requester=${ids.member_hr}`)).data.requests.filter(x => x.can.approve).map(x => x.id);
  assert.deepEqual(shown, [rq.essProgress]);
  // another department's request slipped into the list is ignored
  const r = await hr.post('/approvals/approve-all', { ids: [...shown, rq.accProgress] });
  assert.equal(r.status, 200);
  assert.equal(r.data.requests, 1);
  const st = async id => (await one('SELECT status FROM edit_requests WHERE id=$1', [id])).status;
  assert.deepEqual([await st(rq.essProgress), await st(rq.essProgress2), await st(rq.accProgress), await st(rq.move)],
    ['applied', 'pending', 'pending', 'pending']);
  // an empty list approves nothing
  assert.equal((await hr.post('/approvals/approve-all', { ids: [] })).data.requests, 0);
  assert.equal(await st(rq.essProgress2), 'pending');
});
