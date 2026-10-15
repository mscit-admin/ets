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
  // Long random string; used to encrypt 2FA secrets. Never change it after go-live
  // (existing 2FA enrolments would become unreadable).
  appSecret: env('APP_SECRET', ''),
  db: {
    connectionString: env('DATABASE_URL', ''),
    host: env('PGHOST', '127.0.0.1'),
    port: int('PGPORT', 5432),
    database: env('PGDATABASE', 'ets'),
    user: env('PGUSER', 'ets'),
    password: env('PGPASSWORD', ''),
    max: int('PGPOOL_MAX', 10),
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

export function assertConfig() {
  if (!config.appSecret || config.appSecret.length < 32) {
    throw new Error('APP_SECRET must be set to a random string of at least 32 characters');
  }
}
