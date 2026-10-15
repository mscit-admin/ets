// Branding images (Settings → Branding): system logo, favicon, login background.
// GET is public (the login screen needs it); upload / reset needs the 'cfg' permission.
import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requirePerm } from '../middleware/auth.js';
import { logAudit } from '../services/logs.js';
import { HttpError, bad, notFound } from '../utils/http.js';

const r = Router();

const BRANDING_KEYS = ['logo', 'favicon', 'login_bg'];
const MAX_BYTES = { logo: 1024 * 1024, favicon: 512 * 1024, login_bg: 3 * 1024 * 1024 };

// Only raster formats, recognised by their first bytes (the declared type is not trusted).
// SVG is refused on purpose: it can carry scripts.
function sniff(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  return null;
}

// Versions (update times) so the UI knows what is customised and can bust caches.
export async function brandingVersions() {
  const rows = (await query('SELECT key, extract(epoch FROM updated_at)::bigint AS v FROM branding_assets')).rows;
  return Object.fromEntries(BRANDING_KEYS.map(k => [k, rows.find(x => x.key === k)?.v ?? null]));
}

r.get('/:key', async (req, res) => {
  if (!BRANDING_KEYS.includes(req.params.key)) throw notFound();
  const a = (await query('SELECT mime, data, updated_at FROM branding_assets WHERE key=$1', [req.params.key])).rows[0];
  if (!a) throw notFound();
  const etag = `"${req.params.key}-${new Date(a.updated_at).getTime()}"`;
  res.set({ 'Content-Type': a.mime, 'Cache-Control': 'public, max-age=86400', ETag: etag, 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'" });
  if (req.get('if-none-match') === etag) return res.status(304).end();
  res.send(a.data);
});

// Body: { data: "data:image/png;base64,...." }
r.put('/:key', requireAuth, requirePerm('cfg'), async (req, res) => {
  const key = req.params.key;
  if (!BRANDING_KEYS.includes(key)) throw notFound();
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  const m = /^data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(req.body?.data || ''));
  if (!m) throw bad('invalid_image');
  const buf = Buffer.from(m[1], 'base64');
  const mime = sniff(buf);
  if (!mime) throw bad('invalid_image');
  if (buf.length > MAX_BYTES[key]) throw bad('image_too_large', { max_kb: MAX_BYTES[key] / 1024 });
  await query(`INSERT INTO branding_assets(key, mime, data, updated_by) VALUES ($1,$2,$3,$4)
    ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now(), updated_by=EXCLUDED.updated_by`,
  [key, mime, buf, req.user.id]);
  await logAudit(req, { action: 'update', entity: 'branding', entityId: key, summary: `${mime}, ${Math.round(buf.length / 1024)} KB` });
  res.json({ ok: true, versions: await brandingVersions() });
});

r.delete('/:key', requireAuth, requirePerm('cfg'), async (req, res) => {
  const key = req.params.key;
  if (!BRANDING_KEYS.includes(key)) throw notFound();
  if (!req.user.fullScope) throw new HttpError(403, 'out_of_scope');
  await query('DELETE FROM branding_assets WHERE key=$1', [key]);
  await logAudit(req, { action: 'reset', entity: 'branding', entityId: key, summary: 'back to default' });
  res.json({ ok: true, versions: await brandingVersions() });
});

export default r;
