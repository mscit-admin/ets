-- ETS 1.12.26 — in-app messaging: a privileged user composes a message and sends it to selected recipients
-- (specific individuals, by department, by role, or everyone), and each recipient can reply, forming a private
-- 1:1 back-and-forth conversation with the sender. Forward-only and idempotent, like the recent migrations.
--
-- 1) Permission 'msg' («الرسائل» / "Send messages"). It is a NEW capability — like 'mov' (019) and 'ren' (018) —
--    so it is granted by default to the ADMIN role only and is NOT copied from any per-user override. An
--    administrator can grant it to others (e.g. a department lead) from the Users permission editor. 'msg' grants
--    the ability to SEND within the sender's scope; it never widens who a sender can see (routes/messages.js
--    resolves the audience against the existing canSee / scope model). src/db/seed.js lists it for the admin role
--    too, so a fresh install and the seed run at every start agree with this migration.
-- 2) message_broadcasts: one row per compose action (the sender's "sent" view). audience keeps the chosen recipient
--    selection ({ all?, users?, depts?, roles? }); recipient_count is the number actually resolved (scope-limited).
-- 3) message_threads: one PRIVATE 1:1 conversation per (broadcast × recipient). Even a message sent to "everyone"
--    becomes one thread per recipient, visible only to that recipient and the sender — never broadcast to others.
--    broadcast_id is nullable to allow a future ad-hoc thread. author_read_at / recipient_read_at track each side's
--    read state; last_post_at drives ordering and the unread lookups.
-- 4) message_posts: one row per post (sender OR recipient). The broadcast's initial body is the first post in each
--    thread. Body length is 1..4000, enforced here and in the service.

UPDATE roles SET permissions = array_append(permissions, 'msg')
 WHERE id = 'admin' AND NOT 'msg' = ANY(permissions);

CREATE TABLE IF NOT EXISTS message_broadcasts (
  id              bigserial PRIMARY KEY,
  author_id       integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject         text CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  audience        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { all?, users?:[ids], depts?:[ids], roles?:[ids] }
  recipient_count integer NOT NULL DEFAULT 0 CHECK (recipient_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_broadcasts_author ON message_broadcasts(author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_threads (
  id               bigserial PRIMARY KEY,
  broadcast_id     bigint REFERENCES message_broadcasts(id) ON DELETE CASCADE,
  author_id        integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the sender
  recipient_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- the one recipient
  subject          text CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_post_at     timestamptz NOT NULL DEFAULT now(),
  author_read_at   timestamptz,
  recipient_read_at timestamptz,
  closed_at        timestamptz,
  CHECK (author_id <> recipient_id),
  UNIQUE (broadcast_id, recipient_id)
);
-- a recipient's inbox, newest first; a sender's sent threads; unread lookups per side
CREATE INDEX IF NOT EXISTS message_threads_recipient ON message_threads(recipient_id, last_post_at DESC);
CREATE INDEX IF NOT EXISTS message_threads_author ON message_threads(author_id, last_post_at DESC);
CREATE INDEX IF NOT EXISTS message_threads_broadcast ON message_threads(broadcast_id);
CREATE INDEX IF NOT EXISTS message_threads_recipient_unread ON message_threads(recipient_id)
  WHERE recipient_read_at IS NULL OR recipient_read_at < last_post_at;
CREATE INDEX IF NOT EXISTS message_threads_author_unread ON message_threads(author_id)
  WHERE author_read_at IS NULL OR author_read_at < last_post_at;

CREATE TABLE IF NOT EXISTS message_posts (
  id         bigserial PRIMARY KEY,
  thread_id  bigint NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
  author_id  integer NOT NULL REFERENCES users(id) ON DELETE SET NULL,   -- the poster (sender OR recipient)
  body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_posts_thread ON message_posts(thread_id, created_at, id);

-- The message notifications (M1 message_received, M2 message_reply) add a new 'messages' category: widen the
-- notifications.category CHECK to accept it (migration 017 created the original list).
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_category_check
  CHECK (category IN ('tracking','approvals','plan','messages','security','system'));
