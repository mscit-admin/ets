-- ETS 0.6.0 — edits made in the screens by data-entry users wait for the department team lead.
--
-- When a user who is not an approver of the department (team member, editor, tester…) changes a function,
-- runs a bulk set, or edits a report, the change is stored here instead of being applied. Only a team lead
-- of that department (permission apv_dept, scope covering the department) approves or rejects it; the
-- project / technical manager is not needed for this stage. Approvers and system administrators apply
-- their own edits directly. Setting `approval.edits_need_lead` turns the rule on/off.

CREATE TABLE edit_requests (
  id            serial PRIMARY KEY,
  department_id text NOT NULL REFERENCES departments(id),
  app_id        text NOT NULL REFERENCES applications(id),
  kind          text NOT NULL CHECK (kind IN ('function','bulk','report')),
  summary       text,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','applied','rejected','superseded','withdrawn')),
  requested_by  integer REFERENCES users(id) ON DELETE SET NULL,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    integer REFERENCES users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  reason        text,
  apply_result  jsonb
);
CREATE INDEX ON edit_requests(status, department_id);
CREATE INDEX ON edit_requests(requested_by, status);

CREATE TABLE edit_request_items (
  id          bigserial PRIMARY KEY,
  request_id  integer NOT NULL REFERENCES edit_requests(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('function','report')),
  app_id      text NOT NULL REFERENCES applications(id),
  function_id integer REFERENCES functions(id) ON DELETE CASCADE,
  field       text NOT NULL,
  old_value   jsonb,
  new_value   jsonb,
  applied     boolean,
  note        text
);
CREATE INDEX ON edit_request_items(request_id);
CREATE INDEX ON edit_request_items(function_id, field);
