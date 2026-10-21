import { ApiError, createApi, endsSession, errorFromResponse, errorMessage, path, qs } from '@/lib/api';
import { hasKey, translator } from '@/lib/i18n';

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => body, text: async () => '' }) as unknown as Response;

describe('errorFromResponse', () => {
  it('keeps the server error code and fields', () => {
    const e = errorFromResponse(429, { error: 'too_many_attempts', retry_after: 30 });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe('too_many_attempts');
    expect(e.status).toBe(429);
    expect(e.data).toEqual({ error: 'too_many_attempts', retry_after: 30 });
  });
  it('falls back to http_<status> for a missing or odd code', () => {
    expect(errorFromResponse(502, '<html>bad gateway</html>').code).toBe('http_502');
    expect(errorFromResponse(500, { error: 'Not A Code!' }).code).toBe('http_500');
    expect(errorFromResponse(404, null).code).toBe('http_404');
    expect(errorFromResponse(400, [1, 2]).data).toBeNull();
  });
});

describe('endsSession', () => {
  it('is a 401 outside the sign-in endpoints only', () => {
    expect(endsSession(401, '/tracker/summary')).toBe(true);
    expect(endsSession(401, '/auth/login')).toBe(false);
    expect(endsSession(401, '/auth/2fa/verify')).toBe(false);
    expect(endsSession(403, '/tracker/summary')).toBe(false);
  });
});

describe('createApi', () => {
  it('sends the CSRF header, JSON and the cookie (credentials: include)', async () => {
    const fetchImpl = jest.fn(async () => json(200, { ok: true }));
    const api = createApi({ baseUrl: () => 'https://ets.example.ly', onUnauthorized: jest.fn(), fetchImpl });
    await expect(api.post('/auth/login', { username: 'a', password: 'b' })).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://ets.example.ly/api/auth/login');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'X-Requested-With': 'ets', 'Content-Type': 'application/json' });
    expect(init.body).toBe(JSON.stringify({ username: 'a', password: 'b' }));
  });
  it('marks automatic reloads with X-ETS-Live (not activity for the idle timeout)', async () => {
    const fetchImpl = jest.fn(async () => json(200, {}));
    const api = createApi({ baseUrl: () => 'https://x.ly', onUnauthorized: jest.fn(), fetchImpl });
    await api.get('/notifications/count', { live: true });
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'X-ETS-Live': '1' });
    await api.get('/tracker/summary');
    expect((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('X-ETS-Live');
  });
  it('a 401 on a data endpoint ends the session; on /auth/* it does not', async () => {
    const onUnauthorized = jest.fn();
    const fetchImpl = jest.fn(async () => json(401, { error: 'not_authenticated' }));
    const api = createApi({ baseUrl: () => 'https://x.ly', onUnauthorized, fetchImpl });
    await expect(api.get('/tracker/summary')).rejects.toMatchObject({ code: 'not_authenticated', status: 401 });
    expect(onUnauthorized).toHaveBeenCalledWith('not_authenticated');
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
  it('maps a failed connection to network, and no server to no_server', async () => {
    const api = createApi({ baseUrl: () => 'https://x.ly', onUnauthorized: jest.fn(), fetchImpl: jest.fn(async () => { throw new TypeError('Network request failed'); }) });
    await expect(api.get('/health')).rejects.toMatchObject({ code: 'network', status: 0 });
    const none = createApi({ baseUrl: () => null, onUnauthorized: jest.fn(), fetchImpl: jest.fn() });
    await expect(none.get('/health')).rejects.toMatchObject({ code: 'no_server' });
  });
});

describe('errorMessage (shared translations)', () => {
  const t = translator('en'), has = (k: string) => hasKey('en', k);
  const ta = translator('ar'), hasA = (k: string) => hasKey('ar', k);
  it('uses err_<code> with the answer fields as placeholders', () => {
    expect(errorMessage(new ApiError(429, 'too_many_attempts', { retry_after: 42 }), t, has)).toBe('Too many attempts. Wait 42 seconds and try again');
    expect(errorMessage(new ApiError(401, 'invalid_credentials'), ta, hasA)).toMatch(/^اسم المستخدم أو البريد الإلكتروني أو كلمة المرور غير صحيحة/);
  });
  it('has messages for the codes the app produces itself', () => {
    for (const code of ['network', 'timeout', 'no_server', 'not_ets', 'url_https_required', 'url_invalid', 'url_empty', 'session_ended', 'not_authenticated']) {
      expect(has('err_' + code)).toBe(true);
      expect(hasA('err_' + code)).toBe(true);
    }
  });
  it('falls back to err_generic with the code', () => {
    expect(errorMessage(new ApiError(418, 'http_418'), t, has)).toBe('Request failed (http_418)');
    expect(errorMessage(null, t, has)).toBe('Request failed (generic)');
  });
});

describe('path / qs', () => {
  it('encodes each segment', () => {
    const id = '../auth/me';
    expect(path`/tracker/applications/${id}`).toBe('/tracker/applications/..%2Fauth%2Fme');
  });
  it('drops empty values', () => {
    expect(qs({ limit: 30, unread: '', category: null, before: undefined, lang: 'ar' })).toBe('?limit=30&lang=ar');
    expect(qs({})).toBe('');
  });
});
