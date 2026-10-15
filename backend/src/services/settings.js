import { query } from '../db/pool.js';
import { DEFAULT_SETTINGS } from '../db/seed.js';

let cache = null, cachedAt = 0;
const TTL = 10_000;

export async function allSettings() {
  if (cache && Date.now() - cachedAt < TTL) return cache;
  const r = await query('SELECT key, value FROM settings');
  const s = { ...DEFAULT_SETTINGS };
  for (const row of r.rows) s[row.key] = row.value;
  cache = s; cachedAt = Date.now();
  return s;
}

export async function getSetting(key) {
  return (await allSettings())[key];
}

export const invalidateSettings = () => { cache = null; };

// Validation rules for settings that may be changed from the UI.
export const SETTING_RULES = {
  'mfa.mode': v => ['off', 'optional', 'required'].includes(v),
  'mfa.issuer': v => typeof v === 'string' && v.length >= 1 && v.length <= 40,
  'calc.weight_mode': v => ['fixed', 'auto'].includes(v),
  'calc.notif_share': v => typeof v === 'number' && v >= 0 && v <= 0.5,
  'calc.reports_share': v => typeof v === 'number' && v >= 0 && v <= 0.5,
  'security.password_min_length': v => Number.isInteger(v) && v >= 10 && v <= 64,   // 10 = code floor (passwords.js)
  'logs.retention_days': v => Number.isInteger(v) && v >= 30 && v <= 3650,             // sign-in, error, system logs
  // change history: owner decision, at least one year (also enforced by the database, migration 012) (ETS-SEC-048)
  'logs.audit_retention_days': v => Number.isInteger(v) && v >= 365 && v <= 10950,
  'logs.access_retention_days': v => Number.isInteger(v) && v >= 7 && v <= 3650,
  'app.org_name_ar': v => typeof v === 'string' && v.length <= 120,
  'app.org_name_en': v => typeof v === 'string' && v.length <= 120,
  'app.default_language': v => ['ar', 'en'].includes(v),
  'approval.edits_need_lead': v => typeof v === 'boolean',
  'app.logo_height': v => Number.isInteger(v) && v >= 20 && v <= 80,
  'app.login_logo_height': v => Number.isInteger(v) && v >= 40 && v <= 200,
};
