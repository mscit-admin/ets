-- ETS 1.12.16 — moving an entire application (with all its functions / report items) from one department
-- ("module", الإدارة) to another.
--
-- The application keeps its id, its weight, its functions (each with their id, code, values and provenance) and
-- everything else; only its department_id changes. Because a department's weight is DERIVED (the sum of its
-- applications' weights in fixed mode, or the sum of their counted item weights in auto mode — services/calc.js),
-- the application's weight automatically leaves the source department and joins the destination with it: the source
-- total decreases by the application's weight, the destination increases by it, and the total system weight is
-- unchanged. Nothing on the application or its items is mutated for weight; there is no department weight column and
-- no department weight cap, so no clamping is possible or needed (the invariant holds by construction).
--
-- 1) application_moves: one row per application moved, kept forever (mirrors function_moves). It records where the
--    application came from (department) and went, the application's weight at the time, the weighting mode and why —
--    the «منقول من …» badge, the logs and the audit.
-- 2) edit_requests: kind 'move_application' — a move that needs approval. It needs the SOURCE department's team lead,
--    then the DESTINATION department's team lead (one approval when the same person leads both; never the requester).
--    app_id is the application being moved, department_id its source department, target_department_id the destination
--    (target_app_id stays NULL — a move_application has no destination application). source_approved_by/at and
--    target_approved_by/at (migration 019) record the two approvals; meta keeps the move reason and the impact.
--    Its single item: kind 'application', field 'move' (permission 'mov', like a function move).
--
-- Permission: the existing 'mov' («نقل البنود» / "Move items", migration 019) is reused — no new permission. A
-- regular member granted 'mov' who is not a lead of BOTH departments goes through the two-lead approval; a lead of
-- both departments (or cfg / apv_final, or when approvals are off) moves directly.

CREATE TABLE IF NOT EXISTS application_moves (
  id                 bigserial PRIMARY KEY,
  app_id             text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_department_id text NOT NULL REFERENCES departments(id),
  to_department_id   text NOT NULL REFERENCES departments(id),
  weight_mode        text NOT NULL CHECK (weight_mode IN ('fixed', 'auto')),
  weight             numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight >= 0),   -- the application's weight when it moved
  reason             text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  moved_by           integer REFERENCES users(id) ON DELETE SET NULL,
  moved_at           timestamptz NOT NULL DEFAULT now(),
  request_id         integer REFERENCES edit_requests(id) ON DELETE SET NULL,
  CHECK (from_department_id <> to_department_id)
);
CREATE INDEX IF NOT EXISTS application_moves_app ON application_moves(app_id, moved_at);
CREATE INDEX IF NOT EXISTS application_moves_from ON application_moves(from_department_id);
CREATE INDEX IF NOT EXISTS application_moves_to ON application_moves(to_department_id);

-- A move_application request is a new kind; it carries a destination department but no destination application.
ALTER TABLE edit_requests DROP CONSTRAINT IF EXISTS edit_requests_kind_check;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_kind_check
  CHECK (kind IN ('function','bulk','report','add_function','remove_function','restore_function','move_function','move_application'));

-- move_function: destination application + department; move_application: destination department only; all others: neither.
ALTER TABLE edit_requests DROP CONSTRAINT IF EXISTS edit_requests_move_target_check;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_move_target_check
  CHECK (CASE kind
    WHEN 'move_function'    THEN target_app_id IS NOT NULL AND target_department_id IS NOT NULL
    WHEN 'move_application' THEN target_app_id IS NULL     AND target_department_id IS NOT NULL
    ELSE target_app_id IS NULL AND target_department_id IS NULL END);

CREATE INDEX IF NOT EXISTS edit_requests_target_dept_pending ON edit_requests(target_department_id) WHERE status = 'pending';

-- A move_application request carries one item that represents the application itself (kind 'application', field 'move').
ALTER TABLE edit_request_items DROP CONSTRAINT IF EXISTS edit_request_items_kind_check;
ALTER TABLE edit_request_items ADD CONSTRAINT edit_request_items_kind_check CHECK (kind IN ('function','report','application'));
