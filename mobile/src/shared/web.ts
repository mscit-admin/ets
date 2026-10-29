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
import * as items from '@web/lib/itemRules.js';
import * as approvals from '@web/lib/approvalRules.js';
import * as live from '@web/lib/liveRules.js';

export type Lang = 'ar' | 'en';
export type Dict = Record<string, string>;
export const messages = MESSAGES as unknown as Record<Lang, Dict>;

// ---- numbers and colours (frontend/src/lib/format.js)
export type Tone = { stroke: string; text: string; bg: string };
export type PillColor = 'green' | 'blue' | 'orange' | 'red' | 'purple' | 'cyan' | 'gray' | 'amber';
export const pc: (v: unknown) => string = format.pc;
export const pctColor: (v: number) => PillColor = format.pctColor as (v: number) => PillColor;
export const pctHue: (v: unknown) => number = format.pctHue;
export const pctTone: (v: unknown) => Tone = format.pctTone as (v: unknown) => Tone;
export const TEST_COLORS = format.TEST_COLORS as PillColor[];
export const NOTIF_COLORS = format.NOTIF_COLORS as PillColor[];
export const REVIEW_COLORS = format.REVIEW_COLORS as PillColor[];
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
export const EXTRA_MODULES = erp.EXTRA_MODULES as ModuleDef[];
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

// ---- notification preferences (frontend/src/lib/notifyTabs.js)
export type PrefType = {
  type: string; code: string; category: string; kind: string; digest: boolean; mandatory: boolean; blocked: boolean;
  mobile_blocked: boolean; push_allowed: boolean; muted: boolean; mobile_muted: boolean;
};
export type Prefs = { types: PrefType[]; digest: boolean };
export type PrefKey = 'muted' | 'mobile_muted';
export const PREF_CATS = notify.PREF_CATS as string[];
export const prefLockKey = notify.prefLockKey as (x: PrefType) => string | null;
export const prefPhoneShown = notify.prefPhoneShown as (x: PrefType) => boolean;
export const prefOn = notify.prefOn as (x: PrefType, k: PrefKey) => boolean;
export const prefLocked = notify.prefLocked as (x: PrefType, k: PrefKey) => boolean;
export const prefFlip = notify.prefFlip as (types: PrefType[], k: PrefKey, type: string, on: boolean) => Partial<Record<PrefKey, string[]>>;

// ---- editing items (frontend/src/lib/itemRules.js)
type ItemLike = { id?: number; item_type?: string | null; test_status?: number; progress?: number | string; notif_status?: number;
  review_status?: number; name_ar?: string; name_en?: string | null; removed_at?: string | null; note?: string | null };
export type Msg = { key: string; vars: Record<string, unknown> };
export type Status = 'test_status' | 'notif_status' | 'review_status';
export type ReasonValue<D = { id: number; app_id?: string; code: string }> = { reason: string; note: string; duplicates: D[] };
export type MoveValue = { dept: string; app: string; reason: string; touched: boolean };
export type Delta = { text: string; tone: 'muted' | 'green' | 'red' | 'plain' };
export type PendingHelp = { t: T; nm: (o: Record<string, unknown> | null | undefined, f?: string) => string; lang: Lang; pc: (v: unknown) => string; appId: string };
export type PendingValue = { kind?: string; function_id?: number | null; field: string; new_value: unknown; meta?: Record<string, unknown> | null;
  request_id?: number; requested_at?: string; requested_by_name?: string | null };
export type RenameCheck = { newAr: string; newEn: string; arChanged: boolean; enChanged: boolean; arProblem: string | null;
  enProblem: string | null; rProblem: string | null; unchanged: boolean; dup: boolean; ok: boolean };

export const ITEM_TYPES = items.ITEM_TYPES as ('function' | 'report')[];
export const typeOf = items.typeOf as (f: ItemLike) => 'function' | 'report';
export const SRC_COLOR = items.SRC_COLOR as Record<string, PillColor>;
export const NOTE_REQUIRED = items.NOTE_REQUIRED as Record<Status, number[]>;
export const STATUS_PREFIX = items.STATUS_PREFIX as Record<Status, string>;
export const STATUS_VALUES = items.STATUS_VALUES as (0 | 1 | 2 | 3)[];
export const NOTE_FIELD_MAX = items.NOTE_FIELD_MAX as number;
export const needsNote = items.needsNote as (f: ItemLike) => boolean;
export const noteReasons = items.noteReasons as (t: T, after: ItemLike) => string[];
export const PASS = items.PASS as number;
export const passConflict = items.passConflict as (f: ItemLike) => boolean;
export const pctText = items.pctText as (v: unknown) => string;
export const statusPassProblem = items.statusPassProblem as (f: ItemLike, field: string, v: number) => Msg | null;
export const progressPassProblem = items.progressPassProblem as (f: ItemLike, v: number) => Msg | null;
export const blockedItems = items.blockedItems as (e: unknown) => { function_id: number; code: string; name_ar: string; error: string; current_progress: number }[];
export const blockedItemKey = items.blockedItemKey as (x: { error: string }) => string;
export const clampNum = items.clampNum as (v: unknown, min: number, max: number) => number | null;
export const REASON_MIN = items.REASON_MIN as number;
export const REASON_MAX = items.REASON_MAX as number;
export const reasonLength = items.reasonLength as (v: unknown, min?: number, max?: number) => 'too_long' | 'required' | null;
export const DISABLE_REASONS = items.DISABLE_REASONS as string[];
export const NOTE_MIN = items.NOTE_MIN as number;
export const NOTE_MAX = items.NOTE_MAX as number;
export const emptyReason = items.emptyReason as <D>() => ReasonValue<D>;
export const noteProblem = items.noteProblem as (v: { note: string }) => string | null;
export const reasonProblem = items.reasonProblem as (v: ReasonValue<unknown>) => string | null;
export const reasonBody = items.reasonBody as (v: ReasonValue<{ id: number }>) => Record<string, unknown>;
export const dupCode = items.dupCode as (d: { app_id?: string; code: string }, appId: string) => string;
export const reasonText = items.reasonText as (t: T, lang: Lang, m: Record<string, unknown> | null | undefined, appId: string) => string;
export const NAME_MAX = items.NAME_MAX as number;
export const renameReasonProblem = items.renameReasonProblem as (v: string) => string | null;
export const renameCheck = items.renameCheck as (f: ItemLike, v: { ar: string; en: string; reason: string }, others?: ItemLike[]) => RenameCheck;
export const renameBody = items.renameBody as (c: RenameCheck, reason: string) => Record<string, unknown>;
export const MOVE_MAX = items.MOVE_MAX as number;
export const moveReasonProblem = items.moveReasonProblem as (v: string) => string | null;
export const emptyMove = items.emptyMove as MoveValue;
export const moveReady = items.moveReady as (v: MoveValue, pv: { data: { weight: { overflow?: boolean } } | null; error: unknown; loading: boolean } | null) => boolean;
export const moveAppAfterDept = items.moveAppAfterDept as (d: { applications?: { id: string }[] } | null | undefined) => string;
export const num2 = items.num2 as (v: unknown) => string;
export const pctDelta = items.pctDelta as (before: number, after: number, pc: (v: unknown) => string) => Delta;
export const weightDelta = items.weightDelta as (before: number, after: number) => Delta;
export const countDelta = items.countDelta as (d: number) => string | number;
export const FIELD_LABEL = items.FIELD_LABEL as Record<string, string>;
export const pendingByFunction = items.pendingByFunction as (p: PendingValue[] | undefined) => Record<number, PendingValue[]>;
export const pendingLifecycle = items.pendingLifecycle as (p: PendingValue[] | undefined) => PendingValue[];
export const fmtPending = items.fmtPending as (h: PendingHelp, field: string, v: unknown, meta?: unknown) => string;
export const pendingSummary = items.pendingSummary as (h: PendingHelp, list: PendingValue[]) => string;
export const pendingDetails = items.pendingDetails as (h: PendingHelp, list: PendingValue[]) => string[];

// ---- approvals (frontend/src/lib/approvalRules.js)
export type RqStatus = 'pending' | 'applied' | 'rejected' | 'superseded' | 'withdrawn';
export type Toast = { key: string; vars: Record<string, unknown>; kind: 'green' | 'red' | 'blue' };
export type MoveStage = { sourceDone: { name: string; at: string } | null; targetDone: { name: string; at: string } | null;
  waiting: 'source' | 'target' | null; waitKey: string | null };
export const RQ_STATUSES = approvals.RQ_STATUSES as RqStatus[];
export const RQ_STATUS_COLOR = approvals.RQ_STATUS_COLOR as Record<RqStatus, PillColor>;
export const RQ_FIELD_LABEL = approvals.RQ_FIELD_LABEL as Record<string, string>;
export const fmtChange = approvals.fmtChange as (h: { t: T; nm: PendingHelp['nm']; pc: (v: unknown) => string }, kind: string, field: string, v: unknown) => string;
export const showRenameReason = approvals.showRenameReason as (i: { field: string; function_id?: number | null; meta?: Record<string, unknown> | null },
  items: { field: string; function_id?: number | null }[]) => boolean;
export const moveStage = approvals.moveStage as (rq: Record<string, unknown>) => MoveStage;
export const isMoveRequest = approvals.isMoveRequest as (rq: { kind: string }) => boolean;
export const approveLabelKey = approvals.approveLabelKey as (can: { approve_as?: string | null } | undefined) => string;
export const canApproveAny = approvals.canApproveAny as (rqs: { can?: { approve?: boolean } }[] | undefined) => boolean;
export const decisionToast = approvals.decisionToast as (r: Record<string, unknown> | null | undefined) => Toast;
export const approveAllToasts = approvals.approveAllToasts as (r: Record<string, unknown>) => Toast[];
export const REJECT_MAX = approvals.REJECT_MAX as number;
export const rejectProblem = approvals.rejectProblem as (v: string) => string | null;
export const showsApprovals = approvals.showsApprovals as (perms: string[] | undefined, counts: { mine?: number; awaiting_me?: number } | null | undefined) => boolean;

// ---- live updates (frontend/src/lib/liveRules.js)
export type LiveMsg = { reason: 'change' | 'reconnect' | 'visible' | 'poll'; dept_id?: string; app_id?: string };
export const LIVE = {
  DEBOUNCE_MS: live.DEBOUNCE_MS as number, POLL_MS: live.POLL_MS as number, FALLBACK_AFTER: live.FALLBACK_AFTER as number,
  MAX_BACKOFF_MS: live.MAX_BACKOFF_MS as number, IDLE_CLOSE_MS: live.IDLE_CLOSE_MS as number,
};
export const backoffMs = live.backoffMs as (failures: number) => number;
export const eventData = live.eventData as (raw: unknown) => Record<string, unknown> | null;
export const passesFilter = live.passesFilter as (msg: LiveMsg, filter?: ((m: LiveMsg) => boolean) | null) => boolean;
