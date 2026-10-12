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
