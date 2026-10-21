// Presence for the administrators' «Online users» page (server 1.11.0): POST /api/presence { path, screen, ref? } with
// the session cookie, X-ETS-Live: 1 (not user activity) and X-ETS-Client: mobile — on each screen change (a burst of
// changes within MIN_GAP_MS sends once, the last screen), every BEAT_MS while the app is in the foreground, nothing in
// the background. Answers are ignored (202, 429…); a 404 (a server without the endpoint) turns presence off until the
// next app start. A 401 is handled by the API client like any other request (the session really ended).
// No React here: PresenceReporter is unit-tested with fake timers (__tests__/presence.test.ts).

export const BEAT_MS = 60_000;
export const MIN_GAP_MS = 2_000;

export type Screen = 'dashboard' | 'department' | 'application' | 'notifications' | 'profile' | 'approvals' | 'unknown';
export type Presence = { path: string; screen: Screen; ref?: string };

const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The screen of an expo-router path (/home, /home/department/hr, /home/app/per, /notifications, /profile, /approvals). */
export function screenOf(pathname: string): Presence {
  const parts = pathname.split(/[?#]/)[0].split('/').filter(Boolean);
  const path = '/' + parts.join('/');
  if (parts[0] === 'home' && parts.length === 1) return { path, screen: 'dashboard' };
  if (parts[0] === 'home' && parts[1] === 'department' && ID.test(parts[2] ?? '')) return { path, screen: 'department', ref: parts[2] };
  if (parts[0] === 'home' && parts[1] === 'app' && ID.test(parts[2] ?? '')) return { path, screen: 'application', ref: parts[2] };
  if (parts.length === 1 && ['notifications', 'profile', 'approvals'].includes(parts[0])) return { path, screen: parts[0] as Screen };
  return { path, screen: 'unknown' };
}

// a server without the endpoint: off until the app starts again (module state outlives a sign-out / sign-in)
let unsupported = false;
export const presenceSupported = () => !unsupported;
export const resetPresenceSupport = () => { unsupported = false; };      // tests

type Send = (p: Presence) => Promise<unknown>;

export class PresenceReporter {
  private send: Send;
  private current: Presence | null = null;
  private active: boolean;
  private beat: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private lastSent = -Infinity;
  private stopped = false;

  constructor(send: Send, active = true) { this.send = send; this.active = active; }

  private post() {
    if (!this.current || !this.active || this.stopped || unsupported) return;
    this.lastSent = Date.now();
    this.send(this.current).catch((e: { status?: number }) => {
      if (e?.status === 404) { unsupported = true; this.stopBeat(); }
    });
  }
  private stopBeat() { if (this.beat) { clearInterval(this.beat); this.beat = null; } }
  private startBeat() {
    this.stopBeat();
    if (this.active && !this.stopped && !unsupported) this.beat = setInterval(() => this.post(), BEAT_MS);
  }
  /** at once, or at the end of the MIN_GAP_MS since the last one (the latest screen) */
  private soon() {
    if (this.pending) return;
    const wait = this.lastSent + MIN_GAP_MS - Date.now();
    if (wait <= 0) { this.post(); this.startBeat(); return; }
    this.pending = setTimeout(() => { this.pending = null; this.post(); this.startBeat(); }, wait);
  }

  /** the user opened this screen */
  screen(p: Presence) {
    if (this.current && this.current.path === p.path) return;
    this.current = p;
    this.soon();
  }
  /** the app came to the foreground (true) or went to the background (false) */
  setActive(active: boolean) {
    if (active === this.active) return;
    this.active = active;
    if (!active) {
      this.stopBeat();
      if (this.pending) { clearTimeout(this.pending); this.pending = null; }
      return;
    }
    this.soon();
  }
  stop() {
    this.stopped = true;
    this.stopBeat();
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
  }
}
