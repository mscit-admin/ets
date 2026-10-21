// The web's icon markup (frontend/src/lib/iconPaths.js: '<path d="…"/><circle …/>') as a list of SVG elements
// that react-native-svg can draw. Parsed once per icon and cached.
import { ICON_PATHS } from '@/shared/web';

export type IconTag = 'path' | 'circle' | 'rect' | 'ellipse' | 'line' | 'polyline' | 'polygon';
export type IconElement = { tag: IconTag; attrs: Record<string, string> };

const TAG_RE = /<(path|circle|rect|ellipse|line|polyline|polygon)\b((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*\/>/g;
const ATTR_RE = /([a-zA-Z:-]+)="([^"]*)"/g;
const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** Parses icon markup; throws on anything else than the self-closing shapes above (kept simple on purpose). */
export function parseIcon(markup: string): IconElement[] {
  const out: IconElement[] = [];
  let rest = markup;
  for (const m of markup.matchAll(TAG_RE)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(ATTR_RE)) attrs[camel(a[1])] = a[2];
    out.push({ tag: m[1] as IconTag, attrs });
    rest = rest.replace(m[0], '');
  }
  if (rest.trim()) throw new Error('Unsupported icon markup: ' + rest.trim().slice(0, 60));
  return out;
}

const cache = new Map<string, IconElement[]>();
/** Elements of a named icon ([] for an unknown name, like the web's empty <svg>). */
export function iconElements(name: string): IconElement[] {
  let els = cache.get(name);
  if (!els) {
    els = Object.hasOwn(ICON_PATHS, name) ? parseIcon(ICON_PATHS[name]) : [];
    cache.set(name, els);
  }
  return els;
}
