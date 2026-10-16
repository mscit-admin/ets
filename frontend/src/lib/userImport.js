// Bulk user import: the template, reading an .xlsx / .csv file in the browser, and the files offered back
// (error report, one-time passwords). The server receives JSON rows only (POST /api/users/import[/preview]).
// .xlsx is read and written with read-excel-file / write-excel-file, loaded on demand (not in the main bundle).

export const COLUMNS = ['username', 'full_name', 'email', 'role', 'language', 'departments', 'applications'];
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

// → { rows: [{ line, username, full_name, … }], missing: [column names] }. Empty lines are skipped;
// `line` is the row number in the file (header = 1), shown next to each result.
export function sheetToRows(table) {
  const [head = [], ...body] = table;
  const names = head.map(h => cellText(h).toLowerCase().replace(/\s+/g, '_'));
  const idx = Object.fromEntries(COLUMNS.map(c => [c, names.indexOf(c)]));
  const missing = REQUIRED.filter(c => idx[c] < 0);
  const rows = [];
  body.forEach((r, n) => {
    const o = { line: n + 2 };
    for (const c of COLUMNS) o[c] = idx[c] >= 0 ? cellText(r[idx[c]]) : '';
    if (COLUMNS.some(c => o[c] !== '')) rows.push(o);
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

// Row as sent to the API (the file's line number stays in the browser).
export const apiRow = r => ({ username: r.username, full_name: r.full_name, email: r.email, role: r.role, language: r.language,
  departments: r.departments, applications: r.applications });

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
  for (const c of COLUMNS) rows.push([t('imp_help_column'), c, '', '', t('imp_col_' + c)]);
  section(t('role'));
  for (const r of meta.roles) rows.push([t('role'), r.id, r.name_ar, r.name_en, r.full_scope ? t('full_scope') : t('imp_scope_needed')]);
  section(t('imp_departments'));
  for (const d of meta.departments) rows.push([t('imp_departments'), d.id, d.name_ar, d.name_en, '']);
  section(t('imp_applications'));
  for (const a of meta.applications) rows.push([t('imp_applications'), a.id, a.name_ar, a.name_en, a.department_id]);
  return { rows, bold };
}

export function downloadTemplate(kind, meta, t, lang) {
  if (kind === 'csv') return downloadCsv('ets-users-template.csv', [COLUMNS]);
  const help = helpRows(meta, t);
  return downloadXlsx('ets-users-template.xlsx', [
    { name: 'users', rows: [COLUMNS], widths: [18, 28, 26, 10, 10, 18, 22] },
    { name: 'help', rows: help.rows, bold: help.bold, widths: [16, 10, 34, 34, 40], rtl: lang === 'ar' },
  ]);
}
