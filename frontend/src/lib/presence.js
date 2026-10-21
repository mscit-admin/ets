// Online users (1.11.0): this tab tells the server which screen it is on (POST /api/presence, backend
// services/presence.js) — on every screen change, every 60 s while the tab is visible, and once when the tab becomes
// visible again; nothing while it is hidden. The report carries a screen key and an id only (the server builds the
// label an administrator sees) and X-ETS-Live: 1: it never keeps the session alive (idle timeout).
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from './api.js';

export const HEARTBEAT_MS = 60_000;

const ROUTES = [
  [/^\/$/, 'dashboard'], [/^\/status\/?$/, 'status'], [/^\/weights\/?$/, 'weights'], [/^\/schedule\/?$/, 'schedule'],
  [/^\/reports\/?$/, 'reports'], [/^\/reports\/([^/]+)\/?$/, 'reports_dept'], [/^\/search\/?$/, 'search'],
  [/^\/department\/([^/]+)\/?$/, 'department'], [/^\/app\/([^/]+)\/?$/, 'application'],
  [/^\/imports\/?$/, 'imports'], [/^\/imports\/([^/]+)\/?$/, 'import'], [/^\/approvals\/?$/, 'approvals'],
  [/^\/notifications\/?$/, 'notifications'], [/^\/profile\/?$/, 'profile'],
  [/^\/users\/?$/, 'users'], [/^\/users\/new\/?$/, 'users'], [/^\/users\/([^/]+)\/?$/, 'user'],
  [/^\/online\/?$/, 'online_users'], [/^\/logs\/?$/, 'logs'], [/^\/settings\/?$/, 'settings'],
];
const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** '/app/hr_payroll' → { screen: 'application', ref: 'hr_payroll' }; anything else → { screen: 'unknown' }. */
export function screenOf(pathname) {
  for (const [re, screen] of ROUTES) {
    const m = re.exec(pathname);
    if (!m) continue;
    let ref = null;
    if (m[1] !== undefined) {
      try { ref = decodeURIComponent(m[1]); } catch { ref = null; }
      if (!REF_RE.test(ref ?? '')) return { screen: 'unknown', ref: null };
    }
    return { screen, ref };
  }
  return { screen: 'unknown', ref: null };
}

// what the server accepts as a path: "/" and up to 199 of A–Z a–z 0–9 / _ . ~ % -
const cleanPath = p => (/^\/[A-Za-z0-9/_.~%-]{0,199}$/.test(p) && !p.includes('//') ? p : '/');

/** Reports this tab's screen while signed in (mounted once, in Layout). */
export function usePresenceReporter() {
  const loc = useLocation();
  const where = useRef(null);
  where.current = loc.pathname;
  const send = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const p = where.current || '/';
    api.post('/presence', { path: cleanPath(p), ...screenOf(p) }, { live: true }).catch(() => { /* best effort */ });
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => { sendRef.current(); }, [loc.pathname]);
  useEffect(() => {
    const beat = setInterval(() => sendRef.current(), HEARTBEAT_MS);
    const vis = () => { if (document.visibilityState === 'visible') sendRef.current(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(beat); document.removeEventListener('visibilitychange', vis); };
  }, []);
}
