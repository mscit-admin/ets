// Branding images are published to anonymous visitors, so they are cleaned before they are stored (ETS-SEC-070):
// metadata blocks (EXIF with camera and GPS data, XMP, comments, text chunks) are removed and anything after the
// end of the image (appended HTML/script "polyglot" payloads, trailers) is cut off. No pixel is decoded or changed,
// so no image library is needed. Returns the cleaned buffer, or null when the structure is broken.

// ---- JPEG ----
// Kept: APP0 (JFIF), APP2 (ICC colour profile), APP14 (Adobe colour transform, needed to decode some files) and
// every non-APP marker (tables, frame, scan). Dropped: APP1 (EXIF/XMP), the other APPn and COM.
const JPEG_KEEP_APP = new Set([0xe0, 0xe2, 0xee]);

function cleanJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    let m = buf[i + 1];
    while (m === 0xff) { i++; m = buf[i + 1]; }      // fill bytes
    if (m === undefined) return null;
    if (m === 0xd9) { out.push(Buffer.from([0xff, 0xd9])); return Buffer.concat(out); }   // EOI: the rest is dropped
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) return null;
    const seg = buf.subarray(i, i + 2 + len);
    const isApp = m >= 0xe0 && m <= 0xef;
    if (!(m === 0xfe || (isApp && !JPEG_KEEP_APP.has(m)))) out.push(seg);
    i += 2 + len;
    if (m === 0xda) {
      // entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker
      const start = i;
      while (i + 1 < buf.length && !(buf[i] === 0xff && buf[i + 1] !== 0x00 && !(buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7))) i++;
      if (i + 1 >= buf.length) return null;
      out.push(buf.subarray(start, i));
    }
  }
  return null;                                         // no EOI
}

// ---- PNG ----
// Only chunks needed to show the image are kept; tEXt/zTXt/iTXt/eXIf/tIME and unknown chunks are dropped.
const PNG_KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD',
  'acTL', 'fcTL', 'fdAT']);

function cleanPng(buf) {
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || i + 12 + len > buf.length) return null;
    if (PNG_KEEP.has(type)) out.push(buf.subarray(i, i + 12 + len));
    i += 12 + len;
    if (type === 'IEND') return Buffer.concat(out);    // the rest is dropped
  }
  return null;
}

// ---- WebP ----
// EXIF and XMP chunks are dropped (and their flags cleared in VP8X); bytes after the RIFF size are dropped.
function cleanWebp(buf) {
  const size = buf.readUInt32LE(4) + 8;
  if (size > buf.length || size < 12) return null;
  const out = [];
  let i = 12;
  while (i + 8 <= size) {
    const type = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const total = 8 + len + (len & 1);
    if (i + 8 + len > size) return null;
    if (type === 'VP8X') {
      const c = Buffer.from(buf.subarray(i, i + total));
      c[8] &= ~(0x08 | 0x04);                          // EXIF and XMP flags
      out.push(c);
    } else if (type !== 'EXIF' && type !== 'XMP ') out.push(buf.subarray(i, i + Math.min(total, size - i)));
    i += total;
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

// ---- ICO ----
// A directory of embedded images; anything after the last image is dropped.
function cleanIco(buf) {
  if (buf.length < 6) return null;
  const n = buf.readUInt16LE(4);
  if (!n || 6 + 16 * n > buf.length) return null;
  let end = 6 + 16 * n;
  for (let k = 0; k < n; k++) {
    const size = buf.readUInt32LE(6 + 16 * k + 8), off = buf.readUInt32LE(6 + 16 * k + 12);
    if (off + size > buf.length) return null;
    end = Math.max(end, off + size);
  }
  return Buffer.from(buf.subarray(0, end));
}

export function cleanImage(buf, mime) {
  try {
    if (mime === 'image/jpeg') return cleanJpeg(buf);
    if (mime === 'image/png') return cleanPng(buf);
    if (mime === 'image/webp') return cleanWebp(buf);
    if (mime === 'image/x-icon') return cleanIco(buf);
  } catch { /* malformed: refused below */ }
  return null;
}
