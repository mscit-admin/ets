// Notes history (migration 031): the append-only log of a function / report item's notes, and the rules around it.
// The single functions.note column is kept as "the current active note" and synced here from the history, so the
// existing "a with-notes status requires a note" rule (routes/tracker.js, services/edits.js) and every other reader
// of functions.note keep working unchanged. Who may act on a note is enforced in routes/tracker.js; this module is
// the shared data layer (insert a note, recompute the active note, resolve the team lead) used by both the new
// note routes and the existing edit paths that write a note.
import { hasPerm, canSeeApp } from '../middleware/auth.js';
import { isAppApprover } from './edits.js';

// A note is "active" (it counts as the item's current note) while it is neither hidden by an approved deletion nor
// rejected by the team lead. The current active note is the most recent active one (newest created_at, then id).
//
// INVARIANT (functions.note, review A2 / DB-1): functions.note always equals the body of this current active note,
// or '' when the item has none. This is an APP-ENFORCED invariant with NO DB backing — no trigger or constraint
// guarantees it; it holds only because this module is the single writer that re-syncs functions.note on every change
// that can move the active note (addNote / syncFunctionNote below, and recordNoteHistory on the edit paths). Any
// future write path that mutates a note/decision/deletion without routing through here would leave functions.note
// stale. The invariant is covered by backend/test/active-note-sync.test.js, which drives the real routes across the
// lifecycle and re-checks it after every mutation against an independent SQL oracle. The DB-level hardening (a
// trigger that recomputes functions.note from function_notes — DB-2/DB-1) is a known, deferred follow-up; until it
// lands, keep every note mutation going through this module and rely on that test to catch drift.
const ACTIVE = `deleted_at IS NULL AND decision IS DISTINCT FROM 'rejected'`;

// The team lead of an item's application decides a note (approve / reject) and approves its deletion: the same
// approver as every other edit of that application (apv_dept + scope — services/edits.js, ETS-SEC-007), plus the
// full-scope approvers who stand above the team lead (project / technical managers with apv_final, and system
// administrators with cfg), exactly as they already act for the department's approvals. app: { id, department_id }.
export const canDecideNote = (user, app) =>
  isAppApprover(user, app) || ((hasPerm(user, 'apv_final') || hasPerm(user, 'cfg')) && canSeeApp(user, app));

// The text of an item's current active note (newest non-deleted, non-rejected), or '' when it has none.
export async function activeNoteText(client, functionId) {
  const r = await client.query(
    `SELECT body FROM function_notes WHERE function_id=$1 AND ${ACTIVE} ORDER BY created_at DESC, id DESC LIMIT 1`,
    [functionId]);
  return r.rows[0]?.body ?? '';
}

// Keep functions.note equal to the item's current active note. Called after any change that can move the active
// note: a new note added, a note approved / rejected, a deletion approved. updated_by records who caused the sync.
export async function syncFunctionNote(client, functionId, userId) {
  const note = await activeNoteText(client, functionId);
  await client.query('UPDATE functions SET note=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [functionId, note, userId]);
  return note;
}

// Append a note to an item's history and make it the current active note (it is the newest). replaces: the id of a
// rejected note this one follows up (the caller has checked it belongs to the same item and is rejected). Returns
// the inserted row. The caller owns the transaction (the note and its audit row commit together).
export async function addNote(client, { functionId, body, authorId, replaces = null }) {
  const row = (await client.query(
    `INSERT INTO function_notes (function_id, body, author_id, replaces) VALUES ($1,$2,$3,$4) RETURNING *`,
    [functionId, body, authorId ?? null, replaces])).rows[0];
  await syncFunctionNote(client, functionId, authorId);
  return row;
}

// Records a note in the history when functions.note is written through an existing edit path (a direct PATCH, or an
// approved edit request — routes/tracker.js, services/edits.js). Only a non-empty note is logged, and only when it
// differs from the item's newest history row, so re-saving the same text or clearing a note adds no row. The newest
// note is already active, so functions.note (set by the edit itself) stays correct; no extra sync is needed.
export async function recordNoteHistory(client, functionId, body, authorId) {
  const text = String(body ?? '').trim();
  if (!text) return null;
  const last = (await client.query(
    'SELECT body FROM function_notes WHERE function_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1', [functionId])).rows[0];
  if (last && last.body === text) return null;
  return (await client.query(
    `INSERT INTO function_notes (function_id, body, author_id) VALUES ($1,$2,$3) RETURNING *`,
    [functionId, text, authorId ?? null])).rows[0];
}

// The full chronological history of an item's notes, oldest first, each with the author's and deciders' names.
export async function noteHistory(client, functionId) {
  return (await client.query(
    `SELECT n.*, au.full_name AS author_name, de.full_name AS decided_by_name,
        dr.full_name AS delete_requested_by_name, dl.full_name AS deleted_by_name
       FROM function_notes n
       LEFT JOIN users au ON au.id=n.author_id
       LEFT JOIN users de ON de.id=n.decided_by
       LEFT JOIN users dr ON dr.id=n.delete_requested_by
       LEFT JOIN users dl ON dl.id=n.deleted_by
      WHERE n.function_id=$1 ORDER BY n.created_at, n.id`, [functionId])).rows;
}
