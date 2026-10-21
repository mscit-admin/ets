// Presence reports (src/lib/presence.ts) with fake timers: screen keys, one report per burst of screen changes, the
// 60 s beat in the foreground only, answers ignored, a 404 turning presence off until the next start.
import { ApiError, createApi } from '@/lib/api';
import { BEAT_MS, MIN_GAP_MS, PresenceReporter, presenceSupported, resetPresenceSupport, screenOf } from '@/lib/presence';

beforeEach(() => { jest.useFakeTimers(); resetPresenceSupport(); });
afterEach(() => jest.useRealTimers());
const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('screen keys', () => {
  it('maps the app routes', () => {
    expect(screenOf('/home')).toEqual({ path: '/home', screen: 'dashboard' });
    expect(screenOf('/home/department/hr')).toEqual({ path: '/home/department/hr', screen: 'department', ref: 'hr' });
    expect(screenOf('/home/app/per?fn=3')).toEqual({ path: '/home/app/per', screen: 'application', ref: 'per' });
    expect(screenOf('/notifications').screen).toBe('notifications');
    expect(screenOf('/profile').screen).toBe('profile');
    expect(screenOf('/approvals').screen).toBe('approvals');
    expect(screenOf('/home/app/../x').screen).toBe('unknown');
    expect(screenOf('/somewhere').screen).toBe('unknown');
  });
});

describe('PresenceReporter', () => {
  it('reports a screen change at once, then a burst once (the last screen)', () => {
    const send = jest.fn(async () => ({}));
    const r = new PresenceReporter(send);
    r.screen(screenOf('/home'));
    expect(send).toHaveBeenCalledTimes(1);
    r.screen(screenOf('/home/department/hr'));
    r.screen(screenOf('/home/app/per'));
    r.screen(screenOf('/home/app/per'));               // same screen: nothing
    expect(send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(MIN_GAP_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({ path: '/home/app/per', screen: 'application', ref: 'per' });
  });

  it('beats every 60 s in the foreground, pauses in the background, reports again on return', () => {
    const send = jest.fn(async () => ({}));
    const r = new PresenceReporter(send);
    r.screen(screenOf('/profile'));
    jest.advanceTimersByTime(BEAT_MS * 2);
    expect(send).toHaveBeenCalledTimes(3);
    r.setActive(false);
    jest.advanceTimersByTime(BEAT_MS * 5);
    r.screen(screenOf('/notifications'));                // a change while in the background is not sent…
    expect(send).toHaveBeenCalledTimes(3);
    r.setActive(true);                                   // …but on return
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenLastCalledWith({ path: '/notifications', screen: 'notifications' });
    jest.advanceTimersByTime(BEAT_MS);
    expect(send).toHaveBeenCalledTimes(5);
    r.stop();
    jest.advanceTimersByTime(BEAT_MS * 3);
    expect(send).toHaveBeenCalledTimes(5);
  });

  it('ignores 202 / 429 / network answers', async () => {
    const send = jest.fn(async () => { throw new ApiError(429, 'too_many_requests'); });
    const r = new PresenceReporter(send);
    r.screen(screenOf('/home'));
    await flush();
    jest.advanceTimersByTime(BEAT_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(presenceSupported()).toBe(true);
  });

  it('a 404 turns presence off until the next start', async () => {
    const send = jest.fn(async () => { throw new ApiError(404, 'not_found'); });
    const r = new PresenceReporter(send);
    r.screen(screenOf('/home'));
    await flush();
    expect(presenceSupported()).toBe(false);
    jest.advanceTimersByTime(BEAT_MS * 3);
    r.screen(screenOf('/profile'));
    jest.advanceTimersByTime(MIN_GAP_MS);
    new PresenceReporter(send).screen(screenOf('/home'));     // signed in again: still off
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends the contract headers through the API client; a 404 does not sign out', async () => {
    const onUnauthorized = jest.fn();
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 404, headers: { get: () => 'application/json' }, json: async () => ({ error: 'not_found' }) }) as unknown as Response);
    const api = createApi({ baseUrl: () => 'https://x.ly', onUnauthorized, fetchImpl });
    const r = new PresenceReporter(p => api.post('/presence', p, { live: true, headers: { 'X-ETS-Client': 'mobile' } }));
    r.screen(screenOf('/home/app/per'));
    await flush(); await flush();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.ly/api/presence');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'ets', 'Content-Type': 'application/json', 'X-ETS-Live': '1', 'X-ETS-Client': 'mobile' });
    expect(JSON.parse(String(init.body))).toEqual({ path: '/home/app/per', screen: 'application', ref: 'per' });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(presenceSupported()).toBe(false);
  });
});
