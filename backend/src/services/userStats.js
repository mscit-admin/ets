// Aggregated user statistics for the dashboard's «نظرة عامة على المستخدمين» / Users-overview section
// (routes/dashboard.js, system administrators only). Everything is computed in SQL with GROUP BY / FILTER and
// returned as counts only — never a single user row or any per-user field — so the payload carries no PII.
import { query } from '../db/pool.js';
import { onlineUserCount } from './presence.js';

// The canonical display order of the roles (same as routes/users.js GET /meta).
const ROLE_ORDER = ['admin', 'pm', 'tm', 'mgr', 'lead', 'ed', 'member', 'qa', 'obs'];

export async function usersOverview() {
  const [counts, roles, departments, online] = await Promise.all([
    // one scan of users → lifecycle and 2FA tallies (deleted = archived accounts, migration 015)
    query(`SELECT
        count(*) FILTER (WHERE deleted_at IS NULL)::int AS total,
        count(*) FILTER (WHERE deleted_at IS NULL AND is_active)::int AS active,
        count(*) FILTER (WHERE deleted_at IS NULL AND NOT is_active)::int AS inactive,
        count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted,
        count(*) FILTER (WHERE deleted_at IS NULL AND totp_enabled)::int AS tfa_enabled,
        count(*) FILTER (WHERE deleted_at IS NULL AND totp_exempt AND NOT totp_enabled)::int AS tfa_exempt,
        count(*) FILTER (WHERE deleted_at IS NULL AND NOT totp_enabled AND NOT totp_exempt)::int AS tfa_off
      FROM users`),
    // non-deleted accounts per role (every role listed, even with no users)
    query(`SELECT r.id, r.name_ar, r.name_en, count(u.id)::int AS count
      FROM roles r LEFT JOIN users u ON u.role_id=r.id AND u.deleted_at IS NULL
      GROUP BY r.id, r.name_ar, r.name_en
      ORDER BY array_position($1::text[], r.id), r.id`, [ROLE_ORDER]),
    // active, non-deleted users scoped to each department — directly (department scope) or through an application
    // of that department. Full-scope roles (admin / pm / tm) have no scope rows and so are not tied to a department.
    query(`SELECT d.id, d.name_ar, d.name_en, count(DISTINCT z.user_id)::int AS count
      FROM departments d
      LEFT JOIN (
        SELECT us.user_id, us.ref_id AS dept_id FROM user_scopes us WHERE us.kind='department'
        UNION
        SELECT us.user_id, ap.department_id FROM user_scopes us JOIN applications ap ON ap.id=us.ref_id WHERE us.kind='application'
      ) z ON z.dept_id = d.id
         AND EXISTS (SELECT 1 FROM users u WHERE u.id=z.user_id AND u.deleted_at IS NULL AND u.is_active)
      GROUP BY d.id, d.name_ar, d.name_en, d.sort
      ORDER BY d.sort`),
    onlineUserCount(),
  ]);
  const c = counts.rows[0];
  return {
    total: c.total, active: c.active, inactive: c.inactive, deleted: c.deleted,
    online, offline: Math.max(0, c.active - online),
    tfa: { enabled: c.tfa_enabled, exempt: c.tfa_exempt, off: c.tfa_off },
    roles: roles.rows,
    departments: departments.rows,
  };
}
