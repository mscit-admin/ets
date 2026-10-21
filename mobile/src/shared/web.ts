// The modules shared with the web frontend, imported straight from ../frontend/src (Metro watch folder, alias @web/*).
// Those files are plain JavaScript without imports; this file gives them TypeScript types, so the rest of the app
// imports from here and never from @web directly. Changing one of them changes the web UI too: run the web build
// (`npm run build` in frontend) and these tests (`npm test` here).
import * as format from '@web/lib/format.js';
import * as erp from '@web/lib/erpModules.js';
import * as wheel from '@web/lib/wheelGeometry.js';
import * as eq from '@web/lib/equation.js';
import * as notify from '@web/lib/notifyTabs.js';
import { ICON_PATHS as ICONS } from '@web/lib/iconPaths.js';
import { messages as MESSAGES } from '@web/i18n/messages.js';

export type Lang = 'ar' | 'en';
export type Dict = Record<string, string>;
export const messages = MESSAGES as unknown as Record<Lang, Dict>;

// ---- numbers and colours (frontend/src/lib/format.js)
export type Tone = { stroke: string; text: string; bg: string };
export type PillColor = 'green' | 'blue' | 'orange' | 'red' | 'purple' | 'cyan' | 'gray';
export const pc: (v: unknown) => string = format.pc;
export const pctColor: (v: number) => PillColor = format.pctColor as (v: number) => PillColor;
export const pctHue: (v: unknown) => number = format.pctHue;
export const pctTone: (v: unknown) => Tone = format.pctTone as (v: unknown) => Tone;
export const TEST_COLORS = format.TEST_COLORS as PillColor[];
export const VENDOR_COLORS = format.VENDOR_COLORS as PillColor[];

// ---- ERP module wheel (frontend/src/lib/erpModules.js, frontend/src/lib/wheelGeometry.js)
export type Department = {
  id: string; name_ar: string; name_en: string; short_ar?: string | null; short_en?: string | null; color: string; emblem: string;
  is_base?: boolean; weight: number; pct: number; fnPct?: number; apps: number;
};
export type ModuleDef = {
  key: string; icon: string; name_ar: string; name_en: string; lines_ar?: string[]; lines_en?: string[]; depts: string[];
};
export type Segment = ModuleDef & {
  state: 'active' | 'inactive' | 'out_of_scope'; pct?: number; dept?: Department; departments?: Department[];
};
export const STANDARD_MODULES = erp.STANDARD_MODULES as ModuleDef[];
export const wheelSegments = erp.wheelSegments as (departments: Department[], opts: { fullScope: boolean }) => Segment[];

export type WheelGeo = {
  pt: (r: number, a: number) => [number, number];
  arc: (r: number, a0: number, a1: number) => string;
  wedge: (a0: number, a1: number) => string;
};
export const W = {
  SIZE: wheel.SIZE as number, C: wheel.C as number, R_HUB: wheel.R_HUB as number, R_HUB_RING: wheel.R_HUB_RING as number,
  R_IN: wheel.R_IN as number, R_OUT: wheel.R_OUT as number, R_RIM: wheel.R_RIM as number, R_TEXT: wheel.R_TEXT as number,
  GAP: wheel.GAP as number, FILLS: wheel.FILLS as string[],
};
export const geo = wheel.geo as (mirror: boolean) => WheelGeo;
export const segmentAngles = wheel.segmentAngles as (i: number, n: number) => [number, number];
export const rimAngles = wheel.rimAngles as (a0: number, a1: number, pct: number) => { rimStart: number; rimEnd: number; rimTo: number };
export const linesOf = wheel.linesOf as (m: ModuleDef, lang: Lang) => string[];

// ---- application equation (frontend/src/lib/equation.js)
export type Calc = {
  id: string; weight: number; pct: number; fnPct: number; reportPct?: number | null; fnShare?: number; reportShare?: number;
  count: number; tests: [number, number, number, number]; items?: { function: number; report: number };
  typeWeight?: { function: number; report: number }; reportItems?: number; reportTrack?: boolean; reportWeight?: number;
};
export type Equation = {
  withReports: boolean; withFunctions: boolean; both: boolean; fw: number; rw: number;
  fn: number; fnPart: number; rep: number | null; repPart: number; result: number;
};
type T = (key: string, vars?: Record<string, unknown>) => string;
export const equation = eq.equation as (calc: Calc, settings?: { reports_share?: number }) => Equation;
export const share = eq.share as (w: number) => string;
export const repParts = eq.repParts as (t: T, calc: Calc) => string | null;

// ---- alerts (frontend/src/lib/notifyTabs.js)
export type Severity = 'critical' | 'warning' | 'info';
export type NotifTab = 'all' | 'approvals' | 'tracking' | 'plan' | 'security';
export const SEV_COLOR = notify.SEV_COLOR as Record<Severity, PillColor>;
export const SEV_ICON = notify.SEV_ICON as Record<Severity, string>;
export const TABS = notify.TABS as NotifTab[];
export const inTab = notify.inTab as (tab: NotifTab, n: { category: string }) => boolean;

// ---- icons (frontend/src/lib/iconPaths.js): inner SVG markup of 24 × 24 line icons
export const ICON_PATHS = ICONS as Record<string, string>;
