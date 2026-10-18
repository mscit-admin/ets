// Live updates: one EventSource per browser tab on GET /api/events (backend/src/services/live.js).
//
// The server only says "tracker data changed" (with department / application ids as hints, never values);
// the screens then reload through their usual, scoped endpoints. Behaviour:
//   - shared by every screen of the tab, opened while at least one screen listens (kept 3 s across navigation);
//   - several events in a row → one reload (debounced, DEBOUNCE_MS);
//   - paused while the tab is hidden; on return the screens reload once and the stream reopens;
//   - lost connection → reconnect with backoff (1, 2, 4 … 60 s); after FALLBACK_AFTER failures in a row the
//     screens also reload every POLL_MS until the stream works again;
//   - "session_ended" (signed out, expired, revoked) → the app's sign-in check runs.
// Reloads send X-ETS-Live: 1 so they do not count as user activity for the idle timeout.
import { useEffect, useRef, useState } from 'react';
import { notifyUnauthorized } from './api.js';

const DEBOUNCE_MS = 400;
const POLL_MS = 30_000;
const FALLBACK_AFTER = 3;
const MAX_BACKOFF_MS = 60_000;
const IDLE_CLOSE_MS = 3000;

const listeners = new Set();        // fn({ reason, dept_id?, app_id? })
const statusListeners = new Set();
let es = null, status = 'off';      // off | connecting | live | polling
let failures = 0, retryTimer = null, pollTimer = null, idleTimer = null, connectedOnce = false;

const setStatus = s => { if (s !== status) { status = s; statusListeners.forEach(f => f(s)); } };
const emit = msg => listeners.forEach(f => { try { f(msg); } catch { /* a screen's handler */ } });
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => { if (!hidden()) emit({ reason: 'poll' }); }, POLL_MS);
  setStatus('polling');
}

function close() {
  if (es) { es.onopen = es.onerror = null; es.close(); es = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
}

function open() {
  if (es || typeof EventSource === 'undefined' || hidden() || !listeners.size) return;
  if (!pollTimer) setStatus('connecting');
  const s = new EventSource('/api/events', { withCredentials: true });
  es = s;
  s.addEventListener('ready', () => {
    failures = 0; stopPolling(); setStatus('live');
    // events may have been missed while the stream was down: reload once
    if (connectedOnce) emit({ reason: 'reconnect' });
    connectedOnce = true;
  });
  s.addEventListener('tracker_changed', e => {
    let d = {};
    try { d = JSON.parse(e.data); } catch { /* hint only */ }
    emit({ reason: 'change', dept_id: d.dept_id, app_id: d.app_id });
  });
  s.addEventListener('session_ended', () => { close(); setStatus('off'); notifyUnauthorized(); });
  // The browser's own retry is replaced by ours (backoff, fallback to polling, 401/429 answers).
  s.onerror = () => {
    if (es !== s) return;
    close();
    failures++;
    if (failures >= FALLBACK_AFTER) startPolling();
    else setStatus('connecting');
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (failures - 1));
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, wait);
  };
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!listeners.size) return;
    if (hidden()) { close(); stopPolling(); setStatus('off'); return; }
    emit({ reason: 'visible' });            // whatever changed while hidden
    failures = Math.min(failures, FALLBACK_AFTER - 1);
    open();
  });
}

function subscribe(fn) {
  listeners.add(fn);
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  open();
  return () => {
    listeners.delete(fn);
    if (listeners.size) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (listeners.size) return;
      close(); stopPolling(); setStatus('off'); connectedOnce = false; failures = 0;
    }, IDLE_CLOSE_MS);
  };
}

/**
 * Calls onChange() (debounced) whenever tracker data may have changed: an event from the server, the tab
 * becoming visible again, a reconnection, or the 30 s poll when the stream is unavailable.
 * filter(msg) → false skips an event (e.g. another department); messages without ids always pass.
 */
export function useLiveUpdates(onChange, { filter, enabled = true } = {}) {
  const fn = useRef(onChange), flt = useRef(filter);
  fn.current = onChange; flt.current = filter;
  useEffect(() => {
    if (!enabled) return undefined;
    let t = null;
    const off = subscribe(msg => {
      if (msg.reason === 'change' && (msg.dept_id || msg.app_id) && flt.current && !flt.current(msg)) return;
      clearTimeout(t);
      t = setTimeout(() => fn.current(msg), DEBOUNCE_MS);
    });
    return () => { clearTimeout(t); off(); };
  }, [enabled]);
}

/** 'live' | 'connecting' | 'polling' | 'off' — for a small indicator. */
export function useLiveStatus() {
  const [s, setS] = useState(status);
  useEffect(() => { statusListeners.add(setS); setS(status); return () => { statusListeners.delete(setS); }; }, []);
  return s;
}
