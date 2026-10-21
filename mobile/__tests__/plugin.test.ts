import plugin from '../plugins/withAndroidNetworkSecurity';

const { releaseXml, debugXml, applyManifest, DEV_HOSTS } = plugin as unknown as {
  releaseXml: () => string; debugXml: () => string; DEV_HOSTS: string[];
  applyManifest: (m: { manifest: { application?: { $: Record<string, string> }[] } }) => { manifest: { application: { $: Record<string, string> }[] } };
};

describe('Android network security config plugin', () => {
  it('release: no cleartext, system + user CAs', () => {
    const xml = releaseXml();
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
    expect(xml).toContain('<certificates src="system" />');
    expect(xml).toContain('<certificates src="user" />');
    expect(xml).not.toContain('cleartextTrafficPermitted="true"');
  });
  it('debug: plain HTTP only to the Metro hosts on this computer', () => {
    const xml = debugXml();
    expect(xml).toContain('<base-config cleartextTrafficPermitted="false">');
    const domains = [...xml.matchAll(/<domain includeSubdomains="false">([^<]+)<\/domain>/g)].map(m => m[1]);
    expect(domains).toEqual(DEV_HOSTS);
    expect(DEV_HOSTS.every(h => /^(localhost|127\.0\.0\.1|10\.0\.[23]\.2)$/.test(h))).toBe(true);
  });
  it('points the manifest at the file and drops usesCleartextTraffic', () => {
    const m = applyManifest({ manifest: { application: [{ $: { 'android:name': '.MainApplication', 'android:usesCleartextTraffic': 'true' } }] } });
    expect(m.manifest.application[0].$['android:networkSecurityConfig']).toBe('@xml/network_security_config');
    expect(m.manifest.application[0].$).not.toHaveProperty('android:usesCleartextTraffic');
    expect(() => applyManifest({ manifest: {} })).toThrow();
  });
});
