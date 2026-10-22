#!/usr/bin/env node
// Not-secret ids used by the backup scripts (1.12.0), printed on stdout:
//   node scripts/backup-key-id.js key /etc/ets/backup.key       id of the backup key / passphrase (scrypt, 16 hex)
//   node scripts/backup-key-id.js app-secret /etc/ets/ets.env    fingerprint of APP_SECRET (HMAC of a constant)
// The secret is read from the file (never from the command line) and never printed.
import fs from 'node:fs';
import { keyId, appSecretFp, parseKv } from '../src/backup/config.js';

const [mode, file] = process.argv.slice(2);
try {
  const text = fs.readFileSync(file, 'utf8');
  if (mode === 'key') console.log(keyId(text));
  else if (mode === 'app-secret') console.log(appSecretFp(parseKv(text).APP_SECRET || ''));
  else { console.error('usage: backup-key-id.js key|app-secret FILE'); process.exit(2); }
} catch (e) {
  console.error(`backup-key-id: ${e.code || e.message}`);
  process.exit(1);
}
