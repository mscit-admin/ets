-- ETS 0.4.0 — per-department imports with two-step approval, and project roles.
--
-- A team sends the JSON exported from the original tracker page. The file contains every department;
-- the uploader chooses what to import:
--   target 'department' → one department's functions and application weights (department_id set)
--   target 'reports'    → the reports track of the departments in the uploader's scope (department_id null)
-- Only that part of the file is compared with the approved data. The differences
-- are stored as a pending batch; nothing changes in the approved results until the batch is approved by
--   1) the department team lead (permission apv_dept, scope must include the department), and
--   2) the project manager or the technical project manager (permission apv_final),
-- two different people, in any order. Then the changes are applied in one transaction and audited.

CREATE TABLE import_batches (
  id              serial PRIMARY KEY,
  target          text NOT NULL DEFAULT 'department' CHECK (target IN ('department','reports')),
  department_id   text REFERENCES departments(id),
  departments     text[] NOT NULL DEFAULT '{}',  -- departments touched (scope checks and approval)
  filename        text,
  file_ts         timestamptz,                  -- export time written in the file (ts)
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','applied','rejected','superseded','no_changes')),
  change_count    integer NOT NULL DEFAULT 0,
  summary         jsonb,                        -- counts and % before/after (department, applications, project)
  uploaded_by     integer REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at     timestamptz NOT NULL DEFAULT now(),
  lead_by         integer REFERENCES users(id) ON DELETE SET NULL,
  lead_at         timestamptz,
  lead_note       text,
  final_by        integer REFERENCES users(id) ON DELETE SET NULL,
  final_at        timestamptz,
  final_note      text,
  rejected_by     integer REFERENCES users(id) ON DELETE SET NULL,
  rejected_at     timestamptz,
  reject_reason   text,
  applied_at      timestamptz,
  apply_result    jsonb                         -- applied / skipped (value changed meanwhile)
);
CREATE INDEX ON import_batches(status, target, department_id);
CREATE INDEX ON import_batches(uploaded_at DESC);

-- One row per changed field.
--   kind: function | report | weight
CREATE TABLE import_changes (
  id          bigserial PRIMARY KEY,
  batch_id    integer NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('function','report','weight')),
  app_id      text NOT NULL REFERENCES applications(id),
  function_id integer REFERENCES functions(id) ON DELETE CASCADE,
  code        text,
  field       text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  applied     boolean,                          -- null until applied; false = skipped (conflict)
  note        text
);
CREATE INDEX ON import_changes(batch_id);

-- New roles. Approval permissions: apv_dept (department team lead), apv_final (PM / technical manager).
INSERT INTO roles(id, name_ar, name_en, description_ar, description_en, full_scope, permissions) VALUES
 ('pm', 'مدير المشروع', 'Project Manager',
  'كل الإدارات: متابعة وتعديل واستيراد، والاعتماد النهائي لنتائج الإدارات',
  'All departments: tracking, editing, imports, and final approval of department results',
  true, '{pct,wgt,tst,tog,sch,rep,exp,imp,log,apv_final}'),
 ('tm', 'المدير الفني للمشروع', 'Technical Project Manager',
  'كل الإدارات: متابعة وتعديل واستيراد، والاعتماد النهائي لنتائج الإدارات',
  'All departments: tracking, editing, imports, and final approval of department results',
  true, '{pct,wgt,tst,tog,sch,rep,exp,imp,log,apv_final}'),
 ('lead', 'رئيس فريق إدارة', 'Department Team Lead',
  'إدارته فقط: التعديل والاستيراد واعتماد نتائج فريقه (الاعتماد الأول)',
  'Own department: editing, imports and first approval of the team''s results',
  false, '{pct,tst,tog,rep,exp,imp,log,apv_dept}'),
 ('member', 'عضو فريق', 'Team Member',
  'إدارته فقط: تحديث الإنجاز والاختبار والتقارير ورفع ملفات النتائج للاعتماد',
  'Own department: progress, testing, reports, and uploading result files for approval',
  false, '{pct,tst,rep,imp}')
ON CONFLICT (id) DO NOTHING;
