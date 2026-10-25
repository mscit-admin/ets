export const pc = v => (Math.round((+v || 0) * 10) / 10).toFixed(1);

// ERPNext-style indicator colour for a percentage
export const pctColor = v => (v >= 90 ? 'green' : v >= 60 ? 'blue' : v >= 30 ? 'orange' : v > 0 ? 'red' : 'gray');

// 0 not tested, 1 passed with note, 2 passed, 3 failed, 4 needs re-testing (amber attention tone, 1.12.25)
export const TEST_COLORS = ['gray', 'orange', 'green', 'red', 'amber'];
export const VENDOR_COLORS = ['gray', 'green', 'orange', 'blue'];
export const REPORT_COLORS = ['gray', 'green', 'red', 'orange'];

// ---- Continuous "how critical is this %" colour (rings of the application header) ----
// Hue runs smoothly in OKLCH from red (25°) at ≤ 20 % through orange (55° at 40 %) and amber (85° at 60 %)
// to green (145°) at ≥ 80 % — piecewise-linear between those stops (continuous, no steps), clamped ends. Lightness is fixed per role, so
// every tone of a role has (almost) the same contrast against white:
//   stroke — the ring colour;  text — a darkened tone of the same hue for the number (WCAG AA ≥ 4.5:1);
//   bg     — a pale tint of the same hue (ring track / soft backgrounds).
// Chroma is reduced until the colour fits in sRGB, so the output is a plain #rrggbb.
// pctColor() above stays the discrete indicator used elsewhere in the app.
const TONE_ROLES = { stroke: [0.635, 0.18], text: [0.47, 0.13], bg: [0.955, 0.035] };

function oklchToRgb(L, C, h) {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}
const inGamut = rgb => rgb.every(x => x >= -1e-4 && x <= 1 + 1e-4);
const toHex = rgb => '#' + rgb.map(x => {
  const v = Math.min(1, Math.max(0, x));
  const e = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(e * 255).toString(16).padStart(2, '0');
}).join('');

function oklchHex(L, C, h) {
  let rgb = oklchToRgb(L, C, h);
  if (!inGamut(rgb)) {                 // largest chroma (same L and hue) that is still displayable
    let lo = 0, hi = C;
    for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToRgb(L, mid, h))) lo = mid; else hi = mid; }
    rgb = oklchToRgb(L, lo, h);
  }
  return toHex(rgb);
}

const HUE_STOPS = [[20, 25], [40, 55], [60, 85], [80, 145]];   // [percentage, OKLCH hue°]

/** Hue (degrees, OKLCH) for a percentage: 25° red ≤ 20 %, 145° green ≥ 80 %, interpolated in between. */
export function pctHue(v) {
  const x = Math.min(100, Math.max(0, +v || 0));
  if (x <= HUE_STOPS[0][0]) return HUE_STOPS[0][1];
  for (let i = 1; i < HUE_STOPS.length; i++) {
    const [x1, h1] = HUE_STOPS[i];
    if (x <= x1) { const [x0, h0] = HUE_STOPS[i - 1]; return h0 + ((h1 - h0) * (x - x0)) / (x1 - x0); }
  }
  return HUE_STOPS[HUE_STOPS.length - 1][1];
}

/** {stroke, text, bg} hex colours that move continuously with the percentage. */
export function pctTone(v) {
  const h = pctHue(v);
  const out = {};
  for (const [role, [L, C]] of Object.entries(TONE_ROLES)) out[role] = oklchHex(L, C, h);
  return out;
}

/** CSS linear-gradient of the same scale (0 → 100 %), e.g. for a legend; `side` is the CSS direction. */
export const pctGradient = (side = 'right') =>
  `linear-gradient(to ${side}, ${Array.from({ length: 11 }, (_, i) => pctTone(i * 10).stroke + ' ' + i * 10 + '%').join(', ')})`;
