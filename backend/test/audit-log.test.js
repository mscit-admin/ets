// Audit trail and logging (security remediation 1.0.0, WP6): append-only hash chains, retention, transactional
// audit rows, security events, masked unknown usernames, requester IPs, admin-only security logs, flood limits.
// Same disposable database as api.test.js:
//   TEST_DATABASE_URL=postgres://ets:pw@127.0.0.1/ets_test npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const url = process.env.TEST_DATABASE_URL;
const skip = !url && 'TEST_DATABASE_URL not set';
const PW = 'Kestrel-2026x';
const LOG_DIR = new URL('../logs-test', import.meta.url).pathname;
const ENV = {
  DATABASE_URL: url, APP_SECRET: 'test-secret-'.padEnd(48, 'x'), NODE_ENV: 'test', COOKIE_SECURE: 'false',
  LOG_DIR, LOG_LEVEL: 'warn', BCRYPT_ROUNDS: '4', MAX_FAILED_LOGINS: '3', LOGIN_RATE_LIMIT: '5', LOGIN_IP_RATE_LIMIT: '5', API_RATE_LIMIT: '100000', API_USER_RATE_LIMIT: '100000',
  ETS_ENV_FILE: 'none',
};

let server, base, pool, encrypt, totp, verifyAll, purgeLogs, logs;

before(async () => {
  if (skip) return;
  Object.assign(process.env, ENV);
  ({ pool } = await import('../src/db/pool.js'));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/db/seed.js')).seed({ log: () => {} });
  ({ encrypt } = await import('../src/services/crypto.js'));
  ({ totp } = await import('../src/services/totp.js'));
  ({ verifyAll } = await import('../src/services/logchain.js'));
  ({ purgeLogs } = await import('../src/services/retention.js'));
  logs = await import('../src/services/logs.js');
  const h = await (await import('../src/services/passwords.js')).hashPassword(PW);
  const mk = async (n, role, dept) => {
    const id = (await pool.query(`INSERT INTO users(username,full_name,password_hash,role_id,must_change_password)
      VALUES ($1,$4,$2,$3,false) RETURNING id`, [n, h, role, n])).rows[0].id;
    if (dept) await pool.query(`INSERT INTO user_scopes(user_id,kind,ref_id) VALUES ($1,'department',$2)`, [id, dept]);
  };
  await mk('root', 'admin'); await mk('pm1', 'pm'); await mk('lead1', 'lead', 'com'); await mk('mem1', 'member', 'com');
  for (const n of ['victim', 'v2', 'v3', 'chg', 'mfa1', 'gone']) await mk(n, 'qa', 'com');
  await pool.query(`UPDATE settings SET value='"optional"' WHERE key='mfa.mode'`);
  (await import('../src/services/settings.js')).invalidateSettings();
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

// Cookie-keeping client from its own address (X-Forwarded-For is trusted from loopback): LOGIN_RATE_LIMIT is 5 here.
let ipSeq = 0;
function client(ip = `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250 + 1}`, { csrf = true } = {}) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(csrf ? { 'x-requested-with': 'ets' } : {}), 'content-type': 'application/json', 'x-forwarded-for': ip, cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, data };
  };
  return {
    ip, get: p => call('GET', p), post: (p, b = {}) => call('POST', p, b), put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b), del: p => call('DELETE', p),
    login: (u, pw = PW) => call('POST', '/auth/login', { username: u, password: pw }),
    get cookie() { return cookie; }, set cookie(v) { cookie = v; },
  };
}
const settle = () => new Promise(r => setTimeout(r, 100));   // denial rows are written after the answer
const as = async n => { const c = client(); assert.equal((await c.login(n)).status, 200, n); return c; };
const one = async (sql, args) => (await pool.query(sql, args)).rows[0];
const count = async (sql, args) => Number((await one(sql, args)).n);
const uid = async n => (await one('SELECT id FROM users WHERE username=$1', [n])).id;
// Runs statements in one transaction on one connection and returns the error message (always rolled back).
async function sqlError(...stmts) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const q of stmts) await c.query(q);
    return null;
  } catch (e) { return e.message; } finally { await c.query('ROLLBACK'); c.release(); }
}
// Changes rows behind the triggers' back, like someone who owns the tables and disables them (superuser only).
async function bypass(sql, args) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL session_replication_role = replica');
    await c.query(sql, args); await c.query('COMMIT');
  } finally { c.release(); }
}
// Makes every INSERT into a log table fail (fault injection for ETS-SEC-049).
async function failInserts(table, on) {
  await pool.query(`CREATE OR REPLACE FUNCTION test_fail_insert() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'injected log write failure'; END $$`);
  await pool.query(`DROP TRIGGER IF EXISTS zz_test_fail ON ${table}`);
  if (on) await pool.query(`CREATE TRIGGER zz_test_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fail_insert()`);
}

test('ETS-SEC-013: audit_log and auth_log are append-only; the hash chain verifies and detects tampering', { skip }, async () => {
  const root = await as('root');
  for (let i = 0; i < 3; i++) await as('root');
  assert.equal((await root.put('/auth/language', { language: 'en' })).status, 200);
  assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE chain_seq IS NULL OR row_hash IS NULL`), 0);
  for (const t of ['audit_log', 'auth_log']) {
    assert.match(await sqlError(`UPDATE ${t} SET username='someone_else'`), /append-only/, t);
    assert.match(await sqlError(`DELETE FROM ${t}`), /append-only/, t);
    assert.match(await sqlError(`TRUNCATE ${t}`), /append-only/, t);
    // the purge flag alone does not allow deleting recent rows
    assert.match(await sqlError(`SELECT set_config('ets.log_purge', '${t}', true)`, `DELETE FROM ${t}`), /append-only/, t);
  }
  assert.match(await sqlError(`INSERT INTO log_chain_anchor(tbl,next_seq,prev_hash,deleted,cutoff) VALUES ('x',1,'',0,now())`,
    'DELETE FROM log_chain_anchor'), /append-only/);
  assert.match(await sqlError('TRUNCATE log_chain_anchor'), /append-only/);
  // a back-dated insert gets the database time
  await pool.query(`INSERT INTO audit_log(username,action,entity,ts) VALUES ('x','test','test', now() - interval '900 days')`);
  assert.ok(new Date((await one(`SELECT ts FROM audit_log WHERE action='test'`)).ts) > Date.now() - 60_000);
  let v = await verifyAll();
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.ok(v.tables.every(t => t.rows > 0 && t.head.seq === t.last_seq));
  // deleting a user keeps the chain intact (user_id → NULL is the one change allowed)
  const gone = await uid('gone');
  await pool.query(`INSERT INTO audit_log(user_id,username,action,entity) VALUES ($1,'gone','test','test')`, [gone]);
  await pool.query('DELETE FROM users WHERE id=$1', [gone]);
  assert.equal((await verifyAll()).ok, true);
  // tampering with the triggers disabled: a changed row, a deleted row and a removed tail are all reported
  const row = await one(`SELECT id, username FROM audit_log WHERE action='update' AND summary='language' ORDER BY id DESC LIMIT 1`);
  await bypass('UPDATE audit_log SET username=$2 WHERE id=$1', [row.id, 'pm1']);
  v = await verifyAll();
  assert.equal(v.ok, false);
  assert.ok(v.tables.find(t => t.table === 'audit_log').breaks.some(b => b.kind === 'hash_mismatch' && b.id === Number(row.id)));
  await bypass('UPDATE audit_log SET username=$2 WHERE id=$1', [row.id, row.username]);
  assert.equal((await verifyAll()).ok, true);
  const mid = await one(`SELECT chain_seq FROM auth_log ORDER BY chain_seq LIMIT 1 OFFSET 1`);
  await pool.query('CREATE TABLE test_keep AS SELECT * FROM auth_log WHERE chain_seq=$1', [mid.chain_seq]);
  await bypass('DELETE FROM auth_log WHERE chain_seq=$1', [mid.chain_seq]);
  assert.ok((await verifyAll()).tables.find(t => t.table === 'auth_log').breaks.some(b => b.kind === 'gap'));
  await bypass('INSERT INTO auth_log SELECT * FROM test_keep');
  await pool.query('DROP TABLE test_keep');
  assert.equal((await verifyAll()).ok, true);
  // the admin API and the CLI report the same; others may not run it
  const api = await root.get('/logs/integrity');
  assert.equal(api.status, 200);
  assert.equal(api.data.ok, true);
  assert.equal((await (await as('pm1')).get('/logs/integrity')).status, 403);
  const cli = spawnSync(process.execPath, ['scripts/verify-audit.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ...ENV }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.match(cli.stdout, /audit_log: OK/);
});

test('ETS-SEC-048: separate audit retention (>= 365 days), floors enforced by the database, purge recorded and anchored', { skip }, async () => {
  const root = await as('root');
  for (let i = 0; i < 4; i++) await as('root');
  assert.equal((await root.put('/settings', { 'logs.audit_retention_days': 364 })).status, 400);
  assert.equal((await root.put('/settings', { 'logs.audit_retention_days': 400 })).status, 200);
  assert.equal((await root.put('/settings', { 'logs.retention_days': 30 })).status, 200);
  assert.equal((await root.get('/settings')).data.settings['logs.audit_retention_days'], 400);
  // the function never deletes rows younger than the floor, whatever it is asked
  assert.equal(Number((await one(`SELECT ets_purge_log('audit_log', 1, 'test') AS n`)).n), 0);
  assert.equal(Number((await one(`SELECT ets_purge_log('auth_log', 1, 'test') AS n`)).n), 0);
  // make the oldest rows old (behind the triggers' back): audit 500 days, auth 40 days; one audit row 100 days
  const a = await one('SELECT min(chain_seq) AS lo FROM audit_log');
  const kept = await one('SELECT id, ts FROM audit_log WHERE chain_seq = $1 + 3', [a.lo]);
  await pool.query('CREATE TABLE test_ts AS SELECT id, ts FROM audit_log WHERE id=$1', [kept.id]);   // exact value (microseconds)
  await bypass(`UPDATE audit_log SET ts = now() - interval '500 days' WHERE chain_seq < $1 + 3`, [a.lo]);
  await bypass(`UPDATE audit_log SET ts = now() - interval '100 days' WHERE chain_seq = $1 + 3`, [a.lo]);
  const au = await one('SELECT min(chain_seq) AS lo FROM auth_log');
  await bypass(`UPDATE auth_log SET ts = now() - interval '40 days' WHERE chain_seq < $1 + 4`, [au.lo]);
  // backdating behind the triggers' back changes hashed values: the chains no longer verify, so the purge
  // deletes nothing, records why (alert) and waits for an acknowledgement (V5-O1)
  const before0 = await count('SELECT count(*) n FROM audit_log');
  const authBefore = await count('SELECT count(*) n FROM auth_log');
  (await import('../src/services/settings.js')).invalidateSettings();
  const skipped = await purgeLogs({ actor: 'system' });
  assert.equal(skipped.skipped, true);
  assert.deepEqual(skipped.tables, ['audit_log', 'auth_log']);
  assert.equal(await count('SELECT count(*) n FROM audit_log'), before0 + 1);       // only the purge_skipped row
  assert.equal(await count('SELECT count(*) n FROM auth_log'), authBefore);
  assert.equal(await count('SELECT count(*) n FROM log_chain_anchor'), 0);
  const sk = await one(`SELECT * FROM audit_log WHERE action='purge_skipped' ORDER BY id DESC LIMIT 1`);
  assert.equal(sk.new_value.alert, true); assert.equal(sk.new_value.reason, 'chain_broken');
  assert.ok(await count(`SELECT count(*) n FROM system_log WHERE event='log_purge_skipped' AND (detail->>'alert')::boolean`) >= 1);
  // an administrator acknowledges the break (recorded with who and which tables), then the purge runs
  const before = await count('SELECT count(*) n FROM audit_log');
  const out = await purgeLogs({ actor: 'cli:tester', acknowledgeBrokenChain: true });
  assert.equal(out.audit_log, 3);                                    // the 100-day row stays (audit retention 400)
  assert.equal(out.auth_log, 4);
  assert.equal(await count('SELECT count(*) n FROM audit_log'), before - 3 + 2);   // + acknowledgement + the purge's own row
  const ack = await one(`SELECT * FROM audit_log WHERE action='purge_acknowledge' ORDER BY id DESC LIMIT 1`);
  assert.equal(ack.username, 'cli:tester');
  assert.deepEqual(ack.new_value.tables.map(t => t.table), ['audit_log', 'auth_log']);
  const rec = await one(`SELECT * FROM audit_log WHERE action='purge' ORDER BY id DESC LIMIT 1`);
  assert.equal(rec.username, 'cli:tester');
  assert.equal(rec.new_value.deleted.audit_log, 3);
  assert.equal(rec.new_value.audit_retention_days, 400);
  assert.equal(rec.new_value.chains_intact_before, false); assert.equal(rec.new_value.break_acknowledged, true);
  const anchors = (await pool.query('SELECT * FROM log_chain_anchor ORDER BY id')).rows;
  assert.deepEqual(anchors.map(x => [x.tbl, Number(x.deleted)]), [['audit_log', 3], ['auth_log', 4]]);
  assert.equal(await count('SELECT count(*) n FROM audit_log WHERE id=$1', [kept.id]), 1);
  // put the kept row's real time back; the shortened chains then verify (the purged prefix is explained by the anchors)
  await bypass('UPDATE audit_log l SET ts = t.ts FROM test_ts t WHERE l.id = t.id');
  await pool.query('DROP TABLE test_ts');
  const v = await verifyAll();
  assert.equal(v.ok, true, JSON.stringify(v.tables.map(t => t.breaks)));
  assert.ok(await count(`SELECT count(*) n FROM system_log WHERE event='log_purge' AND detail->>'actor'='cli:tester'`) >= 1);
  await root.put('/settings', { 'logs.retention_days': 365, 'logs.audit_retention_days': 365 });
  // the CLI: a broken chain → nothing deleted, exit status 2; --acknowledge-broken-chain proceeds; unknown option → 64
  const cliRun = (...args) => spawnSync(process.execPath, ['scripts/purge-logs.js', ...args],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ...ENV }, encoding: 'utf8' });
  const victimRow = await one('SELECT id, summary FROM audit_log ORDER BY chain_seq DESC LIMIT 1');
  await bypass(`UPDATE audit_log SET summary = 'tampered' WHERE id=$1`, [victimRow.id]);
  const n0 = await count('SELECT count(*) n FROM log_chain_anchor');
  let cli = cliRun();
  assert.equal(cli.status, 2, cli.stderr + cli.stdout);
  assert.match(cli.stderr, /--acknowledge-broken-chain/);
  assert.equal(await count('SELECT count(*) n FROM log_chain_anchor'), n0);
  assert.equal(cliRun('--bogus').status, 64);
  cli = cliRun('--acknowledge-broken-chain');
  assert.equal(cli.status, 0, cli.stderr + cli.stdout);
  assert.ok(await count(`SELECT count(*) n FROM audit_log WHERE action='purge_acknowledge' AND username LIKE 'cli:%' AND username <> 'cli:tester'`) >= 1);
  await bypass('UPDATE audit_log SET summary = $2 WHERE id=$1', [victimRow.id, victimRow.summary]);
  assert.equal((await verifyAll()).ok, true);
});

test('ETS-SEC-049: changes do not commit without their audit / auth row; exports are refused', { skip }, async () => {
  const root = await as('root');
  const victim = await uid('victim');
  await pool.query(`UPDATE users SET failed_attempts=3, locked_until=now() + interval '1 hour' WHERE id=$1`, [victim]);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await failInserts('audit_log', true);
  try {
    assert.equal((await root.post(`/users/${victim}/unlock`)).status, 500);
    assert.ok((await one('SELECT locked_until FROM users WHERE id=$1', [victim])).locked_until);
    assert.equal((await root.post('/users/bulk-2fa', { user_ids: [victim], exempt: true })).status, 500);
    assert.equal((await one('SELECT totp_exempt FROM users WHERE id=$1', [victim])).totp_exempt, false);
    assert.equal((await root.put('/branding/logo', { data: png })).status, 500);
    assert.equal(await count(`SELECT count(*) n FROM branding_assets WHERE key='logo'`), 0);
    assert.equal((await root.put('/auth/language', { language: 'ar' })).status, 500);
    assert.equal((await one(`SELECT language FROM users WHERE username='root'`)).language, 'en');
    assert.equal((await root.post(`/users/${victim}/revoke-sessions`)).status, 500);
    const exp = await root.get('/tracker/export');
    assert.equal(exp.status, 500);
    assert.equal(exp.data.applications, undefined);
    assert.equal((await root.get('/logs/auth/export')).status, 500);
  } finally { await failInserts('audit_log', false); }
  // sign-in log failures: the change is refused, the outcome of a failed sign-in is not changed
  const chg = await as('chg');
  const hash = (await one(`SELECT password_hash FROM users WHERE username='chg'`)).password_hash;
  const failsBefore = logs.logWriteFailures();
  await failInserts('auth_log', true);
  try {
    assert.equal((await chg.post('/auth/change-password', { current_password: PW, new_password: 'Brand-New-2026x' })).status, 500);
    assert.equal((await one(`SELECT password_hash FROM users WHERE username='chg'`)).password_hash, hash);
    assert.equal((await client().login('v2')).status, 500);                          // no session without its 'login' row
    assert.equal(await count(`SELECT count(*) n FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.username='v2'`), 0);
    assert.equal((await client().login('v3', 'wrong')).status, 401);                  // failed sign-in: same answer…
    assert.equal((await one(`SELECT failed_attempts FROM users WHERE username='v3'`)).failed_attempts, 1);
  } finally { await failInserts('auth_log', false); }
  assert.ok(logs.logWriteFailures() > failsBefore);                                    // … but the failure is counted
  assert.ok((await root.get('/logs/stats')).data.log_write_failures > 0);
  // and with working logs the same operations commit with their rows
  assert.equal((await root.post(`/users/${victim}/unlock`)).status, 200);
  assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE action='unlock' AND entity_id=$1`, [String(victim)]), 1);
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE event='account_unlocked_by_admin' AND user_id=$1`, [victim]), 1);
  assert.equal((await root.post(`/users/${victim}/revoke-sessions`)).status, 200);
  assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE action='revoke_sessions' AND entity_id=$1`, [String(victim)]), 1);
});

test('ETS-SEC-050: security events are recorded', { skip }, async () => {
  const ev = async (event, user) => count(`SELECT count(*) n FROM auth_log WHERE event=$1 AND username=$2`, [event, user]);
  // password policy rejections
  const chg = await as('chg');
  assert.equal((await chg.post('/auth/change-password', { current_password: PW, new_password: 'short' })).data.error, 'weak_password');
  assert.equal((await chg.post('/auth/change-password', { current_password: PW, new_password: PW })).status, 400);
  const rej = (await pool.query(`SELECT detail FROM auth_log WHERE event='password_change_rejected' AND username='chg' ORDER BY id`)).rows;
  assert.deepEqual(rej.map(r => r.detail.reason).slice(-2), ['weak_password', 'password_reused']);
  // re-authentication while paused, 2FA verification while paused
  await pool.query(`UPDATE users SET locked_until=now() + interval '5 minutes' WHERE username='chg'`);
  assert.equal((await chg.post('/auth/change-password', { current_password: PW, new_password: 'Brand-New-2026x' })).status, 429);
  assert.equal(await ev('reauth_while_locked', 'chg'), 1);
  await pool.query(`UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE username='chg'`);
  const secret = (await import('../src/services/totp.js')).generateSecret();
  await pool.query(`UPDATE users SET totp_secret=$1, totp_enabled=true WHERE username='mfa1'`, [encrypt(secret)]);
  const m = client();
  assert.equal((await m.login('mfa1')).data.stage, 'verify');
  await pool.query(`UPDATE users SET locked_until=now() + interval '5 minutes' WHERE username='mfa1'`);
  assert.equal((await m.post('/auth/2fa/verify', { code: totp(secret) })).status, 429);
  assert.equal(await ev('mfa_verify_while_locked', 'mfa1'), 1);
  await pool.query(`UPDATE users SET locked_until=NULL, failed_attempts=0 WHERE username='mfa1'`);
  // CSRF rejection and permission denial have their own event names
  const pm = await as('pm1');
  const noCsrf = client(undefined, { csrf: false }); noCsrf.cookie = pm.cookie;
  assert.equal((await noCsrf.put('/auth/language', { language: 'en' })).status, 403);
  await settle();                                   // like the denial below, the row is written after the answer
  assert.equal(await ev('csrf_rejected', 'pm1'), 1);
  assert.equal((await pm.get('/users')).status, 403);
  await settle();
  assert.ok(await ev('access_denied', 'pm1') >= 1);
  // an administrator opening a user record or a security log
  const root = await as('root');
  const victim = await uid('victim');
  await root.get('/users/' + victim);
  assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE action='view' AND entity='user' AND entity_id=$1`, [String(victim)]), 1);
  await root.get('/logs/auth'); await root.get('/logs/auth?page=2');
  assert.equal(await count(`SELECT count(*) n FROM audit_log WHERE action='view' AND entity='log' AND entity_id='auth' AND username='root'`), 1);
  // idle expiry, then reuse of the ended session
  const s = await as('v3');
  await pool.query(`UPDATE sessions SET last_seen_at = now() - interval '1 day' WHERE user_id=$1 AND revoked_at IS NULL`, [await uid('v3')]);
  const old = s.cookie;
  assert.equal((await s.get('/auth/me')).data.authenticated, false);
  const exp = await one(`SELECT detail FROM auth_log WHERE event='session_expired' AND username='v3' ORDER BY id DESC LIMIT 1`);
  assert.equal(exp.detail.reason, 'idle');
  s.cookie = old;
  await s.get('/auth/me');
  assert.equal(await ev('session_revoked_reuse', 'v3'), 1);
  // command line: settings and administrator accounts are in the change history and the sign-in log
  const cwd = new URL('..', import.meta.url).pathname;
  const run = (script, args, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...ENV, ...extra }, encoding: 'utf8' });
  let r = run('scripts/set-setting.js', ['mfa.mode', 'off']);
  assert.equal(r.status, 0, r.stderr);
  const setRow = await one(`SELECT * FROM audit_log WHERE entity='setting' AND entity_id='mfa.mode' ORDER BY id DESC LIMIT 1`);
  assert.match(setRow.username, /^cli:/);
  assert.deepEqual([setRow.old_value.value, setRow.new_value.value], ['optional', 'off']);
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE event='mfa_policy_changed' AND username LIKE 'cli:%'`), 1);
  r = run('scripts/set-setting.js', ['mfa.mode', 'optional']);
  assert.equal(r.status, 0, r.stderr);
  r = run('scripts/create-admin.js', ['--username', 'cliadmin', '--name', 'CLI Admin', '--reset-2fa'], { ETS_ADMIN_PASSWORD: 'Very-Strong-Admin-2026' });
  assert.equal(r.status, 0, r.stderr);
  const ca = await one(`SELECT * FROM audit_log WHERE entity='user' AND summary LIKE 'cliadmin %' ORDER BY id DESC LIMIT 1`);
  assert.equal(ca.action, 'create');
  assert.match(ca.username, /^cli:/);
  assert.equal(await ev('admin_created_cli', 'cliadmin'), 1);
  assert.equal(await ev('mfa_reset_cli', 'cliadmin'), 1);
  (await import('../src/services/settings.js')).invalidateSettings();
});

test('ETS-SEC-051: an unknown username is never stored as typed (DB, file log, export)', { skip }, async () => {
  const typed = 'S3cret!Pass 2026';
  const c = client();
  assert.equal((await c.login(typed, 'x')).status, 401);
  // rate-limited path too (LOGIN_RATE_LIMIT 5 per IP)
  const rl = client();
  for (let i = 0; i < 6; i++) await rl.login('RateLtd-S3cret 2026', 'x');
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE username LIKE '%S3cret%' OR detail::text LIKE '%S3cret%'`), 0);
  const masked = logs.maskUsername(typed);
  assert.match(masked, /^\?\*\*\*#[0-9a-f]{12}$/);                        // no characters of a non-username value
  assert.match(logs.maskUsername('ghost.user'), /^\?g\*\*\*#[0-9a-f]{12}$/);
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE username=$1 AND event='login_unknown_user'`, [masked]), 1);
  assert.ok(await count(`SELECT count(*) n FROM auth_log WHERE event='rate_limited' AND username=$1`, [logs.maskUsername('RateLtd-S3cret 2026')]) >= 1);
  for (const f of ['app.log', 'error.log']) {
    const p = `${LOG_DIR}/${f}`;
    if (fs.existsSync(p)) assert.equal(fs.readFileSync(p, 'utf8').includes('S3cret'), false, f);
  }
  const root = await as('root');
  assert.equal((await root.get('/logs/auth/export')).data.includes('S3cret'), false);
  // a known account is still logged by its name
  await client().login('victim', 'wrong');
  assert.ok(await count(`SELECT count(*) n FROM auth_log WHERE username='victim' AND event='login_bad_password'`) >= 1);
});

test('ETS-SEC-052: a change applied on approval carries the requester\'s IP; the approver\'s IP is in the context', { skip }, async () => {
  const member = client('10.52.0.2'); await member.login('mem1');
  const lead = client('10.52.0.3'); await lead.login('lead1');
  const f = await one(`SELECT f.id, f.progress FROM functions f JOIN applications a ON a.id=f.app_id
    WHERE a.department_id='com' AND f.enabled AND f.removed_at IS NULL ORDER BY f.id LIMIT 1`);
  const r = await member.patch('/tracker/functions/' + f.id, { progress: (+f.progress + 7) % 100 });
  assert.equal(r.status, 202);
  assert.equal((await lead.post(`/approvals/${r.data.request_id}/approve`)).status, 200);
  const upd = await one(`SELECT username, host(ip) AS ip, context FROM audit_log WHERE action='update' AND entity='function'
    AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [String(f.id)]);
  assert.equal(upd.username, 'mem1');
  assert.equal(upd.ip, '10.52.0.2');
  assert.equal(upd.context.approver_ip, '10.52.0.3');
  assert.equal(upd.context.approved_by.username, 'lead1');
  const ap = await one(`SELECT username, host(ip) AS ip FROM audit_log WHERE action='edit_approve' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual([ap.username, ap.ip], ['lead1', '10.52.0.3']);
});

test('ETS-SEC-047: security logs and IP addresses are for administrators only (API and CSV)', { skip }, async () => {
  const pm = await as('pm1'), lead = await as('lead1'), root = await as('root');
  for (const t of ['auth', 'access', 'error', 'system']) {
    assert.equal((await pm.get('/logs/' + t)).status, 403, t);
    assert.equal((await pm.get(`/logs/${t}/export`)).status, 403, t);
    assert.equal((await lead.get('/logs/' + t)).status, 403, t);
    assert.equal((await root.get('/logs/' + t)).status, 200, t);
  }
  assert.equal((await pm.get('/logs/stats')).status, 403);
  const rows = (await pm.get('/logs/audit?limit=500')).data.rows;
  assert.ok(rows.length > 0);
  const text = JSON.stringify(rows);
  assert.equal(/"(ip|user_agent|approver_ip)"/.test(text), false);
  assert.equal(text.includes('10.52.0.'), false);
  const scoped = (await lead.get('/logs/audit?limit=500')).data.rows;
  assert.ok(scoped.length > 0);
  assert.equal(/"(ip|approver_ip)"/.test(JSON.stringify(scoped)), false);
  const csv = (await pm.get('/logs/audit/export')).data;
  assert.equal(csv.split('\r\n')[0].split(',').includes('ip'), false);
  assert.equal(csv.includes('10.52.0.'), false);
  // the administrator still sees them
  const adm = (await root.get('/logs/audit?limit=500')).data.rows;
  assert.ok(adm.some(x => x.ip === '10.52.0.2' && x.context?.approver_ip === '10.52.0.3'));
  assert.ok((await root.get('/logs/audit/export')).data.split('\r\n')[0].split(',').includes('ip'));
});

test('ETS-SEC-077: a login flood writes at most LOGIN_RATE_LIMIT + 1 auth rows; anonymous 404s are not stored', { skip }, async () => {
  const ip = '10.77.0.1';
  const c = client(ip);
  for (let i = 0; i < 40; i++) await c.login('flood' + i + 'x'.repeat(80), 'x');
  assert.ok(await count(`SELECT count(*) n FROM auth_log WHERE ip=$1`, [ip]) <= 5 + 1);
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE ip=$1 AND event='rate_limited'`, [ip]), 1);
  const anon = client('10.77.0.2');
  for (let i = 0; i < 10; i++) assert.equal((await anon.get('/does-not-exist/' + i + 'a'.repeat(1000))).status, 404);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(await count(`SELECT count(*) n FROM access_log WHERE ip='10.77.0.2'`), 0);
  // anonymous requests refused by the CSRF check are not stored either
  const anonCsrf = client('10.77.0.4', { csrf: false });
  for (let i = 0; i < 5; i++) assert.equal((await anonCsrf.post('/auth/logout')).status, 403);
  await settle();
  assert.equal(await count(`SELECT count(*) n FROM auth_log WHERE ip='10.77.0.4'`), 0);
  // a signed-in user's 404 is still recorded, with a capped path and user agent
  const root = client('10.77.0.3'); await root.login('root');
  await root.get('/does-not-exist/' + 'b'.repeat(1000));
  await new Promise(r => setTimeout(r, 100));
  const row = await one(`SELECT path FROM access_log WHERE ip='10.77.0.3' AND status=404`);
  assert.ok(row && row.path.length <= 300);
});
