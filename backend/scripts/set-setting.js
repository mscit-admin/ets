#!/usr/bin/env node
// Sets one system setting from the command line (used by the installer).
//   node scripts/set-setting.js mfa.mode required
//   node scripts/set-setting.js app.org_name_en "ERP Tracking Center"
//   node scripts/set-setting.js logs.retention_days 365
// Values are validated with the same rules as the Settings screen.
import { pool, query } from '../src/db/pool.js';
import { SETTING_RULES } from '../src/services/settings.js';
import { logSystem } from '../src/services/logs.js';

const [key, raw] = process.argv.slice(2);
if (!key || raw === undefined || !SETTING_RULES[key]) {
  console.error('usage: set-setting.js <key> <value>\nkeys: ' + Object.keys(SETTING_RULES).join(', '));
  process.exit(1);
}
let value = raw;
if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
if (!SETTING_RULES[key](value)) { console.error(`invalid value for ${key}: ${raw}`); process.exit(1); }
await query(`INSERT INTO settings(key,value) VALUES ($1,$2)
  ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key, JSON.stringify(value)]);
await logSystem('setting_cli', `setting ${key} changed from CLI`, { key, value });
console.log(`${key} = ${JSON.stringify(value)}`);
await pool.end();
