// Reopening a closed function (migration 033): the mandatory official document and the mandatory reason.
//
// The document is uploaded the same way as a branding image (routes/branding.js): a data: URL in the JSON body,
// decoded to bytes and stored in the database. Unlike branding (raster images recognised by their first bytes), a
// reopen order is normally a PDF, so PDF and the common raster formats are accepted. The declared type is never
// trusted: the bytes are sniffed and the stored mime comes from the sniff.
import { bad } from '../utils/http.js';
import { NOTE_MIN, NOTE_MAX } from './disable.js';

// Same rule as a rename / an exclusion note / a move reason: at least NOTE_MIN non-whitespace characters.
export const REASON_MIN = NOTE_MIN, REASON_MAX = NOTE_MAX;
// A reopen order is a small file; the whole JSON body is capped at LARGE_LIMIT (5 MB, middleware/body.js), and base64
// inflates by ~⅓, so 3 MB of file bytes always fits with the reason alongside it.
export const DOC_MAX_BYTES = 3 * 1024 * 1024;

export function parseReopenReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.replace(/\s/gu, '').length < REASON_MIN) throw bad('reopen_reason_required', { min: REASON_MIN });
  return reason.slice(0, REASON_MAX);
}

// The document's real type from its first bytes (PDF + the raster formats branding accepts).
function sniff(buf) {
  if (buf.length > 4 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

// body.document: a data: URL ("data:application/pdf;base64,...."). Returns { name, mime, size, data (Buffer) }.
export function parseReopenDoc(raw) {
  const m = /^data:([^;,]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(typeof raw === 'string' ? raw : '');
  if (!m) throw bad('reopen_doc_required');
  const data = Buffer.from(m[2], 'base64');
  if (!data.length) throw bad('reopen_doc_required');
  if (data.length > DOC_MAX_BYTES) throw bad('reopen_doc_too_large', { max_kb: Math.round(DOC_MAX_BYTES / 1024) });
  const mime = sniff(data);
  if (!mime) throw bad('reopen_doc_invalid');
  return { name: `reopen-order.${EXT[mime]}`, mime, size: data.length, data };
}
