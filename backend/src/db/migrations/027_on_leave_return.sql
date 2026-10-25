-- ETS 1.12.28 — rejecting a lead's edit-request approval RETURNS it to the requester (or, when the requester is on
-- leave, to their pre-assigned substitute) for revision / resubmission, instead of closing it as a dead reject.
-- Forward-only and idempotent, like the recent migrations.
--
-- 1) users: who is away and who stands in for them, both set by an administrator on the user page.
--    · on_leave          «في إجازة» — the account is currently on leave (set by an admin).
--    · leave_from / leave_to  optional window; when both are null the leave has no fixed dates. A returned request
--      routes to the substitute only while on_leave is true AND (if a bound is set) today is within [from, to].
--    · substitute_user_id  «البديل» — the pre-assigned stand-in who may act on a returned request on the user's
--      behalf. FK to users(id), ON DELETE SET NULL (deleting the substitute simply clears the link), and a CHECK
--      that nobody is their own substitute.
-- 2) edit_requests: the new 'returned' status plus where/why it went.
--    · status gains 'returned' — a request a lead sent back; it is no longer pending (out of the approvers' queue)
--      but not closed either: the requester / substitute can resubmit it (→ pending) or withdraw it. The existing
--      statuses are kept exactly; nothing is remapped.
--    · returned_reason   the lead's reason (required at return; 3–500 chars, enforced in the service).
--    · returned_at       when it was returned.
--    · returned_to       the user who should now act on it: the requester, or their substitute when on leave.
-- 3) an index for the "requests returned to me" lookup (returned_to while status='returned').

ALTER TABLE users ADD COLUMN IF NOT EXISTS on_leave boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS leave_from date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS leave_to date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS substitute_user_id integer REFERENCES users(id) ON DELETE SET NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_substitute_not_self') THEN
    ALTER TABLE users ADD CONSTRAINT users_substitute_not_self CHECK (substitute_user_id IS NULL OR substitute_user_id <> id);
  END IF;
END $$;

ALTER TABLE edit_requests ADD COLUMN IF NOT EXISTS returned_reason text;
ALTER TABLE edit_requests ADD COLUMN IF NOT EXISTS returned_at timestamptz;
ALTER TABLE edit_requests ADD COLUMN IF NOT EXISTS returned_to integer REFERENCES users(id) ON DELETE SET NULL;

-- Widen the status CHECK to accept 'returned' (migration 001/004 created the original list). Drop the old constraint
-- (whatever its generated name) and add the new one by a stable name, both idempotently.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'edit_requests'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE edit_requests DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE edit_requests ADD CONSTRAINT edit_requests_status_check
  CHECK (status IN ('pending','applied','rejected','returned','superseded','withdrawn'));

CREATE INDEX IF NOT EXISTS edit_requests_returned_to ON edit_requests(returned_to) WHERE status = 'returned';
