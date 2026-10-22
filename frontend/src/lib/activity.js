// Idle timeout in the browser (1.12.2). The server is the authority (backend middleware/auth.js): a session ends
// SESSION_IDLE_MINUTES after the last GENUINE user activity, or SESSION_TTL_HOURS after sign-in, and is then refused
// on every request. Only requests carrying X-ETS-Activity: 1 count as activity, and this module is the only place
// the web app sends that header:
//   - real input only: pointerdown, keydown, wheel, touchstart (not mousemove: browsers fire it when content moves
//     under a still pointer, e.g. after a live reload) → POST /api/auth/activity, at most once per PING_EVERY_MS;
//   - everything automatic (data loads, live reloads, presence, the bell, /auth/me checks) carries no such header,
//     so an open screen or a forgotten tab never keeps a session alive;
//   - when this tab has seen no input for the idle limit (or the absolute end is reached) it asks the server
//     (/auth/me, not activity): if another tab of the same browser kept the session alive it waits again, otherwise
//     it signs out on the server (POST /api/auth/logout {reason:'idle'}: session revoked, cookie cleared) and shows
//     the sign-in page with a notice. A sleeping PC or a hidden tab is checked as soon as the tab is visible again.
import { api } from './api.js';

export const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
export const PING_EVERY_MS = 60_000;
const SLACK_MS = 2_000;              // check a little after the deadline (clock rounding)
const MAX_TIMER_MS = 2 ** 31 - 1;    // setTimeout limit

/** When this tab should check: no input for the idle limit, or the absolute end. Times in local ms. */
export function deadline({ lastInput, idleMs, expiresAt }) {
  return Math.min(lastInput + idleMs, expiresAt);
}

/**
 * Starts tracking for a signed-in session. session = /auth/me's `session` ({ idle_minutes, idle_expires_at,
 * expires_at, server_now }). onEnded(reason) is called after the server-side sign-out. Returns stop().
 */
export function startActivityTracker(session, { onEnded, win = window, doc = document } = {}) {
  const skew = new Date(session.server_now).getTime() - Date.now();          // server clock − local clock
  const local = iso => new Date(iso).getTime() - skew;
  const idleMs = session.idle_minutes * 60_000;
  let expiresAt = local(session.expires_at);
  // the server's idle deadline may be earlier than "now + idle" (the page was loaded without any input)
  let lastInput = Math.min(Date.now(), local(session.idle_expires_at) - idleMs);
  let lastPing = 0, timer = null, stopped = false, checking = false;

  const schedule = () => {
    clearTimeout(timer);
    if (stopped) return;
    const wait = Math.max(0, deadline({ lastInput, idleMs, expiresAt }) - Date.now() + SLACK_MS);
    timer = setTimeout(check, Math.min(wait, MAX_TIMER_MS));
  };

  const ping = () => {
    lastPing = Date.now();
    api.post('/auth/activity', {}, { activity: true }).then(t => {
      if (t?.expires_at) expiresAt = local(t.expires_at);
    }).catch(e => { if (e?.status === 401) endSession('ended'); /* else: best effort, the next input tries again */ });
  };

  const onInput = () => {
    if (stopped) return;
    const now = Date.now();
    if (now >= deadline({ lastInput, idleMs, expiresAt })) { check(); return; }   // too late: never revive by input
    lastInput = now;
    if (now - lastPing >= PING_EVERY_MS) ping();
    schedule();
  };

  async function check() {
    if (stopped || checking) return;
    if (Date.now() < deadline({ lastInput, idleMs, expiresAt })) { schedule(); return; }
    checking = true;
    try {
      const m = await api.get('/auth/me', { live: true });              // never activity
      if (stopped) return;
      if (m.authenticated && m.session) {
        const idleEnd = local(m.session.idle_expires_at);
        expiresAt = local(m.session.expires_at);
        // another tab of this browser kept the session alive: wait for its deadline
        if (idleEnd > Date.now() + SLACK_MS && expiresAt > Date.now()) {
          lastInput = Math.max(lastInput, idleEnd - idleMs);
          schedule();
          return;
        }
      }
      await endSession(Date.now() >= expiresAt ? 'expired' : 'idle');
    } catch {
      // network / server error: try again shortly; the server refuses an expired session meanwhile anyway
      if (!stopped) { clearTimeout(timer); timer = setTimeout(check, 15_000); }
    } finally {
      checking = false;
    }
  }

  // reason: 'idle' (no input in this browser for the idle limit), 'expired' (absolute end), 'ended' (the server had
  // already ended it: idle, revoked, signed out elsewhere)
  async function endSession(reason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    // always on the server: the session is revoked (if it is not already) and the cookie cleared
    try { await api.post('/auth/logout', reason === 'idle' ? { reason: 'idle' } : {}); } catch { /* the session is refused by the server anyway */ }
    onEnded?.(reason);
  }

  const onVisible = () => { if (doc.visibilityState === 'visible') check(); };
  for (const e of ACTIVITY_EVENTS) win.addEventListener(e, onInput, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', onVisible);
  win.addEventListener('focus', onVisible);
  schedule();

  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const e of ACTIVITY_EVENTS) win.removeEventListener(e, onInput, { capture: true });
    doc.removeEventListener('visibilitychange', onVisible);
    win.removeEventListener('focus', onVisible);
  };
}
