// Central configuration — read once from the environment (.env in development,
// /etc/ets/ets.env on the Ubuntu server via systemd EnvironmentFile).
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// ETS_ENV_FILE=none skips the file (tests); an explicitly named file that cannot be read is a hard error,
// otherwise the app would start with an empty DB password and fail with an obscure PostgreSQL message.
const envFile = process.env.ETS_ENV_FILE || path.resolve(here, '../.env');
if (process.env.ETS_ENV_FILE && process.env.ETS_ENV_FILE !== 'none') {
  try { fs.accessSync(envFile, fs.constants.R_OK); } catch (e) {
    throw new Error(`Cannot read the configuration file ${envFile} (${e.code}). ` +
      `Check that it exists and that this user can read it and enter its folder.`);
  }
}
if (process.env.ETS_ENV_FILE !== 'none') dotenv.config({ path: envFile, quiet: true });

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => parseInt(env(k, d), 10);

export const config = {
  env: env('NODE_ENV', 'development'),
  port: int('PORT', 3000),
  host: env('HOST', '127.0.0.1'),
  // Long random string; used to encrypt 2FA secrets. To rotate it, put the old value in APP_SECRET_OLD
  // (several old values may be listed, separated by spaces or commas), restart, run
  // `npm run rotate-app-secret`, then remove APP_SECRET_OLD (docs/handover/06-Security.md).
  appSecret: env('APP_SECRET', ''),
  appSecretOld: env('APP_SECRET_OLD', '').split(/[\s,]+/).filter(Boolean),
  db: {
    connectionString: env('DATABASE_URL', ''),
    host: env('PGHOST', '127.0.0.1'),
    port: int('PGPORT', 5432),
    database: env('PGDATABASE', 'ets'),
    user: env('PGUSER', 'ets'),
    password: env('PGPASSWORD', ''),
    max: int('PGPOOL_MAX', 10),
    // TLS to PostgreSQL, libpq names (also used by psql/pg_dump in the backup scripts):
    // PGSSLMODE disable | require | verify-ca | verify-full; PGSSLROOTCERT = CA file for verify-*.
    // Unset: no TLS for a local server (loopback / socket), "require" for any other host.
    sslMode: env('PGSSLMODE', ''),
    sslRootCert: env('PGSSLROOTCERT', ''),
    sslCert: env('PGSSLCERT', ''),
    sslKey: env('PGSSLKEY', ''),
  },
  session: {
    cookieName: env('SESSION_COOKIE', 'ets_sid'),
    ttlHours: int('SESSION_TTL_HOURS', 12),
    idleMinutes: int('SESSION_IDLE_MINUTES', 60),
    // Set COOKIE_SECURE=false only when the site is served over plain HTTP.
    secure: env('COOKIE_SECURE', env('NODE_ENV', '') === 'production' ? 'true' : 'false') === 'true',
  },
  security: {
    // Failed password / 2FA / recovery-code checks on one account before sign-in is paused; each further
    // failure doubles the pause (1, 2, 4 … minutes) up to LOCK_MINUTES. The counter restarts when the last
    // failure is older than LOCKOUT_RESET_MINUTES and is cleared by a complete sign-in (password + 2FA).
    maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
    lockMinutes: int('LOCK_MINUTES', 15),
    lockoutResetMinutes: int('LOCKOUT_RESET_MINUTES', 60),
    loginRateLimit: int('LOGIN_RATE_LIMIT', 30),   // password/2FA checks per IP (and failures per account) per 15 minutes
    apiRateLimit: int('API_RATE_LIMIT', 600),      // any /api request per IP per minute
    // bcrypt cost, kept within 10–14 (lower values only for the automated tests); invalid → 12.
    bcryptRounds: (n => (Number.isInteger(n) ? Math.min(14, Math.max(env('NODE_ENV', '') === 'test' ? 4 : 10, n)) : 12))(int('BCRYPT_ROUNDS', 12)),
    trustProxy: env('TRUST_PROXY', 'loopback'),
  },
  logs: {
    dir: env('LOG_DIR', path.resolve(here, '../logs')),
    level: env('LOG_LEVEL', 'info'),
    accessToDb: env('ACCESS_LOG_DB', 'true') === 'true',
  },
  staticDir: env('STATIC_DIR', ''), // serve the built frontend from here (optional; nginx usually does it)
};

// Known example / placeholder values (e.g. backend/.env.example) and obviously non-random strings.
const PLACEHOLDER = /change.?me|placeholder|example|your.?(app.?)?secret|random.?string|^(secret|password|test)/i;

// Returns why an APP_SECRET value is unacceptable, or null when it looks like a real random secret.
export function appSecretProblem(s) {
  if (!s || s.length < 32) return 'must be a random string of at least 32 characters';
  if (PLACEHOLDER.test(s)) return 'is an example/placeholder value';
  if (new Set(s).size < 12) return 'is not random enough (too few different characters)';
  return null;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '']);
const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

// Host the pool connects to (from DATABASE_URL when set); a path means a Unix socket.
export function dbHost(db = config.db) {
  if (db.connectionString) {
    try {
      const u = new URL(db.connectionString);
      return decodeURIComponent(u.hostname || u.searchParams.get('host') || '').replace(/^\[|\]$/g, '');
    } catch { return ''; }
  }
  return db.host;
}
export const isLocalDb = (db = config.db) => { const h = dbHost(db); return LOCAL_HOSTS.has(h) || h.startsWith('/'); };

// Effective sslmode: the explicit PGSSLMODE, else no TLS on loopback/socket and "require" for a remote host.
export const dbSslMode = (db = config.db) => (db.sslMode || (isLocalDb(db) ? 'disable' : 'require')).toLowerCase();

// node-postgres `ssl` option for the pool, following libpq semantics:
//   disable/allow/prefer → no TLS (node-postgres has no opportunistic mode)
//   require              → encrypted; the certificate is verified against PGSSLROOTCERT when one is given
//   verify-ca            → certificate must chain to PGSSLROOTCERT (host name not checked)
//   verify-full          → chain (PGSSLROOTCERT, else the system CAs) and host name are verified
export function dbSslOptions(db = config.db, readFile = f => fs.readFileSync(f)) {
  const mode = dbSslMode(db);
  if (!SSL_MODES.includes(mode)) throw new Error(`PGSSLMODE "${mode}" is not one of: ${SSL_MODES.join(', ')}`);
  if (['disable', 'allow', 'prefer'].includes(mode)) return false;
  const ssl = {};
  if (db.sslRootCert) ssl.ca = readFile(db.sslRootCert);
  if (db.sslCert) ssl.cert = readFile(db.sslCert);
  if (db.sslKey) ssl.key = readFile(db.sslKey);
  if (mode === 'require' && !ssl.ca) return { ...ssl, rejectUnauthorized: false };
  if (mode === 'verify-ca' && !ssl.ca) throw new Error('PGSSLMODE=verify-ca needs PGSSLROOTCERT (the CA certificate file)');
  ssl.rejectUnauthorized = true;
  if (mode !== 'verify-full') ssl.checkServerIdentity = () => undefined;
  return ssl;
}

export function assertConfig() {
  const p = appSecretProblem(config.appSecret);
  if (p) throw new Error(`APP_SECRET ${p}. Generate one with: openssl rand -base64 48`);
  // A database on another machine must be reached over TLS (sslmode require or stricter).
  if (!isLocalDb() && ['disable', 'allow', 'prefer'].includes(dbSslMode())) {
    throw new Error(`The database server ${dbHost()} is not on this machine: set PGSSLMODE=require ` +
      `(or verify-full with PGSSLROOTCERT) so the connection is encrypted`);
  }
  dbSslOptions();   // fails early on an unknown mode or an unreadable certificate file
}
