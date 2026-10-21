// The stream of lib/live.ts, read with sse.js (exact version in package.json; Apache-2.0): a small Server-Sent Events
// client on XMLHttpRequest. React Native has no EventSource; its XMLHttpRequest delivers the response text as it
// arrives (incremental "progress" events), on the same native networking and cookie store as fetch (Android: OkHttp
// with CookieManager, iOS: NSURLSession with NSHTTPCookieStorage), so the stream carries the session cookie
// __Host-ets_sid like every other request — no server change. sse.js's own reconnection is off: lib/live.ts decides
// when to reconnect (backoff, fallback to polling, 401).
import { SSE } from 'sse.js';
import { eventData } from '@/shared/web';
import type { Connect, LiveEventType } from './live';

type SseEvent = { data?: string; responseCode?: number; readyState?: number };
type SseSource = {
  addEventListener: (type: string, fn: (e: SseEvent) => void) => void;
  stream: () => void;
  close: () => void;
  xhr: { status?: number } | null;
};
type SseCtor = new (url: string, options: Record<string, unknown>) => SseSource;

const EVENTS: LiveEventType[] = ['tracker_changed', 'notif_changed', 'session_ended'];
const CLOSED = 2;

/** A Connect for lib/live.ts on <server>/api/events. */
export function sseConnect(url: string, Impl: SseCtor = SSE as unknown as SseCtor): Connect {
  return h => {
    const s = new Impl(url, {
      headers: { Accept: 'text/event-stream', 'X-Requested-With': 'ets' },
      withCredentials: true,         // the session cookie
      autoReconnect: false,
      start: false,
    });
    let done = false;
    const fail = (status: number) => {
      if (done) return;
      done = true;
      try { s.close(); } catch { /* already closed */ }
      h.onError(status);
    };
    s.addEventListener('ready', () => { if (!done) h.onReady(); });
    for (const type of EVENTS) {
      s.addEventListener(type, e => {
        if (done) return;
        if (type === 'session_ended') done = true;      // the server ends the response right after
        h.onEvent(type, eventData(e.data));
      });
    }
    // an error answer (401 not signed in, 429 too many streams, 503…) or a lost connection
    s.addEventListener('error', e => fail(e.responseCode || s.xhr?.status || 0));
    // the server (or a proxy) ended the stream: reconnect like after an error
    s.addEventListener('readystatechange', e => { if (e.readyState === CLOSED) fail(s.xhr?.status || 0); });
    s.stream();
    return { close: () => { done = true; try { s.close(); } catch { /* already closed */ } } };
  };
}
