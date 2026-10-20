-- ETS 1.10.0 — moving a function / report item to another application (possibly of another department).
--
-- 1) Permission 'mov' («نقل البنود» / "Move items"), separate from 'tog' and 'ren'. It is a new capability, so it
--    is not copied from any per-user override: the roles that manage a department's structure get it by default —
--    admin, mgr, pm, tm, lead — and member, ed, qa, obs do not (src/db/seed.js lists the same roles, so a fresh
--    install and the seed run at every start agree with this). An administrator can grant or revoke it per user.
-- 2) function_moves: one row per item moved, kept forever with the item (the item keeps its id; it gets a new
--    "C<n>" code in the destination application). It records where the item came from (application, department,
--    code), where it went, the weight transferred with it (fixed weighting mode) and why. It is also what keeps:
--      - the catalog seed from re-creating a catalog item in the application it was moved out of
--        (from_app_id, from_code) — src/db/seed.js;
--      - the "never reuse a code" guarantee of an application after its highest C-code left (services/functions.js);
--      - the change history readable by the old department up to the move (routes/logs.js).
-- 3) edit_requests: kind 'move_function' — a move that needs approval. It needs the source application's team lead,
--    then the destination application's team lead (one approval when the same person covers both; never the
--    requester). target_app_id / target_department_id name the destination; source_approved_by/at and
--    target_approved_by/at record the two approvals; meta keeps the move reason and the impact shown when it was
--    requested. The request's items: one per item moved (kind 'function', field 'move').

UPDATE roles SET permissions = array_append(permissions, 'mov')
 WHERE id IN ('admin', 'mgr', 'pm', 'tm', 'lead') AND NOT 'mov' = ANY(permissions);

CREATE TABLE IF NOT EXISTS function_moves (
  id           bigserial PRIMARY KEY,
  function_id  integer NOT NULL REFERENCES functions(id) ON DELETE CASCADE,
  from_app_id  text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  to_app_id    text NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_code    text NOT NULL,
  to_code      text NOT NULL,
  from_dept_id text NOT NULL REFERENCES departments(id),
  to_dept_id   text NOT NULL REFERENCES departments(id),
  weight_mode  text NOT NULL CHECK (weight_mode IN ('fixed', 'auto')),
  weight_share numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_share >= 0),    -- application weight moved with the item
  reason       text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  moved_by     integer REFERENCES users(id) ON DELETE SET NULL,
  moved_at     timestamptz NOT NULL DEFAULT now(),
  request_id   integer REFERENCES edit_requests(id) ON DELETE SET NULL,
  CHECK (from_app_id <> to_app_id)
);
CREATE INDEX IF NOT EXISTS function_moves_function ON function_moves(function_id, moved_at);
CREATE INDEX IF NOT EXISTS function_moves_from ON function_moves(from_app_id, from_code);
CREATE INDEX IF NOT EXISTS function_moves_to ON function_moves(to_app_id);

ALTER TABLE edit_requests
  ADD COLUMN IF NOT EXISTS target_app_id        text REFERENCES applications(id),
  ADD COLUMN IF NOT EXISTS target_department_id text REFERENCES departments(id),
  ADD COLUMN IF NOT EXISTS source_approved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS target_approved_by   integer REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS target_approved_at   timestamptz,
  ADD COLUMN IF NOT EXISTS meta                 jsonb;

ALTER TABLE edit_requests DROP CONSTRAINT IF EXISTS edit_requests_kind_check;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_kind_check
  CHECK (kind IN ('function','bulk','report','add_function','remove_function','restore_function','move_function'));
ALTER TABLE edit_requests DROP CONSTRAINT IF EXISTS edit_requests_move_target_check;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_move_target_check
  CHECK ((kind = 'move_function') = (target_app_id IS NOT NULL AND target_department_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS edit_requests_target_pending ON edit_requests(target_app_id) WHERE status = 'pending';
