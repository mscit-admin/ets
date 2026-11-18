// ERP module wheel of the dashboard (components/ErpWheel.jsx).
//
// Since 1.12.62 the wheel is DEPARTMENT-DRIVEN: each department is a wheel segment and controls its own appearance
// through its wheel_* columns (migration 038), all editable from the structure screen — wheel_show (draw it or not),
// wheel_icon (falls back to emblem), wheel_label_ar/en (falls back to the short name) and wheel_order (position).
// A new department appears on the wheel automatically; nothing here needs editing to add or reorder a module.
//
// STANDARD_MODULES / EXTRA_MODULES below are LEGACY: they no longer drive the wheel (wheelSegments ignores them).
// They remain only so MoveDialog / the mobile item dialog can still show the classic module name beside a department
// in their pickers (moduleOf). Safe to leave as-is.
export const STANDARD_MODULES = [
  { key: 'hr', icon: 'people', name_ar: 'الموارد البشرية', name_en: 'Human Resources', lines_en: ['Human', 'Resources'], depts: ['hr'] },
  { key: 'sales', icon: 'megaphone', name_ar: 'المبيعات والتسويق', name_en: 'Sales & Marketing', lines_ar: ['المبيعات', 'والتسويق'], lines_en: ['Sales &', 'Marketing'], depts: ['com'] },
  { key: 'finance', icon: 'coins', name_ar: 'المالية والمحاسبة', name_en: 'Finance & Accounting', lines_ar: ['المالية', 'والمحاسبة'], lines_en: ['Finance &', 'Accounting'], depts: ['fin'] },
];

// Departments of the system that are not one of the standard modules: they keep a segment of their own, after the
// standard ones, so a tracked department is never hidden. Listed here so the wheel keeps the same layout for
// every reader; a department missing from both lists still gets a segment (named after the department).
export const EXTRA_MODULES = [
  { key: 'infrastructure', icon: 'server', name_ar: 'البنية التحتية', name_en: 'Infrastructure', depts: ['inf'] },
];

// Split a wheel label into at most two balanced lines when it is long and has a space, so a two-word module name
// (e.g. «المبيعات والتسويق») wraps inside the segment instead of running off it. Short names stay on one line.
function wheelLines(name) {
  const s = String(name || '').trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < 2 || s.length <= 12) return [s];
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/**
 * Segments of the wheel, built from the departments of /api/tracker/summary (already limited to the reader's scope).
 * Each visible department (wheel_show !== false) is one 'active' segment, ordered by wheel_order (then sort), drawn
 * with its wheel_icon / wheel_label (falling back to emblem / short name). A hidden department (wheel_show === false)
 * is left off the wheel but still counts in the hub total. The `fullScope` option is accepted for signature
 * compatibility and no longer used (out-of-scope departments are simply absent from the summary).
 */
export function wheelSegments(departments, _opts = {}) {
  return departments
    .filter(d => d.wheel_show !== false)
    .slice()
    .sort((a, b) => (a.wheel_order ?? a.sort ?? 0) - (b.wheel_order ?? b.sort ?? 0) || (a.sort ?? 0) - (b.sort ?? 0))
    .map(d => {
      const name_ar = d.wheel_label_ar || d.short_ar || d.name_ar;
      const name_en = d.wheel_label_en || d.short_en || d.name_en;
      return {
        key: d.id, icon: d.wheel_icon || d.emblem || 'layers', name_ar, name_en,
        lines_ar: wheelLines(name_ar), lines_en: wheelLines(name_en),
        depts: [d.id], state: 'active', pct: +d.pct || 0, dept: d, departments: [d],
      };
    });
}
