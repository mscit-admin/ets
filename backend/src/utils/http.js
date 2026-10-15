// Errors carry a stable machine code; the frontend translates the code into Arabic/English.
export class HttpError extends Error {
  constructor(status, code, extra = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, extra) => new HttpError(400, code, extra);
export const notFound = (code = 'not_found') => new HttpError(404, code);

// Small input helpers
export const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
export const numIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// Database ids are PostgreSQL int4: anything else is refused with 400 before it reaches a query (ETS-SEC-029).
export const INT4_MAX = 2147483647;
export const isId = v => Number.isInteger(v) && v >= 1 && v <= INT4_MAX;
export function idParam(v, field = 'id') {
  const n = typeof v === 'string' && /^[0-9]{1,10}$/.test(v) ? Number(v) : NaN;
  if (!isId(n)) throw bad('invalid_id', { field });
  return n;
}

// A real calendar day 'YYYY-MM-DD' (2024-02-31 is refused instead of failing in PostgreSQL).
export const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().startsWith(v);

// Lookup in an allow-list object that never reaches inherited names (toString, constructor, __proto__…) (ETS-SEC-028).
export const own = (obj, k) => (typeof k === 'string' && Object.hasOwn(obj, k) ? obj[k] : undefined);

// Direction controls that make stored text read differently on screen (LRE RLE PDF LRO RLO, LRI RLI FSI PDI,
// LRM RLM). They are removed from every text value of a request body (ETS-SEC-061).
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
export const stripBidi = s => s.replace(BIDI, '');

// Deepest [ / { nesting outside strings, in one pass over raw UTF-8 bytes (multi-byte sequences are all >= 0x80)
// or over a string. Lets deeply nested JSON be refused before JSON.parse spends seconds on it (ETS-SEC-008).
export const MAX_JSON_DEPTH = 32;
export function jsonDepth(buf) {
  let depth = 0, max = 0, inStr = false;
  for (let i = 0; i < buf.length; i++) {
    const b = typeof buf === 'string' ? buf.charCodeAt(i) : buf[i];
    if (inStr) {
      if (b === 0x5c) i++;                 // backslash: skip the escaped byte
      else if (b === 0x22) inStr = false;
    } else if (b === 0x22) inStr = true;
    else if (b === 0x5b || b === 0x7b) { if (++depth > max) max = depth; }
    else if (b === 0x5d || b === 0x7d) depth--;
  }
  return max;
}
