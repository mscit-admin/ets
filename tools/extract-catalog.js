#!/usr/bin/env node
/*
 * Extracts the tracker catalog (departments, applications, functions) from the
 * original single-file tracker (reference/erp-tracker-original.html) and writes
 * backend/src/db/seed/catalog.json, which the database seeder loads.
 *
 * Function codes are kept identical to the original file (D0.., X0..) so that
 * a state exported from the original page can be imported without remapping:
 *   - D codes: design items first, then the vendor function-list items (XL)
 *     appended after them, exactly as the original page concatenates them.
 *   - X codes: "from experience" items, after the DROP list was removed.
 *
 * Usage: node tools/extract-catalog.js [path/to/original.html]
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = process.argv[2] || path.join(root, 'reference/erp-tracker-original.html');
const out = path.join(root, 'backend/src/db/seed/catalog.json');

const lines = fs.readFileSync(src, 'utf8').split('\n');
const start = lines.findIndex(l => l.startsWith('const DIRS'));
const end = lines.findIndex(l => l.startsWith('/* ========== 2.'));
if (start < 0 || end < 0) throw new Error('Catalog block not found in ' + src);

// The block is plain data plus two loops (DROP removal, XL concat); evaluate it.
const block = lines.slice(start, end).join('\n');
const { DIRS, APPS, FN, XL } = new Function(block + ';return {DIRS,APPS,FN,XL};')();

const DIR_EN = {
  hr: ['Human Resources & Services', 'Human Resources'],
  fin: ['Finance', 'Finance'],
  com: ['Commercial', 'Commercial'],
  inf: ['Setup, Infrastructure & Requirements', 'Infrastructure'],
};
const APP_EN = {
  per: 'Personnel Affairs', rec: 'Recruitment', att: 'Time & Attendance', lev: 'Leave',
  pay: 'Payroll & Advances', apr: 'Appraisal', req: 'Requests & Approval Workflows',
  ess: 'Employee Self-Service & Mobile App', pur: 'Purchasing', inv: 'Inventory / Stores',
  trn: 'Training & Development', hlt: 'Healthcare', dms: 'Documents & Correspondence',
  flt: 'Fleet Management', acc: 'Accounting', pmt: 'Payments', rcp: 'Receipts',
  fa: 'Fixed Assets', lc: 'Letters of Credit', ctr: 'Contract Lifecycle', sal: 'Sales',
  sub: 'Subscriber Services', srv: 'Servers & Storage', dbs: 'Database & Licences',
  net: 'Network & Branch Connectivity', env: 'Environments & Deployment',
  bkp: 'Backup & Recovery', sec: 'Security, Permissions & Handover',
  mig: 'Data Migration', trg: 'Training & Knowledge Transfer',
};
const COLORS = { hr: '#2490ef', fin: '#29cd42', com: '#ecad4b', inf: '#e24c4c' };

const xlCount = id => (XL[id] || []).length;

const catalog = {
  generatedFrom: path.basename(src),
  departments: DIRS.map((d, i) => ({
    id: d.id, name_ar: d.name, short_ar: d.short,
    name_en: DIR_EN[d.id][0], short_en: DIR_EN[d.id][1],
    color: COLORS[d.id] || '#2490ef', emblem: d.emb, is_base: !!d.base, sort: i + 1,
  })),
  applications: APPS.map((a, i) => ({
    id: a.id, department_id: a.dir, name_ar: a.name, name_en: APP_EN[a.id] || a.name,
    sub_ar: a.sub || null, icon: a.icon, weight: a.w,
    note_ar: a.note || null, addendum: a.brd || null,
    scope_cut: !!a.cut, extra_module: !!a.xl, sort: i + 1,
  })),
  functions: [],
};

for (const a of APPS) {
  const b = FN[a.id] || { D: [], X: [] };
  const designCount = b.D.length - xlCount(a.id);
  b.D.forEach((r, i) => catalog.functions.push({
    app_id: a.id, code: 'D' + i, source: i < designCount ? 'design' : 'vendor_list',
    name_ar: r[0], reference: r[1] || null, vendor_status: r[2] || 0, enabled: true, sort: i,
  }));
  b.X.forEach((r, i) => catalog.functions.push({
    app_id: a.id, code: 'X' + i, source: 'experience',
    name_ar: r[0], reference: r[1] || null, vendor_status: r[2] || 0, enabled: false, sort: 1000 + i,
  }));
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(catalog, null, 1) + '\n');
console.log(`Wrote ${out}: ${catalog.departments.length} departments, ` +
  `${catalog.applications.length} applications, ${catalog.functions.length} functions`);
