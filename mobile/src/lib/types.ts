// Shapes of the API answers the app reads (backend/src/routes/*.js, docs/handover/11-API-Reference.md).
import type { Calc, Department, PendingValue, RqStatus, Severity } from '@/shared/web';

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
  duplicate_of?: Duplicate[]; moved_from?: MovedFrom | null; moves?: MoveRecord[]; updated_by_name?: string | null; updated_at?: string;
};
export type MoveRecord = MovedFrom & {
  id: number; to_app_id: string; to_code: string; from_app_name_ar?: string; to_app_name_ar?: string; to_app_name_en?: string;
  from_dept_name_ar?: string; from_dept_name_en?: string; to_dept_name_ar?: string; to_dept_name_en?: string;
  weight_mode?: string; weight_share?: number | string; request_id?: number | null;
};
/** what the reader may change on an application's items (GET /tracker/applications/:id → can) */
export type Can = { pct: boolean; wgt: boolean; tst: boolean; tog: boolean; ren: boolean; mov: boolean; rep: boolean };
export type ApplicationData = {
  application: Application; department: Department; functions: Item[];
  settings: { reports_share?: number; weight_mode?: string };
  pending?: PendingValue[];
  needs_approval?: boolean;
  can: Can;
};

/** an item offered by GET /tracker/function-options (duplicates, bulk choices) */
export type FnOption = { id: number; app_id: string; code: string; name_ar: string; name_en?: string | null; enabled?: boolean;
  app_name_ar?: string; app_name_en?: string };

/** before → after of an add / remove / restore / include / exclude (POST /tracker/applications/:id/impact) */
export type BeforeAfter = { before: number; after: number };
export type Impact = { app: BeforeAfter; dept: BeforeAfter; total: BeforeAfter; count: BeforeAfter; included: BeforeAfter };

/** GET /tracker/move-targets */
export type MoveTargets = { departments: { id: string; name_ar: string; name_en: string; short_ar?: string; short_en?: string;
  applications: { id: string; name_ar: string; name_en: string; icon?: string }[] }[] };
/** POST …/move/preview (also kept in a move request's meta.impact) */
export type MoveImpactData = {
  mode: 'auto' | 'fixed'; items: number; counted: number;
  weight: { share: number; moved_weight: number; src_items_weight: number; overflow: boolean; src: BeforeAfter; dst: BeforeAfter };
  apps: { id: string; role: string; department_id: string; name_ar: string; name_en: string; pct: BeforeAfter }[];
  departments: { id: string; name_ar: string; name_en: string; pct: BeforeAfter }[];
  total: BeforeAfter; needs_approval?: boolean;
};

/** GET /approvals → requests */
export type RequestItem = {
  id: number; request_id: number; kind: 'function' | 'report'; app_id: string; function_id: number | null; field: string;
  old_value: unknown; new_value: unknown; meta?: Record<string, unknown> | null; applied?: boolean | null; note?: string | null;
  code?: string | null; fn_name_ar?: string | null;
};
export type EditRequest = {
  id: number; kind: string; status: RqStatus; app_id: string; department_id: string; target_app_id?: string | null;
  app_name_ar: string; app_name_en: string; dept_name_ar: string; dept_name_en: string; icon?: string;
  target_app_name_ar?: string | null; target_app_name_en?: string | null; target_dept_name_ar?: string | null; target_dept_name_en?: string | null;
  requested_by: number; requested_by_name: string; requested_at: string; decided_by_name?: string | null; decided_at?: string | null;
  reason?: string | null; summary?: string | null; item_count: number; items: RequestItem[];
  source_approved_by?: number | null; source_approved_by_name?: string | null; source_approved_at?: string | null;
  target_approved_by_name?: string | null; target_approved_at?: string | null;
  meta?: { reason?: string; weight_share?: number; impact?: MoveImpactData } | null;
  move_now?: { share: number; still_in_source?: boolean } | null;
  apply_result?: { weight?: { share: number } } | null;
  can: { approve: boolean; reject: boolean; withdraw: boolean; stage?: string | null; approve_as?: string | null };
};

export type Notif = {
  id: number; type: string; category: string; severity: Severity; title: string; body?: string | null;
  link?: string | null; count: number; read: boolean; created_at: string; updated_at?: string;
};
export type NotifList = { items: Notif[]; next_before: number | null };
export type NotifCount = { unread: number; critical: number; top_severity: Severity | null };

// Messaging (1.12.26 web; mirrored on mobile 0.3.0). Shapes of /api/messages answers (backend/src/services/messages.js).
/** GET /messages/unread-count — the nav badge; `replies` is 0 unless the caller holds 'msg'. */
export type MsgUnread = { inbox: number; replies: number; total: number };
/** GET /messages/inbox → threads — a received conversation. */
export type InboxThread = {
  id: number; broadcast_id: number; subject: string | null; last_post_at: string; created_at: string;
  unread: boolean; from_name: string; from_username: string; preview: string; last_mine: boolean;
};
/** GET /messages/sent → broadcasts — a broadcast the caller authored. */
export type SentBroadcast = {
  id: number; subject: string | null; preview: string; audience: unknown; recipient_count: number;
  created_at: string; reply_count: number; unread_replies: number;
};
/** GET /messages/sent/:id — the per-recipient threads of one broadcast. */
export type BroadcastThreads = {
  broadcast: { id: number; subject: string | null; preview: string; created_at: string; recipient_count: number };
  threads: {
    id: number; recipient_id: number; recipient_name: string; recipient_username: string;
    last_post_at: string; created_at: string; unread: boolean; post_count: number; preview: string;
  }[];
};
export type MsgParty = { id: number; full_name: string; username: string };
export type MsgPost = { id: number; author_id: number; author_name: string; body: string; created_at: string; mine: boolean };
/** GET /messages/threads/:id — a thread the caller is a party to (also marks the caller's side read). */
export type ThreadData = {
  thread: {
    id: number; broadcast_id: number; subject: string | null; created_at: string; last_post_at: string;
    closed_at: string | null; side: 'author' | 'recipient'; author: MsgParty; recipient: MsgParty;
  };
  posts: MsgPost[];
};
/** A person the compose picker may message (GET /messages/recipients, POST /messages/resolve). */
export type Recipient = { id: number; full_name: string; username: string; role: string };
/** GET /messages/compose-meta — the departments and roles the sender may target. */
export type ComposeMeta = {
  departments: { id: string; name_ar: string; name_en: string; short_ar?: string; short_en?: string }[];
  roles: { id: string; name_ar: string; name_en: string }[];
  total_recipients: number;
};
export type ResolveResult = { count: number; recipients: Recipient[] };
export type SendResult = { broadcast_id: number; sent: number };
