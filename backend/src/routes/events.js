// GET /api/events — live updates as Server-Sent Events (services/live.js).
// Signed-in users only; at most LIVE_MAX_STREAMS_PER_USER open streams per user (per API process).
// The stream carries "something changed" events only; the screens reload their data through the scoped endpoints.
import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { logAccess } from '../services/logs.js';
import { addStream, listening, streamCount } from '../services/live.js';
import { HttpError } from '../utils/http.js';

const r = Router();

r.get('/', requireAuth, async (req, res) => {
  try { await listening(); } catch { throw new HttpError(503, 'live_unavailable'); }
  // checked after the await, so that parallel requests cannot pass it together
  if (streamCount(req.user.id) >= config.live.maxStreamsPerUser) {
    throw new HttpError(429, 'too_many_streams', { max: config.live.maxStreamsPerUser });
  }
  if (req.socket.destroyed) return;
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',        // nginx: do not buffer this response
  });
  res.flushHeaders();
  // the access log records the opening of the stream (status 200), not its end nor the heartbeats
  res.locals.accessLogged = true;
  logAccess(req, res, 0);
  const done = addStream(res, { sessionId: req.session.id, user: req.user });
  req.on('close', done);
  res.write('retry: 5000\n\n');
  res.write('event: ready\ndata: {"type":"ready"}\n\n');
});

export default r;
