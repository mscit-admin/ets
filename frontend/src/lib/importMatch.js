// Bulk user import: the values typed in a file (role, language, departments, applications) → ids.
// An id, an Arabic or English name or a short name are accepted; Arabic spelling variants match each other.
//
// THE SAME FILE is used by the server (backend/src/utils/importMatch.js, authoritative) and by the browser
// (frontend/src/lib/importMatch.js, preview display). Keep them identical — backend/test/users-import.test.js checks it.

// Several values in one cell: "," "،" (Arabic comma) ";" "؛" (Arabic semicolon).
export const SEPARATORS = /[,،;؛]/;

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;       // harakat, tanween, shadda, sukun, dagger alif …
const INVISIBLE = /[ـ­؜​-‏‪-‮⁠-⁩﻿]/g; // tatweel, soft hyphen, bidi / zero-width

// The form two spellings must share to be "the same": trimmed, spaces collapsed, lower case; tatweel, diacritics
// and invisible characters removed; أ إ آ ٱ → ا, ؤ ئ → ء (شؤون = شئون), ى → ي, ة → ه; every separator → "," without
// spaces around it.
export function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ؤئ]/g, 'ء')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*[,،;؛]\s*/g, ',')
    .trim();
}

// Languages: the two ids and the usual ways of writing them.
export const LANGUAGES = [
  { id: 'ar', names: ['العربية', 'عربي', 'عربية', 'اللغة العربية', 'Arabic'] },
  { id: 'en', names: ['الإنجليزية', 'إنجليزي', 'انجليزي', 'إنجليزية', 'الإنكليزية', 'إنكليزي', 'اللغة الإنجليزية', 'English'] },
];

// items: [{ id, names: [text …] }] → index for matchOne / matchList.
export function makeIndex(items) {
  const ids = new Map(), names = new Map();
  let maxParts = 1;
  for (const it of items) {
    ids.set(String(it.id).toLowerCase(), it.id);
    for (const n of it.names || []) {
      const k = normalize(n);
      if (!k) continue;
      if (!names.has(k)) names.set(k, new Set());
      names.get(k).add(it.id);
      maxParts = Math.max(maxParts, k.split(',').length);   // a name that itself contains a comma
    }
  }
  return { ids, names, maxParts };
}

// Index builders for the rows of GET /users/meta (or the same tables on the server).
export const roleIndex = roles => makeIndex(roles.map(r => ({ id: r.id, names: [r.name_ar, r.name_en] })));
export const languageIndex = () => makeIndex(LANGUAGES);
export const placeIndex = list => makeIndex(list.map(x => ({ id: x.id, names: [x.name_ar, x.name_en, x.short_ar, x.short_en] })));

// One value → { id } | { error: 'unknown' } | { error: 'ambiguous', matches: [ids] }.
// An exact id wins over a name; "Any label (id)" — a label followed by its id in brackets — is accepted too.
export function matchOne(index, value) {
  const raw = String(value ?? '').replace(INVISIBLE, '').trim();
  const byId = index.ids.get(raw.toLowerCase());
  if (byId !== undefined) return { id: byId };
  const hit = index.names.get(normalize(raw));
  if (hit && hit.size === 1) return { id: [...hit][0] };
  if (hit && hit.size > 1) return { error: 'ambiguous', matches: [...hit].sort() };
  const m = /\(([^()]+)\)$/.exec(raw);
  const inBrackets = m ? index.ids.get(m[1].trim().toLowerCase()) : undefined;
  if (inBrackets !== undefined) return { id: inBrackets };
  return { error: 'unknown' };
}

// A cell (or an array of cells) holding one or more values → { ids, unknown: [text], ambiguous: [{ value, matches }] }.
// Parts are split on the separators; neighbouring parts are joined again when together they form one name that
// contains a separator (e.g. "Setup, Infrastructure & Requirements"). Repeated ids are kept once.
export function matchList(index, value) {
  const cells = Array.isArray(value) ? value : [value];
  const ids = [], unknown = [], ambiguous = [];
  for (const c of cells) {
    if (c == null || typeof c === 'object') { if (c != null) unknown.push(String(c)); continue; }
    const parts = String(c).split(SEPARATORS).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < parts.length;) {
      let took = 0;
      for (let j = Math.min(parts.length, i + index.maxParts); j > i + 1 && !took; j--) {
        const hit = index.names.get(normalize(parts.slice(i, j).join(',')));
        if (hit && hit.size === 1) { ids.push([...hit][0]); took = j - i; }
      }
      if (!took) {
        const r = matchOne(index, parts[i]);
        if (r.id !== undefined) ids.push(r.id);
        else if (r.error === 'ambiguous') ambiguous.push({ value: parts[i], matches: r.matches });
        else unknown.push(parts[i]);
        took = 1;
      }
      i += took;
    }
  }
  return { ids: [...new Set(ids)], unknown, ambiguous };
}
