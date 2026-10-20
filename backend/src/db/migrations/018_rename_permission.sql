-- ETS 1.9.2 — renaming an item is its own permission: 'ren' («تعديل اسم البند» / "Rename items").
--
-- Until 1.9.1 a rename (PATCH /tracker/functions/:id with name_ar / name_en and rename_reason) needed 'tog', the
-- permission that also adds, removes, includes and excludes items. From 1.9.2 it needs 'ren' (routes/tracker.js,
-- and services/edits.js for a team member's rename that waits for the team lead). Nothing changes for anyone on
-- upgrade:
-- 1) every role that has 'tog' gets 'ren' too (src/db/seed.js lists it for the same roles, so a fresh install and
--    the seed run at every start agree with this);
-- 2) every per-user override of 'tog' is copied to 'ren' with the same value, so a user whose 'tog' was revoked
--    does not gain rename, and a user granted 'tog' outside their role keeps renaming. Each user concerned gets an
--    audit row with their override list before and after.
-- An administrator can then grant or revoke 'ren' per user in Users (permission overrides).
-- Data only, no schema change; re-runnable without side effects.

UPDATE roles SET permissions = array_append(permissions, 'ren')
 WHERE 'tog' = ANY(permissions) AND NOT 'ren' = ANY(permissions);

INSERT INTO audit_log(username, action, entity, entity_id, summary, old_value, new_value)
SELECT 'system', 'update', 'user', u.id::text, u.username || ': ren override copied from tog (1.9.2)',
       jsonb_build_object('overrides', (SELECT jsonb_agg(jsonb_build_object('permission', o.permission, 'granted', o.granted) ORDER BY o.permission)
                                          FROM user_permissions o WHERE o.user_id = u.id)),
       jsonb_build_object('overrides', (SELECT jsonb_agg(x.e ORDER BY x.e->>'permission')
                                          FROM (SELECT jsonb_build_object('permission', o.permission, 'granted', o.granted) AS e
                                                  FROM user_permissions o WHERE o.user_id = u.id
                                                UNION ALL
                                                SELECT jsonb_build_object('permission', 'ren', 'granted', p.granted)) x))
  FROM user_permissions p JOIN users u ON u.id = p.user_id
 WHERE p.permission = 'tog'
   AND NOT EXISTS (SELECT 1 FROM user_permissions r WHERE r.user_id = p.user_id AND r.permission = 'ren');

INSERT INTO user_permissions(user_id, permission, granted)
SELECT user_id, 'ren', granted FROM user_permissions WHERE permission = 'tog'
ON CONFLICT (user_id, permission) DO NOTHING;
