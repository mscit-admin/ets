// Excel (xlsx) files for the report exports (routes/export.js). One sheet: a title row (report name), a line with
// the exporter, the time and the filters, then a bold, frozen header row with an autofilter and the data rows.
// Every string is written as a plain value — never as a formula — after the same formula neutralisation as the
// CSV exports (ETS-SEC-059), so a function name such as "=HYPERLINK(...)" stays text in any spreadsheet.
import ExcelJS from 'exceljs';
import { neutralise } from '../utils/csv.js';

// Characters XML 1.0 cannot carry (the file would not open) are dropped.
const BAD_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const MAX_CELL = 32767;           // Excel's limit for one cell

export const textCell = v => {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return neutralise(s.replace(BAD_XML, '')).slice(0, MAX_CELL);
};

const FORMAT = { pct: '0.0%', number: '#,##0.##', int: '0', date: 'yyyy-mm-dd', datetime: 'yyyy-mm-dd hh:mm' };
const WIDTH = { pct: 11, number: 11, int: 9, date: 12, datetime: 17 };

// A value as stored in the cell for a column type. Percentages arrive as 0–100 and are stored as fractions.
function cellValue(type, v) {
  if (v === null || v === undefined || v === '') return null;
  switch (type) {
    case 'pct': return Number.isFinite(+v) ? +v / 100 : null;
    case 'number': case 'int': return Number.isFinite(+v) ? +v : textCell(v);
    case 'date': case 'datetime': {
      const d = v instanceof Date ? v : new Date(v);
      return Number.isNaN(d.getTime()) ? textCell(v) : d;
    }
    default: return textCell(v);
  }
}

const widthOf = v => (v === null || v === undefined ? 0 : String(v).split('\n').reduce((a, l) => Math.max(a, l.length), 0));

/**
 * @param {object} o
 * @param {string} o.title       report name (first row, also the sheet name)
 * @param {string} o.subtitle    exporter, time and filters (second row)
 * @param {'ar'|'en'} o.lang     'ar' → right-to-left sheet
 * @param {{key:string, header:string, type?:string, typeKey?:string, width?:number}[]} o.columns
 *        type: text (default), int, number, pct (0–100, stored as a fraction), date, datetime; typeKey: the row field
 *        holding the type of that row's cell instead
 * @param {object[]} o.rows      plain objects; o.columns[i].key picks the value
 * @returns {Promise<Buffer>}
 */
export async function buildWorkbook({ title, subtitle, lang, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ETS';
  wb.created = new Date();
  // sheet names: at most 31 characters, none of : \ / ? * [ ]
  const name = String(title).replace(/[:\\/?*[\]]/g, ' ').slice(0, 31).trim() || 'Sheet1';
  const HEAD = 4;                 // title, subtitle, blank, header
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: HEAD, xSplit: 0, rightToLeft: lang === 'ar', topLeftCell: 'A' + (HEAD + 1) }],
  });

  ws.getCell(1, 1).value = textCell(title);
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  ws.getCell(2, 1).value = textCell(subtitle);
  ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF555555' } };

  const header = ws.getRow(HEAD);
  columns.forEach((c, i) => { header.getCell(i + 1).value = textCell(c.header); });
  header.font = { bold: true };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF8899AA' } } };
  });

  const widths = columns.map(c => Math.max(widthOf(c.header), WIDTH[c.type] || 8));
  for (const r of rows) {
    const types = columns.map(c => (c.typeKey ? r[c.typeKey] : c.type) || 'text');
    const row = ws.addRow(columns.map((c, i) => cellValue(types[i], r[c.key])));
    columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (FORMAT[types[i]] && cell.value !== null) cell.numFmt = FORMAT[types[i]];
      widths[i] = Math.max(widths[i], types[i] === 'text' ? widthOf(cell.value) : WIDTH[types[i]] || 10);
    });
  }
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width || Math.min(60, Math.max(8, widths[i] + 2)); });
  if (columns.length) ws.autoFilter = { from: { row: HEAD, column: 1 }, to: { row: HEAD + rows.length, column: columns.length } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Content-Disposition with an ASCII fallback and the translated name as RFC 5987 UTF-8 (filename*).
export function contentDisposition(asciiName, utf8Name) {
  const ascii = String(asciiName).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export.xlsx';
  const enc = encodeURIComponent(String(utf8Name || ascii).replace(/[\u0000-\u001f\u007f"\\/]/g, ' '))
    .replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
