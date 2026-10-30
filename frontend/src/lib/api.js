// Thin fetch wrapper. Errors are thrown as ApiError with the server's error code,
// which pages translate with t('err_' + code).
class ApiError extends Error {
  constructor(status, code, data) { super(code); this.status = status; this.code = code; this.data = data; }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };
// The live-updates stream ended with the session (lib/live.js): same handling as a 401 answer.
export const notifyUnauthorized = () => onUnauthorized('session_ended');

async function request(method, url, body, { live = false, activity = false } = {}) {
  let res;
  try {
    res = await fetch('/api' + url, {
      method,
      credentials: 'same-origin',
      // X-ETS-Live: a reload triggered by live updates, not by the user. X-ETS-Activity: genuine user input — the only
      // thing that extends the server's idle timeout; sent by lib/activity.js alone (1.12.2)
      headers: { 'X-Requested-With': 'ets', ...(live ? { 'X-ETS-Live': '1' } : {}), ...(activity ? { 'X-ETS-Activity': '1' } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    const code = (data && data.error) || 'http_' + res.status;
    if (res.status === 401 && !url.startsWith('/auth/')) onUnauthorized(code, data);
    throw new ApiError(res.status, code, data);
  }
  return data;
}

export const api = {
  get: (url, opts) => request('GET', url, undefined, opts),
  post: (url, body = {}, opts) => request('POST', url, body, opts),
  put: (url, body = {}) => request('PUT', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url, body) => request('DELETE', url, body),
};

// API path with encoded segments: path`/users/${id}/reset-password`. A route parameter such as "..%2Fauth%2Fme"
// stays one segment instead of turning into another API call.
export const path = (parts, ...vals) => parts.reduce((s, p, i) => s + p + (i < vals.length ? encodeURIComponent(String(vals[i])) : ''), '');

// Ids taken from the address bar are checked before they are sent to the API.
export const isIdParam = v => /^[0-9]{1,10}$/.test(String(v ?? ''));
export const notFoundError = () => Object.assign(new Error('not_found'), { status: 404, code: 'not_found' });

export const qs = obj => {
  const p = new URLSearchParams();
  Object.entries(obj).forEach(([k, v]) => { if (v !== '' && v !== null && v !== undefined) p.set(k, v); });
  const s = p.toString();
  return s ? '?' + s : '';
};

// Downloads a file from the API (e.g. an Excel export) with the session cookie and the app's request header, so
// an error comes back as an ApiError the page can show instead of a JSON page. The name comes from the server's
// Content-Disposition (UTF-8 filename* first).
export async function downloadFile(url, fallbackName = 'export') {
  let res;
  try {
    res = await fetch('/api' + url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'ets' } });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) onUnauthorized(data.error, data);
    throw new ApiError(res.status, data.error || 'http_' + res.status, data);
  }
  const cd = res.headers.get('content-disposition') || '';
  let name = fallbackName;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd), plain = /filename="([^"]+)"/i.exec(cd);
  try { if (star) name = decodeURIComponent(star[1]); else if (plain) name = plain[1]; } catch { if (plain) name = plain[1]; }
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

// Like downloadFile, but sends a POST with a JSON body (e.g. a sensitive download that re-authenticates: the password
// must not travel in the URL). The file name comes from the server's Content-Disposition, the fallback otherwise.
export async function postDownloadFile(url, body, fallbackName = 'download') {
  let res;
  try {
    res = await fetch('/api' + url, { method: 'POST', credentials: 'same-origin',
      headers: { 'X-Requested-With': 'ets', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'network');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) onUnauthorized(data.error, data);
    throw new ApiError(res.status, data.error || 'http_' + res.status, data);
  }
  const cd = res.headers.get('content-disposition') || '';
  let name = fallbackName;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd), plain = /filename="([^"]+)"/i.exec(cd);
  try { if (star) name = decodeURIComponent(star[1]); else if (plain) name = plain[1]; } catch { if (plain) name = plain[1]; }
  const href = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
  return { key_id: res.headers.get('x-key-id') || null };
}

// Trigger a browser download of a text payload
export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
