-- ETS — two new VIEW permissions for the dashboard charts (project phases progress feature).
--
--   erp_view — may see the system-modules wheel and its figures (the ERP wheel that has always been on the dashboard).
--   prj_view — may see the project-phases wheel and its figures (the new project progress chart).
--
-- Default behaviour is chosen through the ROLE permission arrays so that existing users keep working without any
-- per-user change:
--   · erp_view is granted to EVERY role, so everyone who sees the ERP wheel today keeps seeing it.
--   · prj_view is granted only to roles that already hold 'cfg' OR 'apv_final' (the project managers / administrators),
--     who own the project-phases settings.
--
-- Idempotent and forward-only: each grant is a set-union that only adds the permission when it is missing, and the
-- WHERE clause skips roles that already have it (so re-running changes nothing). Per-user overrides (user_permissions)
-- are untouched. seed.js carries the same grants, so a fresh database matches this migration.

UPDATE roles
  SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['erp_view']) AS p)
  WHERE NOT ('erp_view' = ANY(permissions));

UPDATE roles
  SET permissions = (SELECT array_agg(DISTINCT p) FROM unnest(permissions || ARRAY['prj_view']) AS p)
  WHERE NOT ('prj_view' = ANY(permissions))
    AND ('cfg' = ANY(permissions) OR 'apv_final' = ANY(permissions));
