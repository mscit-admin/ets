// Prints a PostgreSQL SCRAM-SHA-256 password verifier for the password in the ETS_DB_PASSWORD
// environment variable (never a command-line argument). deploy/install.sh sends
//   ALTER ROLE ... PASSWORD '<verifier>'
// so the clear-text password never reaches the PostgreSQL server, its logs or the process list.
// Format (RFC 5803 / PostgreSQL): SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
import crypto from 'node:crypto';

const pw = process.env.ETS_DB_PASSWORD || '';
// printable ASCII only: SASLprep leaves it unchanged, so the verifier matches what libpq sends
if (!/^[\x21-\x7e]{12,}$/.test(pw)) {
  console.error('ETS_DB_PASSWORD must be at least 12 printable ASCII characters without spaces');
  process.exit(1);
}
const iterations = 4096;
const salt = crypto.randomBytes(16);
const salted = crypto.pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const stored = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
const server = hmac(salted, 'Server Key');
process.stdout.write(`SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored.toString('base64')}:${server.toString('base64')}\n`);
