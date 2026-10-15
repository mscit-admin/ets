-- ETS 1.0.0 — security remediation (ETS-SEC-004, ETS-SEC-005). Safe to run on an existing installation.
--
-- 1) User administration ('usr') belongs to the admin role only. A per-user override that granted 'usr' to a
--    user of another role is removed (the application ignores it from 1.0.0 anyway); each removal is recorded in
--    the change history with the user it concerned.
-- 2) A user whose role is not full-scope and who has no scope rows used to see every department; from 1.0.0 such
--    a user sees nothing until an administrator gives them a department or application. Nothing is granted
--    automatically: the affected accounts are listed once in the system log (warning) so that an administrator
--    can review them in Users.

INSERT INTO audit_log(username, action, entity, entity_id, summary, old_value, new_value)
SELECT 'system', 'update', 'user', u.id::text, u.username || ': usr override removed (admin role only)',
       jsonb_build_object('overrides', jsonb_build_array(jsonb_build_object('permission', 'usr', 'granted', true))),
       jsonb_build_object('overrides', '[]'::jsonb)
  FROM user_permissions p JOIN users u ON u.id = p.user_id
 WHERE p.permission = 'usr' AND p.granted AND u.role_id <> 'admin';

DELETE FROM user_permissions p USING users u
 WHERE u.id = p.user_id AND p.permission = 'usr' AND p.granted AND u.role_id <> 'admin';

INSERT INTO system_log(level, event, message, detail)
SELECT 'warn', 'scope_fail_closed',
       count(*) || ' active user(s) of a scoped role have no department/application scope and now see no data until a scope is set in Users',
       jsonb_build_object('usernames', jsonb_agg(u.username ORDER BY u.username))
  FROM users u JOIN roles r ON r.id = u.role_id
 WHERE u.is_active AND NOT r.full_scope AND NOT EXISTS (SELECT 1 FROM user_scopes s WHERE s.user_id = u.id)
HAVING count(*) > 0;
