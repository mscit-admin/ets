-- ETS — department-driven ERP wheel (structure phase 3): move the wheel map out of the hardcoded erpModules.js into
-- per-department columns, editable from the structure screen. Each department IS a wheel segment and controls its own
-- appearance:
--   wheel_show      — whether the department is drawn on the ERP wheel (it still counts in the totals when hidden).
--   wheel_icon      — the segment icon (falls back to the department emblem).
--   wheel_label_ar/en — the segment label (falls back to the department short name).
--   wheel_order     — position around the wheel (falls back to the department sort).
--
-- The backfill below reproduces the exact wheel that erpModules.js used to hardcode, so the dashboard looks identical
-- right after the migration. Forward-only and idempotent; seed.js carries the same defaults for a fresh database.

ALTER TABLE departments
  ADD COLUMN IF NOT EXISTS wheel_show     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS wheel_icon     text,
  ADD COLUMN IF NOT EXISTS wheel_label_ar text,
  ADD COLUMN IF NOT EXISTS wheel_label_en text,
  ADD COLUMN IF NOT EXISTS wheel_order    integer;

-- Reproduce the previous hardcoded wheel (STANDARD_MODULES hr/sales/finance, then EXTRA infrastructure). Only applied
-- to the seeded ids and only while they have not been customised yet (wheel_order IS NULL), so a re-run or a later
-- edit is never overwritten.
UPDATE departments SET wheel_icon='people',    wheel_label_ar='الموارد البشرية',   wheel_label_en='Human Resources',     wheel_order=1 WHERE id='hr'  AND wheel_order IS NULL;
UPDATE departments SET wheel_icon='megaphone', wheel_label_ar='المبيعات والتسويق', wheel_label_en='Sales & Marketing',   wheel_order=2 WHERE id='com' AND wheel_order IS NULL;
UPDATE departments SET wheel_icon='coins',     wheel_label_ar='المالية والمحاسبة', wheel_label_en='Finance & Accounting', wheel_order=3 WHERE id='fin' AND wheel_order IS NULL;
UPDATE departments SET wheel_icon='server',    wheel_label_ar='البنية التحتية',    wheel_label_en='Infrastructure',      wheel_order=4 WHERE id='inf' AND wheel_order IS NULL;
