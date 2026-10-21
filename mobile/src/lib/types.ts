// Shapes of the API answers the app reads (backend/src/routes/*.js, docs/handover/11-API-Reference.md).
import type { Calc, Department, Severity } from '@/shared/web';

export type User = {
  id: number; username: string; full_name: string; email?: string | null; role: string;
  role_name_ar: string; role_name_en: string; language: 'ar' | 'en'; must_change_password: boolean;
  totp_enabled: boolean; totp_exempt?: boolean; permissions: string[]; fullScope: boolean;
  scope: { departments: string[]; applications: string[] };
};
export type PublicInfo = {
  org_name_ar?: string; org_name_en?: string; default_language?: string;
  branding?: { logo: number | null; favicon: number | null; login_bg: number | null };
  logo_height?: number; login_logo_height?: number;
};
export type Me =
  | { authenticated: false }
  | ({ authenticated: true; stage: 'verify' | 'enroll' | 'done'; user: User; mfa_mode?: string } & PublicInfo);

export type Application = {
  id: string; department_id: string; name_ar: string; name_en: string; sub_ar?: string | null; icon: string;
  note_ar?: string | null; addendum?: string | null; scope_cut?: boolean; extra_module?: boolean; calc: Calc;
};
export type Summary = {
  total: { weight: number; pct: number; fnPct: number; tests: [number, number, number, number] };
  departments: Department[];
  applications: Application[];
  counts: { functions: number; done: number; report_items: number; notes: number };
  settings: { weight_mode: string; reports_share?: number };
};
export type DepartmentData = { department: Department; applications: Application[] };

export type Duplicate = { id: number; app_id: string; code: string; name_ar?: string; removed?: boolean };
export type MovedFrom = {
  from_app_id: string; from_code: string; from_app_name_ar?: string; from_app_name_en?: string;
  moved_at: string; moved_by_name?: string | null; reason?: string;
};
export type Item = {
  id: number; app_id: string; code: string; source: string; name_ar: string; name_en?: string | null; reference?: string | null;
  vendor_status: number; weight: number; progress: number; enabled: boolean; test_status: 0 | 1 | 2 | 3;
  notif_status: number; review_status: number; note: string; item_type?: 'function' | 'report';
  removed_at?: string | null; removed_reason?: string | null; removed_by_name?: string | null;
  disabled_reason?: string | null; disabled_note?: string | null; disabled_by_name?: string | null; disabled_at?: string | null;
  duplicate_of?: Duplicate[]; moved_from?: MovedFrom | null; updated_by_name?: string | null; updated_at?: string;
};
export type ApplicationData = {
  application: Application; department: Department; functions: Item[];
  settings: { reports_share?: number; weight_mode?: string };
  pending?: { function_id?: number; field: string }[];
};

export type Notif = {
  id: number; type: string; category: string; severity: Severity; title: string; body?: string | null;
  link?: string | null; count: number; read: boolean; created_at: string; updated_at?: string;
};
export type NotifList = { items: Notif[]; next_before: number | null };
export type NotifCount = { unread: number; critical: number; top_severity: Severity | null };
