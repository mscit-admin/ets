// Configuration checks: APP_SECRET quality, PostgreSQL TLS options, APP_SECRET rotation (crypto.js).
// Pure unit tests — no database needed.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

let cfg, cr;
const strong = () => crypto.randomBytes(48).toString('base64');

before(async () => {
  process.env.ETS_ENV_FILE = 'none';
  process.env.APP_SECRET = strong();
  for (const k of ['DATABASE_URL', 'PGHOST', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSSLCERT', 'PGSSLKEY', 'APP_SECRET_OLD']) delete process.env[k];
  cfg = await import('../src/config.js');
  cr = await import('../src/services/crypto.js');
});

test('APP_SECRET: placeholders, short and low-diversity values are rejected', () => {
  const { appSecretProblem } = cfg;
  for (const bad of ['', 'short', 'change-me-to-a-long-random-string-of-at-least-32-chars',
    'CHANGEME-CHANGEME-CHANGEME-CHANGEME-1234', 'your-app-secret-goes-here-0123456789abcdef', 'a'.repeat(64),
    'abababababababababababababababababab', 'test-secret-'.padEnd(48, 'x'), 'placeholder-0123456789-ABCDEFGHIJ-klmn']) {
    assert.ok(appSecretProblem(bad), `should reject ${JSON.stringify(bad)}`);
  }
  for (let i = 0; i < 20; i++) assert.equal(appSecretProblem(strong()), null);
  assert.equal(appSecretProblem(crypto.randomBytes(32).toString('hex')), null);
});

test('assertConfig refuses the .env.example placeholder', () => {
  const old = cfg.config.appSecret;
  try {
    cfg.config.appSecret = 'change-me-to-a-long-random-string-of-at-least-32-chars';
    assert.throws(() => cfg.assertConfig(), /APP_SECRET/);
    cfg.config.appSecret = strong();
    assert.doesNotThrow(() => cfg.assertConfig());
  } finally { cfg.config.appSecret = old; }
});

test('database TLS options follow libpq sslmode semantics', () => {
  const { dbSslOptions, dbSslMode, isLocalDb } = cfg;
  const read = f => Buffer.from('PEM:' + f);
  const db = o => ({ connectionString: '', host: '127.0.0.1', sslMode: '', sslRootCert: '', sslCert: '', sslKey: '', ...o });
  // local: no TLS by default; remote: encrypted by default
  assert.equal(isLocalDb(db()), true);
  assert.equal(isLocalDb(db({ host: '/var/run/postgresql' })), true);
  assert.equal(dbSslOptions(db(), read), false);
  assert.equal(dbSslMode(db({ host: '10.0.0.20' })), 'require');
  assert.deepEqual(dbSslOptions(db({ host: '10.0.0.20' }), read), { rejectUnauthorized: false });
  assert.equal(isLocalDb(db({ connectionString: 'postgres://u:p@db.example.ly:5432/ets' })), false);
  assert.equal(isLocalDb(db({ connectionString: 'postgres://u:p@127.0.0.1:5432/ets' })), true);
  // require + CA: verified chain, host name not checked
  let o = dbSslOptions(db({ host: 'db', sslMode: 'require', sslRootCert: '/ca.crt' }), read);
  assert.equal(o.rejectUnauthorized, true); assert.equal(String(o.ca), 'PEM:/ca.crt'); assert.equal(typeof o.checkServerIdentity, 'function');
  // verify-ca needs a CA
  assert.throws(() => dbSslOptions(db({ host: 'db', sslMode: 'verify-ca' }), read), /PGSSLROOTCERT/);
  o = dbSslOptions(db({ host: 'db', sslMode: 'verify-ca', sslRootCert: '/ca.crt' }), read);
  assert.equal(o.rejectUnauthorized, true); assert.equal(typeof o.checkServerIdentity, 'function');
  // verify-full: chain + host name (default Node check), system CAs when no file is given
  o = dbSslOptions(db({ host: 'db', sslMode: 'verify-full', sslRootCert: '/ca.crt', sslCert: '/c.crt', sslKey: '/c.key' }), read);
  assert.equal(o.rejectUnauthorized, true); assert.equal(o.checkServerIdentity, undefined);
  assert.equal(String(o.cert), 'PEM:/c.crt'); assert.equal(String(o.key), 'PEM:/c.key');
  assert.deepEqual(dbSslOptions(db({ host: 'db', sslMode: 'verify-full' }), read), { rejectUnauthorized: true });
  assert.equal(dbSslOptions(db({ host: 'db', sslMode: 'disable' }), read), false);
  assert.throws(() => dbSslOptions(db({ sslMode: 'bogus' }), read), /PGSSLMODE/);
});

test('assertConfig requires TLS for a remote database', () => {
  const saved = { ...cfg.config.db };
  try {
    Object.assign(cfg.config.db, { connectionString: '', host: '10.0.0.20', sslMode: 'disable' });
    assert.throws(() => cfg.assertConfig(), /PGSSLMODE=require/);
    cfg.config.db.sslMode = 'prefer';
    assert.throws(() => cfg.assertConfig(), /PGSSLMODE=require/);
    cfg.config.db.sslMode = '';
    assert.doesNotThrow(() => cfg.assertConfig());      // default for a remote host is "require"
    Object.assign(cfg.config.db, { host: '127.0.0.1', sslMode: 'disable' });
    assert.doesNotThrow(() => cfg.assertConfig());
  } finally { Object.assign(cfg.config.db, saved); }
});

test('2FA secret envelope: v2 with key id, tag length enforced, rotation via APP_SECRET_OLD', () => {
  const c = cfg.config;
  const first = c.appSecret;
  const blob = cr.encrypt('JBSWY3DPEHPK3PXP');
  assert.match(blob, /^v2:[0-9a-f]{12}:/);
  assert.equal(cr.decrypt(blob), 'JBSWY3DPEHPK3PXP');
  assert.equal(cr.needsReencrypt(blob), false);
  // a truncated authentication tag is refused
  const p = blob.split(':'); p[3] = Buffer.from(p[3], 'base64url').subarray(0, 4).toString('base64url');
  assert.throws(() => cr.decrypt(p.join(':')), /tag/i);
  // AAD binds a blob to its context
  const bound = cr.encrypt('SECRET', 'user:1');
  assert.equal(cr.decrypt(bound, 'user:1'), 'SECRET');
  assert.throws(() => cr.decrypt(bound, 'user:2'));
  // legacy v1 blob (SHA-256 key) still decrypts
  const iv = crypto.randomBytes(12);
  const k1 = crypto.createHash('sha256').update('ets-totp:' + first).digest();
  const ci = crypto.createCipheriv('aes-256-gcm', k1, iv);
  const enc = Buffer.concat([ci.update('LEGACY', 'utf8'), ci.final()]);
  const v1 = ['v1', iv.toString('base64url'), ci.getAuthTag().toString('base64url'), enc.toString('base64url')].join(':');
  assert.equal(cr.decrypt(v1), 'LEGACY');
  assert.equal(cr.needsReencrypt(v1), true);
  try {
    // rotate: new secret, old one kept in APP_SECRET_OLD
    c.appSecret = strong(); c.appSecretOld = [first];
    assert.equal(cr.decrypt(blob), 'JBSWY3DPEHPK3PXP');
    assert.equal(cr.decrypt(v1), 'LEGACY');
    assert.equal(cr.needsReencrypt(blob), true);
    const re = cr.reencrypt(blob), re1 = cr.reencrypt(v1);
    assert.equal(cr.needsReencrypt(re), false);
    // once the old secret is removed, only re-encrypted blobs are readable
    c.appSecretOld = [];
    assert.equal(cr.decrypt(re), 'JBSWY3DPEHPK3PXP');
    assert.equal(cr.decrypt(re1), 'LEGACY');
    assert.throws(() => cr.decrypt(blob), /unknown APP_SECRET/);
  } finally { c.appSecret = first; c.appSecretOld = []; }
});
