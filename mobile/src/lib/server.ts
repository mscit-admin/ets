// The ETS server address («عنوان الخادم»), entered at first launch. HTTPS only: the session cookie is Secure
// (and named __Host-… by the server), so a phone would never send it over plain HTTP anyway.
export type ServerUrlError = 'url_empty' | 'url_https_required' | 'url_invalid';
export type ServerUrlResult = { ok: true; url: string } | { ok: false; error: ServerUrlError };

// host: a DNS name, an IPv4 address or a bracketed IPv6 address; optional :port; optional path (no query / fragment)
const HOST = String.raw`(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])`;
const URL_RE = new RegExp(String.raw`^https://(${HOST})(?::(\d{1,5}))?(/[A-Za-z0-9._~%!$&'()*+,;=:@/-]*)?$`);

/**
 * Normalises what the user typed: trims it, adds https:// when no scheme is given, removes a trailing slash and a
 * trailing /api (the app adds /api itself). Refuses http:// and any other scheme, user:password@, a query or a
 * fragment, and an invalid host or port.
 */
export function normalizeServerUrl(input: string): ServerUrlResult {
  let s = (input || '').trim();
  if (!s) return { ok: false, error: 'url_empty' };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(s);
  if (!scheme) s = 'https://' + s;
  else if (scheme[1].toLowerCase() === 'http') return { ok: false, error: 'url_https_required' };
  else if (scheme[1].toLowerCase() !== 'https') return { ok: false, error: 'url_invalid' };
  else s = 'https://' + s.slice(scheme[0].length);
  const m = URL_RE.exec(s);
  if (!m) return { ok: false, error: 'url_invalid' };
  const [, host, port, rawPath = ''] = m;
  if (port !== undefined && (+port < 1 || +port > 65535)) return { ok: false, error: 'url_invalid' };
  const path = rawPath.replace(/\/+$/, '').replace(/\/api$/i, '');
  return { ok: true, url: `https://${host.toLowerCase()}${port && port !== '443' ? ':' + port : ''}${path}` };
}
