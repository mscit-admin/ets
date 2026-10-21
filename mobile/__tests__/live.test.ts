// Phase 2: the live-updates client (src/lib/live.ts) and its sse.js stream (src/lib/liveSse.ts), with fake timers —
// debounce, reconnect with backoff, fallback to polling, pause in the background, session end, idle close.
import { LiveClient, type StreamHandlers } from '@/lib/live';
import { sseConnect } from '@/lib/liveSse';
import { LIVE, backoffMs, passesFilter, type LiveMsg } from '@/shared/web';

type Fake = { h: StreamHandlers; closed: boolean };

function setup({ active = true } = {}) {
  const streams: Fake[] = [];
  let isActive = active;
  const onSessionEnded = jest.fn();
  const client = new LiveClient({
    connect: h => { const s: Fake = { h, closed: false }; streams.push(s); return { close: () => { s.closed = true; } }; },
    isActive: () => isActive,
    onSessionEnded,
  });
  const last = () => streams[streams.length - 1];
  return { client, streams, last, onSessionEnded, setActive: (v: boolean) => { isActive = v; client.setActive(v); } };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('shared timings (frontend/src/lib/liveRules.js)', () => {
  it('backoff 1, 2, 4 … 60 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(LIVE).toEqual({ DEBOUNCE_MS: 400, POLL_MS: 30000, FALLBACK_AFTER: 3, MAX_BACKOFF_MS: 60000, IDLE_CLOSE_MS: 3000 });
  });
  it('filters only changes with ids', () => {
    const f = (m: LiveMsg) => m.app_id === 'per';
    expect(passesFilter({ reason: 'change', app_id: 'att' }, f)).toBe(false);
    expect(passesFilter({ reason: 'change', app_id: 'per' }, f)).toBe(true);
    expect(passesFilter({ reason: 'change' }, f)).toBe(true);
    expect(passesFilter({ reason: 'reconnect', app_id: 'att' }, f)).toBe(true);
  });
});

describe('LiveClient', () => {
  it('opens one stream for every listener and debounces events into one reload', () => {
    const { client, streams, last } = setup();
    const a = jest.fn(), b = jest.fn();
    client.subscribeDebounced(a);
    client.subscribeDebounced(b, () => m => m.app_id === 'per');
    expect(streams).toHaveLength(1);
    expect(client.status).toBe('connecting');
    last().h.onReady();
    expect(client.status).toBe('live');
    last().h.onEvent('tracker_changed', { app_id: 'per', dept_id: 'hr' });
    jest.advanceTimersByTime(100);
    last().h.onEvent('tracker_changed', { app_id: 'per' });
    last().h.onEvent('tracker_changed', { app_id: 'att' });          // b: another application
    jest.advanceTimersByTime(LIVE.DEBOUNCE_MS - 1);
    expect(a).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenLastCalledWith({ reason: 'change', app_id: 'att', dept_id: undefined });
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenLastCalledWith({ reason: 'change', app_id: 'per', dept_id: undefined });
  });

  it('reconnects with backoff, falls back to polling after 3 failures, and stops polling once live', () => {
    const { client, streams, last } = setup();
    const fn = jest.fn();
    client.subscribe(fn);
    last().h.onReady();                             // connected once, then lost
    last().h.onError(0);
    expect(last().closed).toBe(true);
    expect(client.status).toBe('connecting');
    jest.advanceTimersByTime(999);
    expect(streams).toHaveLength(1);
    jest.advanceTimersByTime(1);                    // 1 s
    expect(streams).toHaveLength(2);
    expect(fn).not.toHaveBeenCalled();
    last().h.onError(503);
    jest.advanceTimersByTime(2000);                 // 2 s
    expect(streams).toHaveLength(3);
    last().h.onError(0);                            // 3rd failure → polling
    expect(client.status).toBe('polling');
    jest.advanceTimersByTime(LIVE.POLL_MS);         // the 4 s retry fired too (stream 4), and one poll
    expect(fn).toHaveBeenCalledWith({ reason: 'poll' });
    expect(streams).toHaveLength(4);
    last().h.onReady();
    expect(client.status).toBe('live');
    expect(client.failures).toBe(0);
    expect(fn).toHaveBeenCalledWith({ reason: 'reconnect' });   // missed events: one reload
    fn.mockClear();
    jest.advanceTimersByTime(LIVE.POLL_MS * 2);
    expect(fn).not.toHaveBeenCalled();             // polling stopped
  });

  it('ignores a stream it already replaced', () => {
    const { client, streams, last } = setup();
    const fn = jest.fn();
    client.subscribe(fn);
    const first = last();
    first.h.onError(0);
    jest.advanceTimersByTime(1000);
    first.h.onEvent('tracker_changed', {});          // a late event of the closed stream
    first.h.onError(0);
    expect(fn).not.toHaveBeenCalled();
    expect(streams).toHaveLength(2);
    expect(client.failures).toBe(1);
  });

  it('pauses in the background and reloads once back', () => {
    const { client, streams, last, setActive } = setup();
    const fn = jest.fn();
    client.subscribe(fn);
    last().h.onReady();
    setActive(false);
    expect(last().closed).toBe(true);
    expect(client.status).toBe('off');
    jest.advanceTimersByTime(LIVE.POLL_MS * 3);
    expect(streams).toHaveLength(1);
    setActive(true);
    expect(fn).toHaveBeenCalledWith({ reason: 'visible' });
    expect(streams).toHaveLength(2);
  });

  it('does not open in the background', () => {
    const { client, streams } = setup({ active: false });
    client.subscribe(jest.fn());
    expect(streams).toHaveLength(0);
  });

  it('session_ended and a 401 answer check the session', () => {
    const { client, last, onSessionEnded, streams } = setup();
    client.subscribe(jest.fn());
    last().h.onEvent('session_ended', null);
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    expect(last().closed).toBe(true);
    expect(client.status).toBe('off');
    jest.advanceTimersByTime(120_000);
    expect(streams).toHaveLength(1);               // no reconnection after a session end
    client.setActive(true);
    last().h.onError(401);
    expect(onSessionEnded).toHaveBeenCalledTimes(2);
  });

  it('passes the unread count to the bell, and asks it to re-read after a gap', () => {
    const { client, last } = setup();
    const count = jest.fn(), resync = jest.fn();
    client.subscribeNotif(count, resync);
    last().h.onReady();
    last().h.onEvent('notif_changed', { unread: 4, top_severity: 'critical' });
    last().h.onEvent('notif_changed', { nothing: true });
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ unread: 4, top_severity: 'critical' });
    last().h.onEvent('tracker_changed', {});
    expect(resync).not.toHaveBeenCalled();
    last().h.onError(0);
    jest.advanceTimersByTime(1000);
    last().h.onReady();
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('closes 3 s after the last listener left, unless one comes back', () => {
    const { client, streams, last } = setup();
    const off = client.subscribe(jest.fn());
    last().h.onReady();
    off();
    jest.advanceTimersByTime(LIVE.IDLE_CLOSE_MS - 1);
    const off2 = client.subscribe(jest.fn());      // navigation: another screen listens
    jest.advanceTimersByTime(10_000);
    expect(last().closed).toBe(false);
    expect(streams).toHaveLength(1);
    off2();
    jest.advanceTimersByTime(LIVE.IDLE_CLOSE_MS);
    expect(last().closed).toBe(true);
    expect(client.status).toBe('off');
  });

  it('destroy stops everything; revive starts again', () => {
    const { client, streams, last } = setup();
    client.subscribe(jest.fn());
    client.destroy();
    expect(last().closed).toBe(true);
    jest.advanceTimersByTime(120_000);
    expect(streams).toHaveLength(1);
    client.revive();
    expect(streams).toHaveLength(2);
  });

  it('a connect that throws counts as a failure', () => {
    const client = new LiveClient({ connect: () => { throw new Error('no xhr'); }, isActive: () => true, onSessionEnded: jest.fn() });
    client.subscribe(jest.fn());
    expect(client.failures).toBe(1);
    expect(client.status).toBe('connecting');
  });
});

describe('sseConnect (sse.js)', () => {
  class FakeSSE {
    static last: FakeSSE;
    listeners: Record<string, ((e: Record<string, unknown>) => void)[]> = {};
    xhr: { status?: number } | null = { status: 200 };
    started = false;
    closed = false;
    constructor(public url: string, public options: Record<string, unknown>) { FakeSSE.last = this; }
    addEventListener(type: string, fn: (e: Record<string, unknown>) => void) { (this.listeners[type] ||= []).push(fn); }
    stream() { this.started = true; }
    close() { this.closed = true; }
    fire(type: string, e: Record<string, unknown> = {}) { (this.listeners[type] || []).forEach(f => f(e)); }
  }
  const handlers = () => ({ onReady: jest.fn(), onEvent: jest.fn(), onError: jest.fn() });

  it('opens <server>/api/events with the cookie and the app header, without its own reconnection', () => {
    const h = handlers();
    sseConnect('https://ets.example.ly/api/events', FakeSSE as never)(h);
    const s = FakeSSE.last;
    expect(s.url).toBe('https://ets.example.ly/api/events');
    expect(s.options).toMatchObject({ withCredentials: true, autoReconnect: false, start: false,
      headers: { Accept: 'text/event-stream', 'X-Requested-With': 'ets' } });
    expect(s.started).toBe(true);
  });

  it('passes the events with their JSON data', () => {
    const h = handlers();
    sseConnect('u', FakeSSE as never)(h);
    const s = FakeSSE.last;
    s.fire('ready', { data: '{"type":"ready"}' });
    s.fire('tracker_changed', { data: '{"type":"tracker_changed","app_id":"per"}' });
    s.fire('notif_changed', { data: 'not json' });
    expect(h.onReady).toHaveBeenCalled();
    expect(h.onEvent).toHaveBeenCalledWith('tracker_changed', { type: 'tracker_changed', app_id: 'per' });
    expect(h.onEvent).toHaveBeenCalledWith('notif_changed', null);
  });

  it('reports an error answer once, with its status', () => {
    const h = handlers();
    sseConnect('u', FakeSSE as never)(h);
    const s = FakeSSE.last;
    s.fire('error', { responseCode: 401 });
    s.fire('readystatechange', { readyState: 2 });
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(401);
    expect(s.closed).toBe(true);
  });

  it('a stream ended by the server is a failure; closing it ourselves is not', () => {
    const h = handlers();
    sseConnect('u', FakeSSE as never)(h);
    FakeSSE.last.xhr = null;
    FakeSSE.last.fire('readystatechange', { readyState: 2 });
    expect(h.onError).toHaveBeenCalledWith(0);

    const h2 = handlers();
    const stream = sseConnect('u', FakeSSE as never)(h2);
    stream.close();
    FakeSSE.last.fire('readystatechange', { readyState: 2 });
    FakeSSE.last.fire('tracker_changed', { data: '{}' });
    expect(h2.onError).not.toHaveBeenCalled();
    expect(h2.onEvent).not.toHaveBeenCalled();
  });

  it('after session_ended the end of the response is not a failure', () => {
    const h = handlers();
    sseConnect('u', FakeSSE as never)(h);
    FakeSSE.last.fire('session_ended', { data: '{"type":"session_ended"}' });
    FakeSSE.last.fire('readystatechange', { readyState: 2 });
    expect(h.onEvent).toHaveBeenCalledWith('session_ended', { type: 'session_ended' });
    expect(h.onError).not.toHaveBeenCalled();
  });
});
