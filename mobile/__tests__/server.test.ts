import { normalizeServerUrl } from '@/lib/server';

const ok = (input: string) => { const r = normalizeServerUrl(input); if (!r.ok) throw new Error(r.error); return r.url; };
const err = (input: string) => { const r = normalizeServerUrl(input); return r.ok ? null : r.error; };

describe('normalizeServerUrl (https only)', () => {
  it('adds https:// and tidies the address', () => {
    expect(ok('ets.example.ly')).toBe('https://ets.example.ly');
    expect(ok('  https://ETS.Example.ly/  ')).toBe('https://ets.example.ly');
    expect(ok('https://ets.example.ly:8443')).toBe('https://ets.example.ly:8443');
    expect(ok('https://ets.example.ly:443/')).toBe('https://ets.example.ly');
    expect(ok('https://ets.example.ly/api')).toBe('https://ets.example.ly');
    expect(ok('https://intranet.local/ets/')).toBe('https://intranet.local/ets');
    expect(ok('10.0.0.5:8443')).toBe('https://10.0.0.5:8443');
    expect(ok('HTTPS://[fd00::1]:8443')).toBe('https://[fd00::1]:8443');
  });
  it('refuses plain http', () => {
    expect(err('http://ets.example.ly')).toBe('url_https_required');
    expect(err('HTTP://ets.example.ly:80')).toBe('url_https_required');
  });
  it('refuses other schemes, credentials, queries, bad hosts and ports', () => {
    expect(err('')).toBe('url_empty');
    expect(err('   ')).toBe('url_empty');
    expect(err('ftp://ets.example.ly')).toBe('url_invalid');
    expect(err('javascript://alert(1)')).toBe('url_invalid');
    expect(err('https://user:pw@ets.example.ly')).toBe('url_invalid');
    expect(err('https://ets.example.ly/?x=1')).toBe('url_invalid');
    expect(err('https://ets.example.ly/#a')).toBe('url_invalid');
    expect(err('https://ets example.ly')).toBe('url_invalid');
    expect(err('https://-bad-.ly')).toBe('url_invalid');
    expect(err('https://ets.example.ly:0')).toBe('url_invalid');
    expect(err('https://ets.example.ly:70000')).toBe('url_invalid');
  });
});
