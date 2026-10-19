-- ETS 1.8.0 — item type: each item of an application is a function or a report.
--
-- Some items of the catalog are reports rather than functions. functions.item_type says which:
--   'function'  counted in the application's functions % (every existing and new item, unless marked otherwise)
--   'report'    counted in the application's reports %, together with the application's reports track (app_reports,
--               non-base departments) as one more item of weight 1 — see services/calc.js
-- The default keeps every existing item a function, so an upgrade changes no percentage: figures move only for the
-- items someone marks as reports afterwards (PATCH /tracker/functions/:id, the bulk "set type", add-function).
-- A change of type is an edit like the others: permission 'tog', audited, sent to the team lead when
-- approval.edits_need_lead is on (edit_request_items.field = 'item_type').

ALTER TABLE functions ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'function';

ALTER TABLE functions DROP CONSTRAINT IF EXISTS functions_item_type_check;
ALTER TABLE functions ADD CONSTRAINT functions_item_type_check CHECK (item_type IN ('function','report'));

COMMENT ON COLUMN functions.item_type IS 'function | report (1.8.0): which part of the application % the item counts in';
