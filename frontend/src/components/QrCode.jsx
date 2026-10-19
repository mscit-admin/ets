// A QR code drawn in the browser as SVG (qrcode-generator 2.0.4, MIT, Kazuhiko Arase — pinned in package.json).
// Used for pairing a phone (profile page «أجهزتي»); the payload never leaves the page.
import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ value, label, margin = 4 }) {
  const qr = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(value, 'Byte');
    q.make();
    return q;
  }, [value]);
  const n = qr.getModuleCount(), size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
      <rect width={size} height={size} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
