// Live updates over the server's Server-Sent Events stream GET /api/events (backend routes/events.js,
// services/live.js), with the session cookie — the same stream and the same rules as the website (frontend/src/lib/
// live.js; timings in the shared lib/liveRules.js):
//   - one stream for the app, open while at least one screen listens (kept IDLE_CLOSE_MS across navigation);
//   - several events in a row → one reload per screen (debounced, DEBOUNCE_MS: subscribeDebounced);
//   - paused while the app is in the background; on return the screens reload once and the stream reopens;
//   - lost connection → reconnect with backoff (1, 2, 4 … 60 s); after FALLBACK_AFTER failures in a row the screens
//     also reload every POLL_MS until the stream works again;
//   - "session_ended" (signed out, expired, revoked), or a 401 answer → the app's sign-in check runs.
// The server says only that something changed (department / application ids as hints); the screens reload through
// their usual endpoints with X-ETS-Live: 1, so an open screen never keeps an idle session alive.
// This file has no React Native import: the stream itself is a Connect function (lib/liveSse.ts uses sse.js), so the
// rules are unit-tested with fake timers (__tests__/live.test.ts).
import { LIVE, backoffMs, passesFilter, type LiveMsg, type Severity } from '@/shared/web';

export type LiveStatus = 'off' | 'connecting' | 'live' | 'polling';
export type NotifSummary = { unread: number; top_severity: Severity | null };
export type LiveEventType = 'tracker_changed' | 'notif_changed' | 'session_ended';
export type StreamHandlers = {
  onReady: () => void;
  onEvent: (type: LiveEventType, data: Record<string, unknown> | null) => void;
  /** the stream failed or ended; status = the HTTP status when there was an answer, else 0 */
  onError: (status: number) => void;
};
export type Stream = { close: () => void };
export type Connect = (h: StreamHandlers) => Stream;

type Options = {
  connect: Connect;
  /** is the app in the foreground? (no stream in the background) */
  isActive: () => boolean;
  /** the session may have ended: re-read it (lib/session.tsx) */
  onSessionEnded: () => void;
};

export class LiveClient {
  status: LiveStatus = 'off';
  failures = 0;
  private o: Options;
  private listeners = new Set<(m: LiveMsg) => void>();
  private notifListeners = new Set<(d: NotifSummary) => void>();
  private statusListeners = new Set<(s: LiveStatus) => void>();
  private stream: { s: Stream | null } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedOnce = false;
  private destroyed = false;

  constructor(o: Options) { this.o = o; }

  private setStatus(s: LiveStatus) {
    if (s === this.status) return;
    this.status = s;
    this.statusListeners.forEach(f => f(s));
  }
  private emit(msg: LiveMsg) {
    this.listeners.forEach(f => { try { f(msg); } catch { /* a screen's handler */ } });
  }
  private stopPolling() { if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; } }
  private startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { if (this.o.isActive()) this.emit({ reason: 'poll' }); }, LIVE.POLL_MS);
    this.setStatus('polling');
  }
  private closeStream() {
    const cur = this.stream;
    this.stream = null;
    if (cur?.s) { try { cur.s.close(); } catch { /* already closed */ } }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private open() {
    if (this.stream || this.destroyed || !this.o.isActive() || !this.listeners.size) return;
    if (!this.pollTimer) this.setStatus('connecting');
    const token: { s: Stream | null } = { s: null };
    this.stream = token;
    const mine = () => this.stream === token;
    const handlers: StreamHandlers = {
      onReady: () => {
        if (!mine()) return;
        this.failures = 0;
        this.stopPolling();
        this.setStatus('live');
        // events may have been missed while the stream was down: reload once
        if (this.connectedOnce) this.emit({ reason: 'reconnect' });
        this.connectedOnce = true;
      },
      onEvent: (type, d) => {
        if (!mine()) return;
        if (type === 'tracker_changed') {
          this.emit({ reason: 'change', dept_id: typeof d?.dept_id === 'string' ? d.dept_id : undefined, app_id: typeof d?.app_id === 'string' ? d.app_id : undefined });
        } else if (type === 'notif_changed') {
          if (d && typeof d.unread === 'number') {
            const sum = { unread: d.unread, top_severity: (d.top_severity ?? null) as Severity | null };
            this.notifListeners.forEach(f => { try { f(sum); } catch { /* a handler */ } });
          }
        } else if (type === 'session_ended') {
          this.closeStream();
          this.setStatus('off');
          this.o.onSessionEnded();
        }
      },
      onError: status => {
        if (!mine()) return;
        this.closeStream();
        if (status === 401) this.o.onSessionEnded();
        this.failures++;
        if (this.failures >= LIVE.FALLBACK_AFTER) this.startPolling();
        else this.setStatus('connecting');
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open(); }, backoffMs(this.failures));
      },
    };
    try {
      const s = this.o.connect(handlers);
      if (mine()) token.s = s; else s.close();      // it may have failed at once (retry already scheduled)
    } catch {
      handlers.onError(0);
    }
  }

  /** The app came to the foreground (true) or went to the background (false). */
  setActive(active: boolean) {
    if (this.destroyed || !this.listeners.size) return;
    if (!active) { this.closeStream(); this.stopPolling(); this.setStatus('off'); return; }
    this.emit({ reason: 'visible' });             // whatever changed while in the background
    this.failures = Math.min(this.failures, LIVE.FALLBACK_AFTER - 1);
    this.open();
  }

  /** fn(msg) on every change / reconnect / return to the foreground / poll; returns the unsubscribe function. */
  subscribe(fn: (m: LiveMsg) => void) {
    this.listeners.add(fn);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.open();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size || this.destroyed) return;
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.listeners.size) return;
        this.closeStream(); this.stopPolling(); this.setStatus('off'); this.connectedOnce = false; this.failures = 0;
      }, LIVE.IDLE_CLOSE_MS);
    };
  }

  /** onChange (debounced) when tracker data may have changed; filter(msg) → false skips an event of another place. */
  subscribeDebounced(onChange: (m: LiveMsg) => void, filter?: () => ((m: LiveMsg) => boolean) | null | undefined) {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = this.subscribe(msg => {
      if (!passesFilter(msg, filter?.())) return;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; onChange(msg); }, LIVE.DEBOUNCE_MS);
    });
    return () => { if (t) clearTimeout(t); off(); };
  }

  /** The bell: onCount on every "notif_changed"; onResync when events may have been missed (reconnect, foreground, poll). */
  subscribeNotif(onCount: (d: NotifSummary) => void, onResync: () => void) {
    this.notifListeners.add(onCount);
    const off = this.subscribe(msg => { if (msg.reason !== 'change') onResync(); });
    return () => { this.notifListeners.delete(onCount); off(); };
  }

  onStatus(fn: (s: LiveStatus) => void) {
    this.statusListeners.add(fn);
    return () => { this.statusListeners.delete(fn); };
  }

  /** Signed out / another server / the provider unmounted: the stream and the timers stop. */
  destroy() {
    this.destroyed = true;
    this.closeStream(); this.stopPolling();
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this.setStatus('off');
  }
  /** The provider is mounted again (React's development double mount): start where it was. */
  revive() {
    if (!this.destroyed) return;
    this.destroyed = false;
    this.connectedOnce = false;
    this.failures = 0;
    this.open();
  }
}
