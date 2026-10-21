// The continuous "how critical is this %" colour scale of the web (frontend/src/lib/format.js pctTone / pctHue):
// red at ≤ 20 % through orange and amber to green at ≥ 80 %. The functions come from the shared file; this adds what
// React Native needs instead of a CSS gradient string.
import { pctColor, pctTone, type Tone } from '@/shared/web';
import { bars } from './tokens';

export { pctColor, pctTone, pctHue, type Tone } from '@/shared/web';

/** Gradient stops of the scale (0 → 100 %), same points as the web's pctGradient(): 11 stops, every 10 %. */
export function toneStops(n = 11): { offset: number; color: string }[] {
  return Array.from({ length: n }, (_, i) => {
    const p = (i * 100) / (n - 1);
    return { offset: p / 100, color: pctTone(p).stroke };
  });
}

/** The discrete progress-bar fill of the web (.progress-bar.<pctColor>) */
export const barColor = (v: number): string => bars[pctColor(v) as keyof typeof bars] ?? bars.gray;

/** Tone of a value clamped to 0–100 (NaN → 0) */
export const toneOf = (v: unknown): Tone => pctTone(Math.max(0, Math.min(100, Number(v) || 0)));
