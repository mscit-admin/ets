// Design tokens of the web UI (frontend/src/styles/app.css, :root), as React Native values.
// Keep in step with app.css: same names in camelCase (--gray-100 → gray100, --text-muted → textMuted).
export const colors = {
  gray50: '#f8f8f8', gray100: '#f3f3f3', gray200: '#ededed', gray300: '#e2e2e2', gray400: '#c7c7c7',
  gray500: '#999999', gray600: '#7c7c7c', gray700: '#525252', gray800: '#383838', gray900: '#171717',
  text: '#1f272e', textMuted: '#6b7280', border: '#ededed', borderStrong: '#dcdcdc',
  bg: '#f4f5f6', card: '#ffffff', white: '#ffffff',
  primary: '#171717', primaryHover: '#383838', primaryBlue: '#2490ef',
  // item types (1.8.0): navy for a function, teal for a report
  itFn: '#1b3a66', itFnBg: '#e8eef7', itFnLine: '#b9c8de',
  itRep: '#0b6e69', itRepBg: '#e0f4f2', itRepLine: '#8fd0c9', itRepStrong: '#0e8a83',
  // ERP module wheel
  erpNavy: '#14315a', erpOff: '#eceff3', erpOffLine: '#c3ccd7', erpOffText: '#56616e', erpTrack: '#dde5ef',
  erpOffIcon: '#8794a3', erpScope: '#f3f5f8', erpSwatchOn: '#24508a',
  // notifications
  unreadBg: '#f5f9ff', bellCritical: '#d42f2f',
} as const;

// Indicator pills: background + text of each colour (.indicator-pill.<colour>)
export const pills = {
  green: { bg: '#e4f5e9', text: '#16794c' },
  blue: { bg: '#e6f4ff', text: '#0b6bcb' },
  orange: { bg: '#fff1e7', text: '#c45c11' },
  red: { bg: '#fff0f0', text: '#cc2929' },
  yellow: { bg: '#fff7d3', text: '#a07b07' },
  amber: { bg: '#fff3d6', text: '#9a6700' },
  purple: { bg: '#f5f0ff', text: '#6e46c6' },
  cyan: { bg: '#e6f9fb', text: '#0f7c8c' },
  gray: { bg: '#f3f3f3', text: '#525252' },
} as const;
export type PillName = keyof typeof pills;

// Progress bar fills (.progress-bar.<colour>), chosen by pctColor()
export const bars = { green: '#30a66d', blue: colors.primaryBlue, orange: '#f0883a', red: '#e24c4c', gray: colors.gray400 } as const;
// Segments of the test status bar (.stack-bar .seg.<colour>)
export const stackSeg = { green: '#30a66d', orange: '#f0883a', red: '#e24c4c', gray: colors.gray300, blue: '#2a78d6', amber: '#e8a73c' } as const;

export const radius = { sm: 6, md: 8, lg: 12, pill: 999 } as const;          // --radius 8px, --radius-lg 12px
export const space = { xxs: 2, xs: 4, s: 6, m: 8, l: 12, xl: 16, xxl: 24 } as const;
export const fontSize = { xs: 11.5, s: 12, m: 13, base: 14, l: 16, xl: 18, xxl: 24, huge: 30 } as const;

// --shadow-sm / --shadow (React Native 0.76+ boxShadow, also on the web preview). The 1px "border ring" of the web
// cards is drawn as a real border (borderWidth 1, colors.border) so it shows on every platform.
export const shadows = {
  sm: '0px 1px 2px rgba(0, 0, 0, 0.05)',
  md: '0px 0px 1px rgba(0, 0, 0, 0.35), 0px 6px 8px -4px rgba(0, 0, 0, 0.1)',
} as const;
