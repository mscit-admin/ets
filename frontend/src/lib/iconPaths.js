// SVG icon set: the inner markup of a 24×24 line icon (stroke = currentColor), by name. Plain data, no imports:
// used by components/Icon.jsx and by the mobile app (mobile/, React Native), so both draw the same icons.
// Icon paths: application icons are taken from the original tracker; UI icons added for the app shell.
const APP = {
person:'<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5"/>',
recruit:'<circle cx="10" cy="8" r="3.2"/><path d="M3.6 20c0-3.4 2.8-5.2 6.4-5.2.8 0 1.6.1 2.3.3"/><path d="M17.5 14.5v6M14.5 17.5h6"/>',
clock:'<circle cx="12" cy="12" r="8.2"/><path d="M12 7v5.2l3.3 2"/>',
calendar:'<rect x="3.4" y="5" width="17.2" height="15.4" rx="2.2"/><path d="M3.4 10h17.2M8 3.2v3.6M16 3.2v3.6"/>',
cash:'<rect x="2.6" y="6" width="18.8" height="12" rx="2.2"/><circle cx="12" cy="12" r="2.7"/><path d="M6 9.2v5.6M18 9.2v5.6"/>',
star:'<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/>',
cart:'<path d="M2.8 4.2H5l2.3 11h10.5l2.1-8H6.3"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="17.5" cy="19" r="1.5"/>',
box:'<path d="M12 3l8 4.2v9.6L12 21l-8-4.2V7.2z"/><path d="M4 7.2l8 4.2 8-4.2M12 11.4V21"/>',
cap:'<path d="M12 4l9.4 4.4L12 12.8 2.6 8.4z"/><path d="M6.6 10.6V16c0 1.7 2.4 3 5.4 3s5.4-1.3 5.4-3v-5.4"/>',
health:'<path d="M20.4 8.9a4.6 4.6 0 0 0-8.4-2.5 4.6 4.6 0 0 0-8.4 2.5c0 4.6 8.4 10 8.4 10s8.4-5.4 8.4-10z"/>',
doc:'<path d="M6.2 3h7.6l4 4v14H6.2z"/><path d="M13.8 3v4h4M9.2 12.5h6M9.2 16h4.5"/>',
truck:'<path d="M3 7h11v9H3z"/><path d="M14 10.5h3.8l3 3V16H14z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17.5" cy="18" r="1.6"/>',
ledger:'<path d="M5.2 4.4h11.6a2 2 0 0 1 2 2v13.2H7.2a2 2 0 0 1-2-2z"/><path d="M5.2 17.2h13.6M9.4 8.2h6M9.4 11.8h6"/>',
out:'<path d="M12 14.5V3.5M7.6 7.9 12 3.5l4.4 4.4"/><path d="M4 17.5h16v3H4z"/>',
in:'<path d="M12 3.5v11M7.6 10.1 12 14.5l4.4-4.4"/><path d="M4 17.5h16v3H4z"/>',
asset:'<path d="M4 20.6V9.2l8-5.2 8 5.2v11.4"/><path d="M4 20.6h16M9.6 20.6v-5h4.8v5M9.4 11.6h1.8M12.8 11.6h1.8"/>',
contract:'<path d="M6.2 3h7.6l4 4v14H6.2z"/><path d="M13.8 3v4h4"/><path d="M9 16.8c1.8-2.2 3 1.2 5-1"/>',
tag:'<path d="M3.6 11.6 11.2 4h7v7l-7.6 7.6a2 2 0 0 1-2.8 0L3.6 14.4a2 2 0 0 1 0-2.8z"/><circle cx="15" cy="8" r="1.3"/>',
headset:'<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><path d="M4 14h2.6v5.2H5.4A1.4 1.4 0 0 1 4 17.8z"/><path d="M20 14h-2.6v5.2h1.2A1.4 1.4 0 0 0 20 17.8z"/>',
server:'<rect x="3.4" y="4" width="17.2" height="6.4" rx="1.8"/><rect x="3.4" y="13.6" width="17.2" height="6.4" rx="1.8"/><path d="M7 7.2h.01M7 16.8h.01M10.4 7.2h4M10.4 16.8h4"/>',
dbase:'<ellipse cx="12" cy="6" rx="7.6" ry="2.8"/><path d="M4.4 6v12c0 1.5 3.4 2.8 7.6 2.8s7.6-1.3 7.6-2.8V6"/><path d="M4.4 12c0 1.5 3.4 2.8 7.6 2.8s7.6-1.3 7.6-2.8"/>',
net:'<rect x="9" y="3" width="6" height="5" rx="1.4"/><rect x="2.4" y="16" width="6" height="5" rx="1.4"/><rect x="15.6" y="16" width="6" height="5" rx="1.4"/><path d="M12 8v4M5.4 16v-2.4h13.2V16"/>',
layers:'<path d="M12 3 21 7.6 12 12.2 3 7.6z"/><path d="m3 12.2 9 4.6 9-4.6M3 16.6l9 4.6 9-4.6"/>',
shield:'<path d="M12 3.2 20 6v6.2c0 4.4-3.3 7.3-8 8.6-4.7-1.3-8-4.2-8-8.6V6z"/><path d="m8.8 12 2.2 2.2 4.2-4.4"/>',
lock:'<rect x="4.4" y="10" width="15.2" height="10.4" rx="2.2"/><path d="M8.2 10V7.4a3.8 3.8 0 0 1 7.6 0V10"/><path d="M12 14v2.6"/>',
migrate:'<rect x="2.6" y="4.4" width="7.2" height="15.2" rx="1.8"/><rect x="14.2" y="4.4" width="7.2" height="15.2" rx="1.8"/><path d="M10.4 12h3.2M12 10.2 13.8 12 12 13.8"/>',
people:'<circle cx="9" cy="8" r="3.2"/><path d="M2.8 20c0-3.4 2.8-5.2 6.2-5.2S15.2 16.6 15.2 20"/><path d="M16.2 5.4a3.2 3.2 0 0 1 0 5.6M17.4 14.9c2.2.5 3.8 2.2 3.8 5.1"/>',
coins:'<ellipse cx="9" cy="6.6" rx="6.2" ry="2.6"/><path d="M2.8 6.6v4.2c0 1.4 2.8 2.6 6.2 2.6s6.2-1.2 6.2-2.6V6.6"/><ellipse cx="15" cy="17.4" rx="6.2" ry="2.6"/><path d="M8.8 17.4v-2.1M21.2 17.4v-4.2"/>',
inbox:'<path d="M3.2 12.8 6 4.6h12l2.8 8.2v5.4a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8z"/><path d="M3.2 12.8h4.4l1.3 2.4h6.2l1.3-2.4h4.4"/>',
mobile:'<rect x="6.6" y="2.6" width="10.8" height="18.8" rx="2.4"/><path d="M10.4 5.4h3.2"/><path d="M12 18.2h.01"/>',
ship:'<rect x="3" y="4.8" width="18" height="14.4" rx="2.2"/><path d="M3 9.4h18"/><circle cx="8.2" cy="14.2" r="2.2"/><path d="M13 13h5M13 16.2h3.2"/>'
};

const UI = {
  home: "<path d=\"M3.5 11 12 4l8.5 7\"/><path d=\"M5.5 9.5V20h13V9.5\"/>",
  scale: "<path d=\"M12 4v16M5 20h14M6 8h12\"/><path d=\"M6 8l-3 6a3 3 0 0 0 6 0zM18 8l-3 6a3 3 0 0 0 6 0z\"/>",
  report: "<path d=\"M6.2 3h7.6l4 4v14H6.2z\"/><path d=\"M13.8 3v4h4M9 17v-3M12 17v-5M15 17v-2\"/>",
  curve: "<path d=\"M3 20h18\"/><path d=\"M4 18c5 0 5-12 16-13\"/>",
  users: "<circle cx=\"9\" cy=\"8\" r=\"3.2\"/><path d=\"M2.8 20c0-3.4 2.8-5.2 6.2-5.2S15.2 16.6 15.2 20\"/><path d=\"M16.2 5.4a3.2 3.2 0 0 1 0 5.6M17.4 14.9c2.2.5 3.8 2.2 3.8 5.1\"/>",
  logs: "<path d=\"M8 6h12M8 12h12M8 18h12\"/><path d=\"M4 6h.01M4 12h.01M4 18h.01\"/>",
  settings: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z\"/>",
  search: "<circle cx=\"11\" cy=\"11\" r=\"6.5\"/><path d=\"m20 20-4.2-4.2\"/>",
  logout: "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9\"/>",
  user: "<circle cx=\"12\" cy=\"8\" r=\"3.4\"/><path d=\"M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5\"/>",
  globe: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z\"/>",
  chevron: "<path d=\"m9 6 6 6-6 6\"/>",
  // the start-pointing chevron and the double chevrons (pager); like "chevron" they point to the LTR
  // direction — add className="flip" to mirror them in Arabic, or pick the opposite icon by direction
  chevron_back: "<path d=\"m15 6-6 6 6 6\"/>",
  chevrons: "<path d=\"m6 6 6 6-6 6M12 6l6 6-6 6\"/>",
  chevrons_back: "<path d=\"m18 6-6 6 6 6M12 6l-6 6 6 6\"/>",
  plus: "<path d=\"M12 5v14M5 12h14\"/>",
  download: "<path d=\"M12 4v11M7.5 10.5 12 15l4.5-4.5M4 20h16\"/>",
  sheet: "<rect x=\"4\" y=\"3.5\" width=\"16\" height=\"17\" rx=\"2\"/><path d=\"M4 9h16M4 14.5h16M10 9v11.5\"/>",
  upload: "<path d=\"M12 15V4M7.5 8.5 12 4l4.5 4.5M4 20h16\"/>",
  check: "<path d=\"m5 12.5 4.5 4.5L19 7.5\"/>",
  x: "<path d=\"M6 6l12 12M18 6 6 18\"/>",
  trash: "<path d=\"M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6\"/>",
  restore: "<path d=\"M4.5 12a7.5 7.5 0 1 0 2.2-5.3\"/><path d=\"M4.5 4v4h4\"/>",
  menu: "<path d=\"M4 7h16M4 12h16M4 17h16\"/>",
  pulse: "<path d=\"M3 12h4l3-7 4 14 3-7h4\"/>",
  alert: "<path d=\"M12 4 2.8 19.5h18.4z\"/><path d=\"M12 10v4.5M12 17h.01\"/>",
  info: "<circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 11v5.5M12 7.8h.01\"/>",
  flag: "<path d=\"M5 21V4\"/><path d=\"M5 4h12l-2.5 4.5L17 13H5\"/>",
  note: "<path d=\"M5 4h14v11l-5 5H5z\"/><path d=\"M14 20v-5h5M8.5 9h7M8.5 12.5h4\"/>",
  edit: "<path d=\"M4.5 19.5h4l10.2-10.2a2.1 2.1 0 0 0-3-3L5.5 16.5z\"/><path d=\"m14.2 7.8 3 3M13 19.5h6.5\"/>",
  filter: "<path d=\"M4 5h16l-6 7.5V19l-4 1.5v-8z\"/>",
  // ERP module wheel (dashboard): standard modules that have no department of their own
  factory: "<path d=\"M3 20.5V10l5 3V10l5 3V10l5 3V4h3v16.5z\"/><path d=\"M3 20.5h18M7 17h2M11.5 17h2M16 17h2\"/>",
  planning: "<rect x=\"3.4\" y=\"4.6\" width=\"17.2\" height=\"15.8\" rx=\"2.2\"/><path d=\"M3.4 9.2h17.2M7 12.8h6M9.5 16.4h7.5\"/>",
  chart: "<path d=\"M4 20h16\"/><rect x=\"5.5\" y=\"12\" width=\"3\" height=\"6\" rx=\".8\"/><rect x=\"10.5\" y=\"8\" width=\"3\" height=\"10\" rx=\".8\"/><rect x=\"15.5\" y=\"4.5\" width=\"3\" height=\"13.5\" rx=\".8\"/>",
  crm: "<circle cx=\"12\" cy=\"8\" r=\"3\"/><path d=\"M6.5 19.5c0-3.1 2.5-5 5.5-5s5.5 1.9 5.5 5\"/><circle cx=\"5\" cy=\"10\" r=\"2\"/><circle cx=\"19\" cy=\"10\" r=\"2\"/><path d=\"M2 17c.2-1.6 1.3-2.7 3-2.9M22 17c-.2-1.6-1.3-2.7-3-2.9\"/>",
  // item types (1.8.0): a cog for a function, a document with a chart for a report
  item_function: "<circle cx=\"12\" cy=\"12\" r=\"2.8\"/><circle cx=\"12\" cy=\"12\" r=\"6.3\"/><path d=\"M12 2.8v2.9M12 18.3v2.9M2.8 12h2.9M18.3 12h2.9M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2\"/>",
  item_report: "<path d=\"M6 2.8h8l4 4v14.4H6z\"/><path d=\"M14 2.8v4h4\"/><path d=\"M9 18v-3.2M12 18v-6M15 18v-4.4\"/>",
  // notifications (1.9.0)
  bell: "<path d=\"M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4z\"/><path d=\"M10 20.5a2.2 2.2 0 0 0 4 0\"/>",
  megaphone: "<path d=\"M3.5 10v4a1 1 0 0 0 1 1H7l7 4.5v-15L7 9H4.5a1 1 0 0 0-1 1z\"/><path d=\"M17.5 9a4 4 0 0 1 0 6M7.5 15.2l1.2 4.6h2.6l-1-4\"/>",
  // moving an item to another application (1.10.0): two opposite arrows
  move: "<path d=\"M4 8h12.5M13 4.5 16.5 8 13 11.5\"/><path d=\"M20 16H7.5M11 12.5 7.5 16l3.5 3.5\"/>",
};

// Every icon by name (shared with the mobile app: mobile/src/components/Icon.tsx).
export const ICON_PATHS = { ...APP, ...UI };
