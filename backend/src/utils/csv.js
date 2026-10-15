// CSV cells for the log exports, safe to open in a spreadsheet (ETS-SEC-059).
// A cell that a spreadsheet could read as a formula gets a leading apostrophe. Checked after any leading
// whitespace, control or invisible characters, because spreadsheets skip those before looking for a formula:
//   = + - @ |  and their full-width forms (U+FF1D U+FF0B U+FF0D U+FF20, which some locales treat the same),
//   and any cell that itself starts with a tab, CR or LF.
const LEAD = '[\\s\\u0000-\\u001f\\u007f\\u00a0\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff\\u3000]*';
const FORMULA = new RegExp('^' + LEAD + '[=+\\-@|\\uff1d\\uff0b\\uff0d\\uff20]');
const CONTROL_START = /^[\t\r\n]/;

export const neutralise = s => (FORMULA.test(s) || CONTROL_START.test(s) ? "'" + s : s);

export const csvCell = v => {
  const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return '"' + neutralise(s).replace(/"/g, '""') + '"';
};
