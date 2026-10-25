-- ETS 1.12.29 — ALERT messages («تنبيه») and a response status. Extends the in-app messaging of 1.12.26 (026).
-- An ALERT is a special message kind: it pops up as a MANDATORY, blocking modal in front of the recipient and
-- requires a structured response (a status + an optional note) before they can keep using the app. The sender needs
-- the same 'msg' permission and the same scope-limited recipient picker as a message. Forward-only and idempotent,
-- like the recent migrations.
--
-- 1) message_broadcasts.kind: 'message' (the existing kind, the default) or 'alert'. A compose action is one or the
--    other; every thread of that broadcast inherits the kind.
-- 2) message_threads: the recipient's structured response to an alert thread —
--    · response_status  'ack' («موافق على التنبيه») or 'working' («أنتظر — أعمل على المنصة»); NULL = not responded.
--    · response_note    an optional free-text note the recipient added with the response (<= 4000, enforced in the service).
--    · responded_at     when the recipient responded.
--    · kind             a DENORMALISED copy of the broadcast's kind on the thread, so the hot "pending mandatory
--      alerts for me" lookup needs no join to message_broadcasts. Kept in step by the service (set at thread
--      creation) and backfilled here for any pre-existing rows.
-- 3) message_threads_pending_alert: a partial index to find a recipient's PENDING mandatory alerts fast — alert
--    threads of this recipient with no response yet.

ALTER TABLE message_broadcasts ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message';
ALTER TABLE message_broadcasts DROP CONSTRAINT IF EXISTS message_broadcasts_kind_check;
ALTER TABLE message_broadcasts ADD CONSTRAINT message_broadcasts_kind_check CHECK (kind IN ('message','alert'));

ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'message';
ALTER TABLE message_threads DROP CONSTRAINT IF EXISTS message_threads_kind_check;
ALTER TABLE message_threads ADD CONSTRAINT message_threads_kind_check CHECK (kind IN ('message','alert'));
ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS response_status text;
ALTER TABLE message_threads DROP CONSTRAINT IF EXISTS message_threads_response_status_check;
ALTER TABLE message_threads ADD CONSTRAINT message_threads_response_status_check
  CHECK (response_status IS NULL OR response_status IN ('ack','working'));
ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS response_note text;
ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS responded_at timestamptz;

-- backfill the denormalised kind for any thread created before this migration (all of which are plain messages,
-- but keep it in step with the broadcast in case a future kind is added)
UPDATE message_threads t SET kind = b.kind
  FROM message_broadcasts b WHERE t.broadcast_id = b.id AND t.kind <> b.kind;

-- a recipient's pending mandatory alerts: alert threads addressed to them with no response yet
CREATE INDEX IF NOT EXISTS message_threads_pending_alert ON message_threads(recipient_id, last_post_at)
  WHERE kind = 'alert' AND response_status IS NULL;
