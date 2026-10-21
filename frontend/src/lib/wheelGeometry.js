// Geometry and colours of the dashboard's ERP module wheel. Plain functions and numbers, no imports: used by
// components/ErpWheel.jsx and by the mobile app (mobile/src/components/ErpWheel.tsx), so both draw the same figure.
// Coordinates are in the 560 × 560 viewBox; angles in degrees clockwise from the top, mirrored (counter-clockwise)
// for a right-to-left reader.
export const SIZE = 560, C = SIZE / 2;
export const R_HUB = 86, R_HUB_RING = 95, R_IN = 108, R_OUT = 236, R_RIM = 248, R_TEXT = 171;
export const GAP = 6;                                       // white gap between segments (px, constant width)
// Corporate blue / navy fills of the active segments, alternating around the wheel (white text ≥ 4.5:1 on each).
export const FILLS = ['#1b3a66', '#24508a', '#2c62a6'];

export const geo = mirror => {
  const pt = (r, a) => {
    const rad = (a * Math.PI) / 180;
    return [C + (mirror ? -1 : 1) * r * Math.sin(rad), C - r * Math.cos(rad)];
  };
  const sweep = mirror ? 0 : 1;
  const f = n => n.toFixed(2);
  const arc = (r, a0, a1) => {
    const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1);
    return `M${f(x0)} ${f(y0)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} ${sweep} ${f(x1)} ${f(y1)}`;
  };
  const wedge = (a0, a1) => {
    const po = (GAP / 2 / R_OUT) * (180 / Math.PI), pi = (GAP / 2 / R_IN) * (180 / Math.PI);
    const [ax, ay] = pt(R_OUT, a0 + po), [bx, by] = pt(R_OUT, a1 - po);
    const [cx, cy] = pt(R_IN, a1 - pi), [dx, dy] = pt(R_IN, a0 + pi);
    const large = a1 - a0 > 180 ? 1 : 0;
    return `M${f(ax)} ${f(ay)}A${R_OUT} ${R_OUT} 0 ${large} ${sweep} ${f(bx)} ${f(by)}L${f(cx)} ${f(cy)}` +
      `A${R_IN} ${R_IN} 0 ${large} ${1 - sweep} ${f(dx)} ${f(dy)}Z`;
  };
  return { pt, arc, wedge };
};

// Angles of segment i of n: centred on i × 360/n, starting at the top.
export const segmentAngles = (i, n) => { const step = 360 / n; return [i * step - step / 2, i * step + step / 2]; };

// The progress arc on the outer rim of a segment: [start, end] angles for pct (0–100), inside the segment's gaps.
export const rimAngles = (a0, a1, pct) => {
  const rimPad = (GAP / 2 / R_RIM) * (180 / Math.PI);
  const rimStart = a0 + rimPad, rimEnd = a1 - rimPad;
  return { rimStart, rimEnd, rimTo: rimStart + ((rimEnd - rimStart) * Math.max(0, Math.min(100, pct))) / 100 };
};

// Label lines of a module (two lines when lines_ar / lines_en split the name).
export const linesOf = (m, lang) => m[`lines_${lang}`] || [m[`name_${lang}`] || m.name_ar];
