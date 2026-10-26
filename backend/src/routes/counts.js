// Consolidated badge counts for the signed-in user (1.12.30). One request for the three sidebar badges that the
// web app otherwise fetched separately on every navigation (imports / approvals / messages). Cuts the per-navigation
// request volume to a third and lets the badges refresh from a single call driven by the live stream — important for
// a shared-office deployment where every staff member egresses from one NAT address (see docs/handover/06-Security.md
// and the per-user API rate limiting of 1.12.30). The three parts reuse the exact logic of the existing
// /imports/pending-count, /approvals/pending-count and /messages/unread-count endpoints, which stay for the phone app
// and any direct caller.
import { Router } from 'express';
import { requireAuth, hasPerm } from '../middleware/auth.js';
import { pendingCounts as approvalsCounts } from './approvals.js';
import { pendingCounts as importsCounts } from './imports.js';
import { unreadCount } from '../services/messages.js';

const r = Router();
r.use(requireAuth);

// GET /api/counts → { imports: {awaiting_me, pending}, approvals: {awaiting_me, mine, returned_to_me},
//                     messages: {inbox, replies, pending_alerts, total} }
r.get('/', async (req, res) => {
  const [imports, approvals, messages] = await Promise.all([
    importsCounts(req.user),
    approvalsCounts(req.user),
    unreadCount(req.user.id, hasPerm(req.user, 'msg')),
  ]);
  res.json({ imports, approvals, messages });
});

export default r;
