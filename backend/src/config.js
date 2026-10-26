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
    loginRateLimit: int('LOGIN_RATE_LIMIT', 30),   // failures per ACCOUNT per 15 minutes (the per-account login budget)
    // Coarse secondary per-IP budget for the password/2FA checking endpoints, per 15 minutes. It is DELIBERATELY much
    // higher than loginRateLimit: a whole office behind one NAT address (10.63.x) shares it, so it must not throttle
    // many people's normal sign-ins. The real brute-force defence is the per-ACCOUNT lockout (services/lockout.js) and
    // the per-account login budget above, both keyed by the account — not by the shared office IP (ETS-SEC-003).
    loginIpRateLimit: int('LOGIN_IP_RATE_LIMIT', 300),
    apiRateLimit: int('API_RATE_LIMIT', 600),      // any /api request from an ANONYMOUS client, per IP per minute
    // Authenticated users are keyed per USER, not per IP (so a shared-office NAT address no longer shares one bucket).
    // Generous: one busy user doing normal work plus the Messages/Alerts/Notifications polling never reaches it, while
    // a runaway client/user is still bounded. Per user per minute.
    apiUserRateLimit: int('API_USER_RATE_LIMIT', 1200),
    // bcrypt cost, kept within 10–14 (lower values only for the automated tests); invalid → 12.
    bcryptRounds: (n => (Number.isInteger(n) ? Math.min(14, Math.max(env('NODE_ENV', '') === 'test' ? 4 : 10, n)) : 12))(int('BCRYPT_ROUNDS', 12)),
    trustProxy: env('TRUST_PROXY', 'loopback'),
  },
  logs: {
    dir: env('LOG_DIR', path.resolve(here, '../logs')),
    level: env('LOG_LEVEL', 'info'),
    accessToDb: env('ACCESS_LOG_DB', 'true') === 'true',
  },
  // Live updates (GET /api/events, Server-Sent Events): heartbeat interval (the session is re-checked on
  // every beat) and how many open streams one user may hold (several tabs).
  live: {
    heartbeatMs: Math.max(1000, int('LIVE_HEARTBEAT_SECONDS', 25) * 1000),
    maxStreamsPerUser: Math.max(1, int('LIVE_MAX_STREAMS_PER_USER', 5)),
  },
  // Online users (1.11.0, services/presence.js): at most one database write per session in this interval; reports
  // in between are coalesced (the latest one is written when the interval ends).
  presence: {
    minIntervalMs: Math.max(1, int('PRESENCE_MIN_INTERVAL_SECONDS', 10) || 10) * 1000,
  },
  staticDir: env('STATIC_DIR', ''), // serve the built frontend from here (optional; nginx usually does it)
  // Phones (Android app, 1.9.0): written into the pairing QR code. PUBLIC_BASE_URL = the address the phones use
  // (e.g. https://ets.example.ly, reached over the organisation's VPN from outside); empty → the address of the
  // browser that asks for the code. TLS_CERT_SHA256 = SHA-256 of the server's TLS certificate (DER, 64 hex digits,
  // colons allowed), filled by deploy/install.sh / update.sh from the nginx certificate; empty → null in the QR
  // (a publicly trusted certificate). PAIR_RATE_LIMIT = pairing attempts per IP per 15 minutes.
  mobile: {
    publicBaseUrl: env('PUBLIC_BASE_URL', '').trim().replace(/\/+$/, ''),
    certSha256: env('TLS_CERT_SHA256', '').replace(/:/g, '').trim().toLowerCase(),
    pairRateLimit: Math.max(1, int('PAIR_RATE_LIMIT', 5)),
  },
  // Release promotion (1.12.18, test→production pipeline — docs/handover/13-Release-Promotion-Design.md). PHASE 1
  // records a signed promotion intent only; the keys are NEVER in the database or the repo (same secrets rule as
  // backups). ETS_RELEASE_SIGN_KEY = path to the Ed25519 release private key PEM, root 600, on the TEST server
  // (/etc/ets/release-sign.key); when unset or unreadable the promote button is disabled and /promote returns
  // release_signing_unavailable. ETS_RELEASE_SIGNERS_DIR = directory of allow-listed signer public-key PEM files
  // (*.pub; /etc/ets/release-trust) — the verification allow-list. ETS_RELEASE_FRESHNESS_DAYS = the replay window.
  // (The actual key generation, the write-restricted deploy key and the root agents are Phase 2.)
  release: {
    signKeyFile: env('ETS_RELEASE_SIGN_KEY', path.join(env('ETS_CONF_DIR', '/etc/ets'), 'release-sign.key')),
    signersDir: env('ETS_RELEASE_SIGNERS_DIR', path.join(env('ETS_CONF_DIR', '/etc/ets'), 'release-trust')),
    freshnessDays: Math.max(1, int('ETS_RELEASE_FRESHNESS_DAYS', 14)),
  },
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

// TLS parameters node-postgres reads from a connection string. They are taken out of DATABASE_URL and turned
// into the pool's `ssl` option here, so the startup check and the pool always use the same mode (V4-N1).
const URL_TLS_KEYS = ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat'];

// Host and TLS parameters of DATABASE_URL, read the way node-postgres (pg-connection-string) reads them:
// a leading "/" is a socket directory, a ?host= parameter wins over the URL host, "socket:" URLs are
// sockets, and a URL with an empty host ("postgres://u@/db") is retried with a dummy host. Unparseable → error.
function parseDbUrl(str) {
  if (str.charAt(0) === '/') return { host: str.split(' ')[0], params: {} };
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) str = encodeURI(str).replace(/%25(\d\d)/g, '%$1');
  let u, dummy = false;
  try { u = new URL(str, 'postgres://base'); } catch {
    try { u = new URL(str.replace('@/', '@___DUMMY___/'), 'postgres://base'); dummy = true; } catch {
      throw new Error('DATABASE_URL is not a valid connection string');
    }
  }
  const params = Object.fromEntries(u.searchParams.entries());
  const host = u.protocol === 'socket:' ? decodeURI(u.pathname)
    : params.host || decodeURIComponent((dummy ? '' : u.hostname).replace(/^\[(.+)\]$/, '$1'));
  return { host, params };
}

// Host the pool connects to (from DATABASE_URL when set; an empty URL host falls back to PGHOST, as in
// node-postgres); a path means a Unix socket.
export function dbHost(db = config.db) {
  if (db.connectionString) return parseDbUrl(db.connectionString).host || db.host;
  return db.host;
}
export const isLocalDb = (db = config.db) => { const h = dbHost(db); return LOCAL_HOSTS.has(h) || h.startsWith('/'); };

// TLS settings in force: DATABASE_URL parameters (sslmode, else ssl=true/1/false/0) win over PGSSLMODE and
// the certificate files over PGSSL*; with neither, no TLS on loopback/socket and "require" for a remote host.
// node-postgres treats ssl=true as a fully verified connection, so it maps to verify-full.
function dbTls(db) {
  const p = db.connectionString ? parseDbUrl(db.connectionString).params : {};
  let mode = p.sslmode;
  if (mode === undefined && p.ssl !== undefined) {
    const v = p.ssl.toLowerCase();
    mode = ['true', '1'].includes(v) ? 'verify-full' : ['false', '0'].includes(v) ? 'disable' : `ssl=${p.ssl}`;
  }
  mode = (mode || db.sslMode || (isLocalDb(db) ? 'disable' : 'require')).toLowerCase();
  return { mode, rootCert: p.sslrootcert || db.sslRootCert, cert: p.sslcert || db.sslCert, key: p.sslkey || db.sslKey };
}

// Effective sslmode (see dbTls).
export const dbSslMode = (db = config.db) => dbTls(db).mode;

// node-postgres `ssl` option for the pool, following libpq semantics:
//   disable/allow/prefer → no TLS (node-postgres has no opportunistic mode)
//   require              → encrypted; the certificate is verified against PGSSLROOTCERT when one is given
//   verify-ca            → certificate must chain to PGSSLROOTCERT (host name not checked)
//   verify-full          → chain (PGSSLROOTCERT, else the system CAs) and host name are verified
export function dbSslOptions(db = config.db, readFile = f => fs.readFileSync(f)) {
  const t = dbTls(db), mode = t.mode;
  if (!SSL_MODES.includes(mode)) throw new Error(`PGSSLMODE "${mode}" is not one of: ${SSL_MODES.join(', ')}`);
  if (['disable', 'allow', 'prefer'].includes(mode)) return false;
  const ssl = {};
  if (t.rootCert) ssl.ca = readFile(t.rootCert);
  if (t.cert) ssl.cert = readFile(t.cert);
  if (t.key) ssl.key = readFile(t.key);
  if (mode === 'require' && !ssl.ca) return { ...ssl, rejectUnauthorized: false };
  if (mode === 'verify-ca' && !ssl.ca) throw new Error('PGSSLMODE=verify-ca needs PGSSLROOTCERT (the CA certificate file)');
  ssl.rejectUnauthorized = true;
  if (mode !== 'verify-full') ssl.checkServerIdentity = () => undefined;
  return ssl;
}

// DATABASE_URL without its TLS parameters: node-postgres would otherwise let them override the `ssl`
// option built above (an embedded sslmode=disable used to win over the startup check, V4-N1).
export function stripUrlTls(str) {
  const i = str.indexOf('?');
  if (i < 0) return str;
  const j = str.indexOf('#', i), end = j < 0 ? str.length : j;
  const keep = str.slice(i + 1, end).split('&').filter(kv => {
    const k = kv.split('=')[0];
    let name = k; try { name = decodeURIComponent(k); } catch { /* keep the raw name */ }
    return kv && !URL_TLS_KEYS.includes(name.toLowerCase());
  });
  return str.slice(0, i) + (keep.length ? '?' + keep.join('&') : '') + str.slice(end);
}

// Options for new pg.Pool(): TLS always comes from dbSslOptions (the mode assertConfig checked).
export function dbPoolConfig(db = config.db, readFile) {
  const ssl = dbSslOptions(db, readFile);
  return db.connectionString
    ? { connectionString: stripUrlTls(db.connectionString), max: db.max, ssl }
    : { host: db.host, port: db.port, database: db.database, user: db.user, password: db.password, max: db.max, ssl };
}

export function assertConfig() {
  const p = appSecretProblem(config.appSecret);
  if (p) throw new Error(`APP_SECRET ${p}. Generate one with: openssl rand -base64 48`);
  // A database on another machine must be reached over TLS (sslmode require or stricter).
  if (!isLocalDb() && ['disable', 'allow', 'prefer'].includes(dbSslMode())) {
    throw new Error(`The database server ${dbHost()} is not on this machine: set PGSSLMODE=require ` +
      `(or verify-full with PGSSLROOTCERT) and remove any weaker sslmode/ssl parameter from DATABASE_URL, ` +
      `so the connection is encrypted`);
  }
  dbSslOptions();   // fails early on an unknown mode or an unreadable certificate file
  const m = mobileConfigProblem(config.mobile);
  if (m) throw new Error(m);
  const tp = trustProxyProblem(config.security.trustProxy);
  if (tp) throw new Error(tp);
}

// TRUST_PROXY (app.set('trust proxy', …) in app.js) decides which hop's address becomes req.ip and so the key of the
// per-IP login limit (middleware/ratelimit.js) and the IP in the logs. Trusting the whole X-Forwarded-For chain lets
// any client set its own address: it picks a fresh rate-limit bucket on every request (defeating the per-IP login
// limit) and writes a false IP to the logs. 'loopback' (the default — nginx on this server), 'linklocal',
// 'uniquelocal', a hop count, or a proxy IP / CIDR / comma list are all safe and stay quiet. → why a value is unsafe,
// or null. Mirrors appSecretProblem / mobileConfigProblem; assertConfig refuses to start on a non-null result, as it
// does for the other insecure settings (a weak APP_SECRET, an unencrypted remote database). See
// docs/handover/02-Installation-Guide.md §9.
export function trustProxyProblem(value) {
  const v = String(value ?? '').trim().toLowerCase();
  // trust-all forms: boolean true, the string "true", and the "all addresses" CIDRs
  if (value === true || v === 'true' || v === '0.0.0.0/0' || v === '::/0') {
    return `TRUST_PROXY=${value === true ? 'true' : value} trusts every X-Forwarded-For header, so any client could ` +
      `set its own IP address and bypass the per-IP login rate limit (and falsify the logs). ` +
      `Keep TRUST_PROXY=loopback (nginx on this server); behind a load balancer leave it at loopback and configure ` +
      `nginx real_ip for the balancer's addresses only, or set TRUST_PROXY to the exact hop count or the proxy's ` +
      `IP/subnet — never true. See docs/handover/02-Installation-Guide.md §9.`;
  }
  return null;
}

// PUBLIC_BASE_URL / TLS_CERT_SHA256 (see config.mobile): → why a value is unusable, or null.
export function mobileConfigProblem({ publicBaseUrl, certSha256 }) {
  if (publicBaseUrl) {
    let u; try { u = new URL(publicBaseUrl); } catch { u = null; }
    if (!u || !['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) {
      return `PUBLIC_BASE_URL "${publicBaseUrl}" must be an address such as https://ets.example.ly (no user, query or fragment)`;
    }
  }
  if (certSha256 && !/^[0-9a-f]{64}$/.test(certSha256)) {
    return 'TLS_CERT_SHA256 must be the SHA-256 fingerprint of the certificate: 64 hexadecimal digits (colons allowed), ' +
      'e.g. from: openssl x509 -in <cert> -noout -fingerprint -sha256';
  }
  return null;
}
