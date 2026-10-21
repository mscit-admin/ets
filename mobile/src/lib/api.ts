// The ETS REST API, same endpoints and rules as the web UI (frontend/src/lib/api.js):
//   - the session is the server's cookie (__Host-ets_sid, HttpOnly, Secure, SameSite=Strict); fetch is called with
//     credentials: 'include' so the platform cookie store (Android: CookieManager behind OkHttp, iOS:
//     NSHTTPCookieStorage) stores it and sends it back;
//   - every request carries X-Requested-With: ets (the server's CSRF check, backend/src/middleware/common.js);
//   - errors are ApiError with the server's error code, shown with the shared translations as err_<code>;
//   - a 401 outside /auth/* means the session ended: onUnauthorized() sends the app back to the sign-in screen.
export class ApiError extends Error {
  status: number;
  code: string;
  data: Record<string, unknown> | null;
  constructor(status: number, code: string, data: Record<string, unknown> | null = null) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export const TIMEOUT_MS = 20_000;

/** The ApiError for an answer that is not 2xx: the server's { error } code, else http_<status>. */
export function errorFromResponse(status: number, data: unknown): ApiError {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const code = obj && typeof obj.error === 'string' && /^[a-z0-9_]{1,64}$/.test(obj.error) ? obj.error : 'http_' + status;
  return new ApiError(status, code, obj);
}

/** Should this failed request end the session on the phone? (401 outside the sign-in endpoints) */
export const endsSession = (status: number, path: string) => status === 401 && !path.startsWith('/auth/');

type Options = { live?: boolean; signal?: AbortSignal; headers?: Record<string, string> };
type Config = { baseUrl: () => string | null; onUnauthorized: (code: string) => void; fetchImpl?: typeof fetch };

export function createApi({ baseUrl, onUnauthorized, fetchImpl }: Config) {
  async function request<T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
    const base = baseUrl();
    if (!base) throw new ApiError(0, 'no_server');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const abort = () => ctl.abort();
    opts.signal?.addEventListener('abort', abort);
    let res: Response;
    try {
      res = await (fetchImpl || fetch)(base + '/api' + path, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'ets',
          // a reload by the app itself (polling), not by the user: not activity for the server's idle timeout
          ...(opts.live ? { 'X-ETS-Live': '1' } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch {
      throw new ApiError(0, opts.signal?.aborted ? 'aborted' : ctl.signal.aborted ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    }
    const type = res.headers.get('content-type') || '';
    const data: unknown = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text().catch(() => '');
    if (!res.ok) {
      const err = errorFromResponse(res.status, data);
      if (endsSession(res.status, path)) onUnauthorized(err.code);
      throw err;
    }
    return data as T;
  }
  return {
    get: <T>(path: string, opts?: Options) => request<T>('GET', path, undefined, opts),
    post: <T>(path: string, body: unknown = {}, opts?: Options) => request<T>('POST', path, body, opts),
    put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
    patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
    del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
  };
}
export type Api = ReturnType<typeof createApi>;

/** An answer that may have been sent for approval (HTTP 202 { pending: true, request_id }) instead of applied. */
export type MaybePending = { pending?: boolean; request_id?: number; warning?: string };
export const isPending = (r: unknown) => !!(r && typeof r === 'object' && (r as MaybePending).pending === true);

/** API path with encoded segments: path`/tracker/applications/${id}` (an id never becomes another path). */
export const path = (parts: TemplateStringsArray, ...vals: unknown[]) =>
  parts.reduce((s, p, i) => s + p + (i < vals.length ? encodeURIComponent(String(vals[i])) : ''), '');

/** ?a=1&b=2 without empty values */
export const qs = (obj: Record<string, string | number | boolean | null | undefined>) => {
  const s = Object.entries(obj)
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
    .join('&');
  return s ? '?' + s : '';
};

/**
 * Message of an error, as the web's errText(): err_<code> with the answer's fields as placeholders, else
 * err_generic with the code. `has` tells whether a key exists (shared + app messages).
 */
export function errorMessage(e: unknown, t: (k: string, v?: Record<string, unknown>) => string, has: (k: string) => boolean): string {
  const err = e as Partial<ApiError> | null;
  const code = typeof err?.code === 'string' ? err.code : 'generic';
  return has('err_' + code) ? t('err_' + code, { code, ...(err?.data && typeof err.data === 'object' ? err.data : {}) }) : t('err_generic', { code });
}
