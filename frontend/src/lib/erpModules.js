// ERP module wheel of the dashboard (components/ErpWheel.jsx) — the list of modules and which department of the
// system feeds each one. Edit this file to rename, reorder or remap modules; nothing else needs to change.
//
//   key       stable identifier of the module (never shown)
//   icon      line icon name from components/Icon.jsx
//   name_*    label on the wheel; lines_* optionally splits it over two lines inside the segment
//   depts     ids of the departments (table departments, backend/src/db/seed/catalog.json) whose progress this
//             module shows. A module without a department of the system is drawn faded: «غير مفعّل» / "Not activated".
//
// Order = position around the wheel, clockwise from the top (mirrored in Arabic), as in the standard ERP figure.
export const STANDARD_MODULES = [
  { key: 'production', icon: 'factory', name_ar: 'الإنتاج', name_en: 'Production', depts: [] },
  { key: 'hr', icon: 'people', name_ar: 'الموارد البشرية', name_en: 'Human Resources', lines_en: ['Human', 'Resources'], depts: ['hr'] },
  { key: 'planning', icon: 'planning', name_ar: 'التخطيط', name_en: 'Planning', depts: [] },
  { key: 'inventory', icon: 'box', name_ar: 'إدارة المخزون', name_en: 'Inventory Management', lines_en: ['Inventory', 'Management'], depts: [] },
  { key: 'reporting', icon: 'chart', name_ar: 'التقارير', name_en: 'Reporting', depts: [] },
  { key: 'crm', icon: 'crm', name_ar: 'علاقات العملاء', name_en: 'CRM', depts: [] },
  { key: 'sales', icon: 'megaphone', name_ar: 'المبيعات والتسويق', name_en: 'Sales & Marketing', lines_ar: ['المبيعات', 'والتسويق'], lines_en: ['Sales &', 'Marketing'], depts: ['com'] },
  { key: 'finance', icon: 'coins', name_ar: 'المالية والمحاسبة', name_en: 'Finance & Accounting', lines_ar: ['المالية', 'والمحاسبة'], lines_en: ['Finance &', 'Accounting'], depts: ['fin'] },
];

// Departments of the system that are not one of the standard modules: they keep a segment of their own, after the
// standard ones, so a tracked department is never hidden. Listed here so the wheel keeps the same layout for
// every reader; a department missing from both lists still gets a segment (named after the department).
export const EXTRA_MODULES = [
  { key: 'infrastructure', icon: 'server', name_ar: 'البنية التحتية', name_en: 'Infrastructure', depts: ['inf'] },
];

/**
 * Segments of the wheel for the departments of /api/tracker/summary (already limited to the reader's scope).
 *   state 'active'      — a department in the summary: pct = its progress (weighted when several)
 *   state 'inactive'    — a standard module with no department in the system
 *   state 'out_of_scope'— the module's department exists but is outside the reader's scope (no % is shown)
 * fullScope: the reader sees every department (a mapped department missing from the summary then no longer exists).
 */
export function wheelSegments(departments, { fullScope }) {
  const byId = new Map(departments.map(d => [d.id, d]));
  const used = new Set();
  const seg = (m, extra) => {
    const ds = m.depts.map(id => byId.get(id)).filter(Boolean);
    ds.forEach(d => used.add(d.id));
    if (ds.length) {
      const w = ds.reduce((a, d) => a + (+d.weight || 0), 0);
      const pct = w > 0 ? ds.reduce((a, d) => a + (+d.weight || 0) * (+d.pct || 0), 0) / w : ds.reduce((a, d) => a + (+d.pct || 0), 0) / ds.length;
      return { ...m, state: 'active', pct, dept: ds[0], departments: ds };
    }
    if (!m.depts.length) return { ...m, state: 'inactive' };
    if (!fullScope) return { ...m, state: 'out_of_scope' };
    return extra ? null : { ...m, state: 'inactive' };     // an extra module whose department was removed: no segment
  };
  const out = [...STANDARD_MODULES.map(m => seg(m, false)), ...EXTRA_MODULES.map(m => seg(m, true))].filter(Boolean);
  for (const d of departments) {
    if (used.has(d.id)) continue;
    out.push({ key: 'dept:' + d.id, icon: d.emblem || 'layers', name_ar: d.short_ar || d.name_ar, name_en: d.short_en || d.name_en,
      depts: [d.id], state: 'active', pct: +d.pct || 0, dept: d, departments: [d] });
  }
  return out;
}
