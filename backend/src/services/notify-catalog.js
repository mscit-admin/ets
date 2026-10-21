// Notification types and the receiving policy (proposal §2–§3). Pure data and checks, no I/O: used by the settings
// rules, the seed, the notification service and the tests.
//
// Who receives an alert = ① eligibility in code (permission + scope rule + the admin role for security / system
// types; services/notify.js) ∧ ② the administrator's policy (notify.policy: on/off per type × role, phone allowed,
// mandatory) ∧ ③ restrictions on the user (blocks set by an administrator, then the user's own muting of
// non-mandatory types) ∧ an active account. Each layer only narrows the one before it.
//
// Policy cells (per type × role):
//   eligible  the role may receive the type at all (the matrix of §3.1 without its ❌ cells); a policy never enables
//             another cell
//   on        received by default (✅); eligible but off by default (⚙) otherwise
//   locked    mandatory in code (🔒): cannot be turned off, muted or blocked
// push: the type may be sent to the phone (the Android app); security types with names / IP addresses (S1, S2, S5,
// S8) are in-app only by default. mandatory: the administrator makes the type mandatory for every role it is on for.

export const ROLES = ['admin', 'pm', 'tm', 'mgr', 'lead', 'member', 'ed', 'qa', 'obs'];
export const CATEGORIES = ['approvals', 'tracking', 'plan', 'security', 'system'];
export const SEVERITIES = ['info', 'warning', 'critical'];

// matrix strings: one character per role of ROLES — '+' on, '-' eligible but off, '!' mandatory (locked), '.' not eligible
const M = s => Object.fromEntries(ROLES.map((r, i) => [r, s[i]]));

// kind: 'event' (created when the change is committed) | 'periodic' (the scheduled check). digest: a periodic summary
// the user can switch off with «الملخصات الدورية» (unless mandatory for them). scope: how a stored row is checked
// again when read (services/notify.js → eligible()).
export const TYPES = {
  // ---- approvals
  approval_pending:  { code: 'A1', category: 'approvals', kind: 'event', severity: 'warning', perms: ['apv_dept'], scope: 'approver', matrix: M('....!....'), push: true },
  approval_overdue:  { code: 'A2', category: 'approvals', kind: 'periodic', severity: 'warning', perms: ['apv_dept', 'apv_final'], scope: 'approvals', matrix: M('.++.!....'), push: true },
  request_decided:   { code: 'A3', category: 'approvals', kind: 'event', severity: 'info', perms: [], scope: 'self', matrix: M('...+.+++.'), push: true },
  import_pending:    { code: 'A4', category: 'approvals', kind: 'event', severity: 'warning', perms: ['apv_dept', 'apv_final'], scope: 'import', matrix: M('.!!.!....'), push: true },
  import_result:     { code: 'A5', category: 'approvals', kind: 'event', severity: 'info', perms: [], scope: 'self', matrix: M('+++.++...'), push: true },
  import_overdue:    { code: 'A6', category: 'approvals', kind: 'periodic', severity: 'warning', perms: ['apv_dept', 'apv_final'], scope: 'approvals', matrix: M('.++.!....'), push: true },
  // ---- tracking (functions / report items)
  stuck:             { code: 'T1', category: 'tracking', kind: 'periodic', severity: 'warning', perms: ['pct'], scope: 'app_or_dept', matrix: M('-++++++..'), push: true, digest: true },
  untested:          { code: 'T2', category: 'tracking', kind: 'periodic', severity: 'warning', perms: ['tst'], scope: 'app_or_dept', matrix: M('-+++++++.'), push: true, digest: true },
  failed_retest:     { code: 'T3', category: 'tracking', kind: 'periodic', severity: 'critical', perms: ['tst'], scope: 'app_or_dept', matrix: M('-+++++++.'), push: true, digest: true },
  pass_conflict:     { code: 'T4', category: 'tracking', kind: 'periodic', severity: 'warning', perms: ['pct', 'tst'], scope: 'app_or_dept', matrix: M('-+++++++.'), push: true, digest: true },
  not_started:       { code: 'T5', category: 'tracking', kind: 'periodic', severity: 'info', perms: ['pct'], scope: 'dept', matrix: M('-++++--..'), push: true, digest: true },
  quality:           { code: 'T6', category: 'tracking', kind: 'periodic', severity: 'info', perms: ['tst'], scope: 'app', matrix: M('---++---.'), push: true, digest: true },
  excluded:          { code: 'T7', category: 'tracking', kind: 'event', severity: 'info', perms: ['pct', 'tst', 'tog'], scope: 'app', matrix: M('---+++++.'), push: true },
  moved_in:          { code: 'T8', category: 'tracking', kind: 'event', severity: 'info', perms: ['pct', 'tst', 'tog'], scope: 'app', matrix: M('---+++++.'), push: true },
  // ---- plan and schedule
  dept_behind:       { code: 'P1', category: 'plan', kind: 'periodic', severity: 'warning', perms: [], scope: 'dept', matrix: M('-++++----'), push: true, digest: true },
  dept_stalled:      { code: 'P2', category: 'plan', kind: 'periodic', severity: 'warning', perms: [], scope: 'dept', matrix: M('-++++----'), push: true, digest: true },
  project_status:    { code: 'P3', category: 'plan', kind: 'periodic', severity: 'warning', perms: [], scope: 'project', matrix: M('-++......'), push: true, digest: true },
  close_approaching: { code: 'P4', category: 'plan', kind: 'periodic', severity: 'info', perms: [], scope: 'project', matrix: M('-++......'), push: true, digest: true },
  // ---- security and system: the admin role only (ETS-SEC-047), never granted to another role by any setting
  account_locked:    { code: 'S1', category: 'security', kind: 'event', severity: 'warning', admin: true, scope: 'admin', matrix: M('+........'), push: false },
  failed_logins:     { code: 'S2', category: 'security', kind: 'periodic', severity: 'critical', admin: true, scope: 'admin', matrix: M('+........'), push: false },
  audit_integrity:   { code: 'S3', category: 'system', kind: 'periodic', severity: 'critical', admin: true, scope: 'admin', matrix: M('!........'), push: true },
  email_index:       { code: 'S4', category: 'system', kind: 'periodic', severity: 'warning', admin: true, scope: 'admin', matrix: M('+........'), push: true },
  access_denied:     { code: 'S5', category: 'security', kind: 'periodic', severity: 'warning', admin: true, scope: 'admin', matrix: M('+........'), push: false },
  backup_missing:    { code: 'S6', category: 'system', kind: 'periodic', severity: 'critical', admin: true, scope: 'admin', matrix: M('!........'), push: true },
  retention_reduced: { code: 'S7', category: 'security', kind: 'event', severity: 'warning', admin: true, scope: 'admin', matrix: M('!........'), push: true },
  server_errors:     { code: 'S8', category: 'system', kind: 'periodic', severity: 'warning', admin: true, scope: 'admin', matrix: M('+........'), push: false },
};
// Not a policy type: replaces the alerts above the hourly cap (notify.rate_cap_per_hour) of one user.
export const RATE_CAPPED = 'rate_capped';
export const typeInfo = t => (t === RATE_CAPPED ? { code: '—', category: 'system', kind: 'event', severity: 'info', scope: 'self', push: true }
  : Object.hasOwn(TYPES, t) ? TYPES[t] : null);

export const isEligibleCell = (type, role) => ['+', '-', '!'].includes(TYPES[type]?.matrix[role]);
export const isLockedCell = (type, role) => TYPES[type]?.matrix[role] === '!';

// The default policy (the matrix of §3.1): { type: { roles: { role: bool }, push: bool, mandatory: bool } }.
export function defaultPolicy() {
  return Object.fromEntries(Object.entries(TYPES).map(([k, t]) => [k, {
    roles: Object.fromEntries(ROLES.filter(r => isEligibleCell(k, r)).map(r => [r, t.matrix[r] !== '-'])),
    push: t.push, mandatory: false,
  }]));
}

// Stored policy (possibly partial or from an older version) → the full policy in force. Unknown types, roles and
// values are ignored; ineligible cells are always off and locked cells always on.
export function effectivePolicy(stored) {
  const p = defaultPolicy();
  const s = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  for (const [k, cell] of Object.entries(p)) {
    const v = Object.hasOwn(s, k) ? s[k] : null;
    if (!v || typeof v !== 'object') continue;
    if (v.roles && typeof v.roles === 'object') {
      for (const r of Object.keys(cell.roles)) if (typeof v.roles[r] === 'boolean' && !isLockedCell(k, r)) cell.roles[r] = v.roles[r];
    }
    if (typeof v.push === 'boolean') cell.push = v.push;
    if (typeof v.mandatory === 'boolean') cell.mandatory = v.mandatory;
  }
  return p;
}

// Validation of a notify.policy value (SETTING_RULES): an object of known types; each { roles?, push?, mandatory? }.
// Refused: enabling a cell that is not eligible (❌), switching off a mandatory cell (🔒), unknown keys / values.
export function policyProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not_an_object';
  for (const [k, cell] of Object.entries(v)) {
    if (!Object.hasOwn(TYPES, k)) return 'unknown_type:' + k;
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return 'invalid_cell:' + k;
    for (const key of Object.keys(cell)) if (!['roles', 'push', 'mandatory'].includes(key)) return 'unknown_key:' + k;
    if (cell.push !== undefined && typeof cell.push !== 'boolean') return 'invalid_push:' + k;
    if (cell.mandatory !== undefined && typeof cell.mandatory !== 'boolean') return 'invalid_mandatory:' + k;
    if (cell.roles !== undefined) {
      if (!cell.roles || typeof cell.roles !== 'object' || Array.isArray(cell.roles)) return 'invalid_roles:' + k;
      for (const [r, on] of Object.entries(cell.roles)) {
        if (!ROLES.includes(r)) return 'unknown_role:' + k + '.' + r;
        if (typeof on !== 'boolean') return 'invalid_value:' + k + '.' + r;
        if (on && !isEligibleCell(k, r)) return 'not_eligible:' + k + '.' + r;
        if (!on && isLockedCell(k, r)) return 'mandatory:' + k + '.' + r;
      }
    }
  }
  return null;
}

// Policy decisions for one user (role) and type, from the policy in force.
export const policyOn = (pol, type, role) => type === RATE_CAPPED || !!pol[type]?.roles?.[role];
export const isMandatory = (pol, type, role) => type !== RATE_CAPPED && (isLockedCell(type, role) || (!!pol[type]?.mandatory && policyOn(pol, type, role)));
export const pushAllowed = (pol, type) => type === RATE_CAPPED || !!pol[type]?.push;

// ---- settings of the notifications (Settings → «الإشعارات»): defaults and validation rules
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];          // 0 = Sunday … 6 = Saturday
const intRule = (lo, hi) => v => Number.isInteger(v) && v >= lo && v <= hi;
export const validTimeZone = v => {
  if (typeof v !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(v) || v.length > 60) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; }
};

export const NOTIFY_DEFAULTS = {
  'notify.enabled': true,
  'notify.timezone': 'Africa/Tripoli',
  'notify.digest_hour': 8,                 // daily checks and summaries from this local hour …
  'notify.work_days': [0, 1, 2, 3, 4],     // … on these days (Sunday–Thursday)
  'notify.stuck_days': 14,                 // T1: 0 < progress < 100 and no progress change for N days (critical after 2N)
  'notify.untested_days': 7,               // T2: 100 % and not tested N days after reaching 100 %
  'notify.failed_retest_days': 7,          // T3: failed and not tested again for N days
  'notify.not_started_days': 30,           // T5: still at 0 % N days after it was added
  'notify.approval_remind_hours': 48,      // A2: request waiting this long → reminder to the approvers
  'notify.approval_escalate_days': 5,      // A2: … this long → escalation to the project / technical managers
  'notify.import_overdue_days': 3,         // A6
  'notify.dept_risk_gap': 5,               // P1: points behind the plan → at risk
  'notify.dept_delay_gap': 15,             // P1: → delayed
  'notify.dept_stalled_points': 0.5,       // P2: change over 30 days at most this many points
  'notify.close_warning_days': 30,         // P4
  'notify.failed_logins_threshold': 20,    // S2: failed sign-ins in 15 minutes (one address, or all together)
  'notify.access_denied_threshold': 30,    // S5: refusals in one hour
  'notify.server_errors_threshold': 10,    // S8: server errors in one hour
  'notify.backup_max_age_hours': 26,       // S6
  'notify.rate_cap_per_hour': 50,          // new alerts per user per hour (mandatory alerts are never held back)
  'notify.retention_days': 180,            // read alerts kept this long, unread twice as long
  'notify.device_idle_days': 90,           // a phone not seen for this long is revoked
  'notify.policy': {},                     // {} = the default matrix (effectivePolicy)
};

export const NOTIFY_RULES = {
  'notify.enabled': v => typeof v === 'boolean',
  'notify.timezone': validTimeZone,
  'notify.digest_hour': intRule(0, 23),
  'notify.work_days': v => Array.isArray(v) && v.length >= 1 && v.length <= 7 && v.every(d => WEEKDAYS.includes(d)) && new Set(v).size === v.length,
  'notify.stuck_days': intRule(3, 90),
  'notify.untested_days': intRule(1, 60),
  'notify.failed_retest_days': intRule(1, 60),
  'notify.not_started_days': intRule(7, 180),
  'notify.approval_remind_hours': intRule(4, 168),
  'notify.approval_escalate_days': intRule(1, 30),
  'notify.import_overdue_days': intRule(1, 30),
  'notify.dept_risk_gap': intRule(1, 50),
  'notify.dept_delay_gap': intRule(1, 50),
  'notify.dept_stalled_points': v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10,
  'notify.close_warning_days': intRule(1, 180),
  'notify.failed_logins_threshold': intRule(5, 500),
  'notify.access_denied_threshold': intRule(5, 1000),
  'notify.server_errors_threshold': intRule(1, 1000),
  'notify.backup_max_age_hours': intRule(2, 168),
  'notify.rate_cap_per_hour': intRule(5, 500),
  'notify.retention_days': intRule(30, 730),
  'notify.device_idle_days': intRule(7, 365),
  'notify.policy': v => policyProblem(v) === null,
};

// Rules across several keys, checked on the values after a change: → { key, reason } or null.
export function crossProblem(s) {
  if (!(s['notify.dept_risk_gap'] < s['notify.dept_delay_gap'])) return { key: 'notify.dept_delay_gap', reason: 'delay_gap_not_above_risk_gap' };
  if (!(s['notify.approval_escalate_days'] * 24 > s['notify.approval_remind_hours'])) return { key: 'notify.approval_escalate_days', reason: 'escalation_before_reminder' };
  return null;
}
