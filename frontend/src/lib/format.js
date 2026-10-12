export const pc = v => (Math.round((+v || 0) * 10) / 10).toFixed(1);

// ERPNext-style indicator colour for a percentage
export const pctColor = v => (v >= 90 ? 'green' : v >= 60 ? 'blue' : v >= 30 ? 'orange' : v > 0 ? 'red' : 'gray');

export const TEST_COLORS = ['gray', 'orange', 'green', 'red'];
export const VENDOR_COLORS = ['gray', 'green', 'orange', 'blue'];
export const NOTIF_COLORS = ['gray', 'green', 'orange', 'red'];
export const REVIEW_COLORS = ['gray', 'green', 'red', 'orange'];
export const REPORT_COLORS = ['gray', 'green', 'red', 'orange'];
