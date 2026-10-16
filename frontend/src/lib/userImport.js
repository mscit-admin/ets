// Bulk user import: the template, reading an .xlsx / .csv file in the browser, and the files offered back
// (error report, one-time passwords). The server receives JSON rows only (POST /api/users/import[/preview]).
// .xlsx is read with read-excel-file; the template (drop-down lists = Excel data validation) is written with exceljs,
// the error report and the passwords file with write-excel-file — all loaded on demand (not in the main bundle).
import { languageIndex, matchList, matchOne, normalize, placeIndex, roleIndex } from './importMatch.js';

// The columns sent to the API. The template adds department_2/3 and application_2/3 (one more drop-down each);
// an older file with the seven columns only is read the same way.
export const COLUMNS = ['username', 'full_name', 'email', 'role', 'language', 'departments', 'applications'];
export const EXTRA = { departments: ['department_2', 'department_3'], applications: ['application_2', 'application_3'] };
export const TEMPLATE_COLUMNS = ['username', 'full_name', 'email', 'role', 'language',
  'departments', ...EXTRA.departments, 'applications', ...EXTRA.applications];
const REQUIRED = ['username', 'full_name', 'role'];
export const MAX_ROWS = 500;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ---- CSV ----
// RFC 4180: UTF-8 (a BOM is dropped), quoted fields with "" escapes, separators and line breaks inside quotes,
// CRLF / LF / CR line ends. A ';'-separated file (Excel in some regional settings) is recognised by its header.
export function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const firstLine = s.slice(0, s.search(/\r|\n|$/));
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows = [];
  let row = [], field = '', quoted = false, i = 0;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue; }
    if (ch === sep) { endField(); i++; continue; }
    if (ch === '\r' || ch === '\n') { endRow(); i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

// A value written into a CSV cell. Text that a spreadsheet could run as a formula gets a leading apostrophe, so an
// exported error report cannot carry a formula back into Excel — same rule as the server's log exports
// (backend/src/utils/csv.js, ETS-SEC-059): = + - @ | and their full-width forms after any leading
// whitespace / invisible characters, or a cell that starts with tab, CR or LF.
const LEAD = '[\\s\\u0000-\\u001f\\u007f\\u00a0\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\u3000]*';
const FORMULA = new RegExp('^' + LEAD + '[=+\\-@|\\uff1d\\uff0b\\uff0d\\uff20]');
const csvCell = v => {
  let s = v == null ? '' : String(v);
  if (FORMULA.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return /[",\r\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// UTF-8 with BOM and CRLF, so Excel opens Arabic text correctly.
export const toCsv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

// ---- reading a file → rows ----
const cellText = v => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
};

// A header cell → column id: "role / الدور" → "role", "Full name" → "full_name".
const headerId = h => cellText(h).split('/')[0].trim().toLowerCase().replace(/\s+/g, '_');

// → { rows: [{ line, username, full_name, … }], missing: [column names] }. Empty lines are skipped;
// `line` is the row number in the file (header = 1), shown next to each result.
export function sheetToRows(table) {
  const [head = [], ...body] = table;
  const names = head.map(headerId);
  const idx = Object.fromEntries(TEMPLATE_COLUMNS.map(c => [c, names.indexOf(c)]));
  const missing = REQUIRED.filter(c => idx[c] < 0);
  const rows = [];
  body.forEach((r, n) => {
    const o = { line: n + 2 };
    for (const c of TEMPLATE_COLUMNS) o[c] = idx[c] >= 0 ? cellText(r[idx[c]]) : '';
    if (TEMPLATE_COLUMNS.some(c => o[c] !== '')) rows.push(o);
  });
  return { rows, missing };
}

export async function readImportFile(file) {
  if (file.size > MAX_FILE_BYTES) throw Object.assign(new Error('file_too_large'), { code: 'import_file_too_large' });
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv')) return sheetToRows(parseCsv(await file.text()));
  if (name.endsWith('.xlsx')) {
    const { default: readXlsxFile } = await import('read-excel-file/browser');
    let sheets;
    try { sheets = await readXlsxFile(file); } catch { throw Object.assign(new Error('bad_file'), { code: 'import_bad_file' }); }
    const sheet = sheets.find(s => s.sheet.toLowerCase() === 'users') || sheets[0];
    return sheetToRows(sheet?.data || []);
  }
  throw Object.assign(new Error('bad_type'), { code: 'import_bad_type' });
}

// Row as sent to the API (the file's line number stays in the browser). Departments / applications go as the list
// of their cells (main column + the extra ones); the server matches ids and names in each cell.
const cellsOf = (r, c) => [r[c], ...EXTRA[c].map(x => r[x])].filter(Boolean);
export const apiRow = r => ({ username: r.username, full_name: r.full_name, email: r.email, role: r.role, language: r.language,
  departments: cellsOf(r, 'departments'), applications: cellsOf(r, 'applications') });
// The departments / applications of a row as one text (preview, error report).
export const listText = (r, c) => cellsOf(r, c).join('، ');

// ---- names → ids, for the preview (same matching code as the server: lib/importMatch.js) ----
export function matchers(meta) {
  return { role: roleIndex(meta.roles), language: languageIndex(),
    departments: placeIndex(meta.departments), applications: placeIndex(meta.applications) };
}
// → { role: id|null, language: 'ar'|'en'|''|null, departments: [ids], applications: [ids] } (null = not recognised)
export function resolveRow(ix, r) {
  const role = matchOne(ix.role, r.role).id ?? null;
  const language = r.language ? matchOne(ix.language, r.language).id ?? null : '';
  return { role, language, departments: matchList(ix.departments, cellsOf(r, 'departments')).ids,
    applications: matchList(ix.applications, cellsOf(r, 'applications')).ids };
}

// ---- files offered for download ----
export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
export const downloadCsv = (filename, rows) => downloadBlob(filename, new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));

// sheets: [{ name, rows: [[…]], widths?: [n], rtl? }] — the first row of each sheet is shown in bold.
export async function downloadXlsx(filename, sheets) {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const data = sheets.map(s => ({
    sheet: s.name, rightToLeft: !!s.rtl, stickyRowsCount: 1,
    columns: s.widths?.map(width => ({ width })),
    data: s.rows.map((r, i) => r.map(v => ({ value: v == null ? '' : String(v), type: String, ...(i === 0 || s.bold?.includes(i) ? { fontWeight: 'bold' } : {}) }))),
  }));
  downloadBlob(filename, await writeXlsxFile(data).toBlob());
}

// Help lists (roles, departments, applications) from GET /users/meta, in both languages.
export function helpRows(meta, t) {
  const rows = [[t('imp_help_kind'), 'id', 'العربية', 'English', t('imp_help_note')]];
  const bold = [];
  const section = title => { rows.push([]); bold.push(rows.length); rows.push([title]); };
  section(t('imp_help_columns'));
  for (const c of TEMPLATE_COLUMNS) rows.push([t('imp_help_column'), c, '', '', t('imp_col_' + c)]);
  section(t('role'));
  for (const r of meta.roles) rows.push([t('role'), r.id, r.name_ar, r.name_en, r.full_scope ? t('full_scope') : t('imp_scope_needed')]);
  section(t('imp_departments'));
  for (const d of meta.departments) rows.push([t('imp_departments'), d.id, d.name_ar, d.name_en, '']);
  section(t('imp_applications'));
  for (const a of meta.applications) rows.push([t('imp_applications'), a.id, a.name_ar, a.name_en, a.department_id]);
  return { rows, bold };
}

// ---- the .xlsx template ----
// Sheet "users": header "id / readable name", frozen; drop-down lists (data validation, type list) on role, language,
// the three department and the three application columns for rows 2–501. The lists hold the names in the UI
// language and live on the hidden sheet "lists" (a range reference: an inline list is limited to 255 characters and
// breaks on commas). The alert only WARNS, so several values typed with commas are still accepted. Sheet "help":
// the columns and every id with its Arabic and English name.
const LAST_ROW = MAX_ROWS + 1;
const WIDTHS = { username: 18, full_name: 28, email: 26, role: 24, language: 14, departments: 34, department_2: 30, department_3: 30,
  applications: 30, application_2: 26, application_3: 26 };
const colLetter = n => { let s = ''; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// The drop-down texts: the name in the UI language; a name that two items share gets its id in brackets
// ("Name (id)", also accepted on upload).
export function listLabels(items, label) {
  const seen = new Map();
  for (const it of items) { const k = normalize(label(it)); seen.set(k, (seen.get(k) || 0) + 1); }
  return items.map(it => (seen.get(normalize(label(it))) > 1 || !label(it) ? `${label(it)} (${it.id})` : label(it)));
}

// ExcelJS: the module (browser: loaded on demand; node: for checks) → ExcelJS.Workbook with the three sheets.
export function buildTemplate(ExcelJS, meta, t, lang) {
  const name = o => (lang === 'en' ? o.name_en || o.name_ar : o.name_ar || o.name_en);
  const lists = {
    role: listLabels(meta.roles, name),
    language: [t('au_lang_ar'), t('au_lang_en')],
    departments: listLabels(meta.departments, name),
    applications: listLabels(meta.applications, name),
  };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ETS';
  const rtl = lang === 'ar';
  const ws = wb.addWorksheet('users', { views: [{ state: 'frozen', xSplit: 0, ySplit: 1, rightToLeft: rtl }] });
  ws.columns = TEMPLATE_COLUMNS.map(c => ({ key: c, width: WIDTHS[c] }));
  const head = ws.getRow(1);
  TEMPLATE_COLUMNS.forEach((c, i) => { head.getCell(i + 1).value = `${c} / ${t('imp_h_' + c)}`; });
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 32;
  TEMPLATE_COLUMNS.forEach((c, i) => {
    head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REQUIRED.includes(c) ? 'FFFCE4B6' : 'FFE8EEF5' } };
  });
  for (const c of ['username', 'email']) ws.getColumn(TEMPLATE_COLUMNS.indexOf(c) + 1).numFmt = '@';   // text, never a number / date

  const ls = wb.addWorksheet('lists', { state: 'hidden', views: [{ rightToLeft: rtl }] });
  const listCols = [['role', t('role')], ['language', t('language')], ['departments', t('imp_departments')], ['applications', t('imp_applications')]];
  const ranges = {};
  listCols.forEach(([key, title], i) => {
    const col = colLetter(i);
    ls.getColumn(i + 1).width = 40;
    ls.getCell(`${col}1`).value = title;
    ls.getCell(`${col}1`).font = { bold: true };
    lists[key].forEach((v, n) => { ls.getCell(`${col}${n + 2}`).value = v; });
    if (lists[key].length) ranges[key] = `lists!$${col}$2:$${col}$${lists[key].length + 1}`;
  });

  const validation = (list, prompt) => ({ type: 'list', allowBlank: true, formulae: [ranges[list]],
    showInputMessage: true, promptTitle: t('imp_dv_title'), prompt,
    showErrorMessage: true, errorStyle: 'warning', errorTitle: t('imp_dv_error_title'), error: t('imp_dv_error') });
  const dv = (col, list, prompt) => {
    if (!ranges[list]) return;
    const L = colLetter(TEMPLATE_COLUMNS.indexOf(col));
    ws.dataValidations.add(`${L}2:${L}${LAST_ROW}`, validation(list, prompt));
  };
  dv('role', 'role', t('imp_dv_role'));
  dv('language', 'language', t('imp_dv_language'));
  for (const k of ['departments', 'applications']) {
    dv(k, k, t('imp_dv_' + k));
    for (const x of EXTRA[k]) dv(x, k, t('imp_dv_extra'));
  }

  const help = helpRows(meta, t);
  const hs = wb.addWorksheet('help', { views: [{ rightToLeft: rtl }] });
  [16, 16, 38, 38, 48].forEach((w, i) => { hs.getColumn(i + 1).width = w; });
  help.rows.forEach((r, i) => {
    const row = hs.getRow(i + 1);
    r.forEach((v, j) => { row.getCell(j + 1).value = v == null ? '' : String(v); });
    if (i === 0 || help.bold.includes(i)) row.font = { bold: true };
  });
  return wb;
}

export async function downloadTemplate(kind, meta, t, lang) {
  if (kind === 'csv') return downloadCsv('ets-users-template.csv', [TEMPLATE_COLUMNS]);
  const mod = await import('exceljs');
  const wb = buildTemplate(mod.default || mod, meta, t, lang);
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob('ets-users-template.xlsx', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
