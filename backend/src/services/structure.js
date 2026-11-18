// Structure management (migration 037): create / edit / archive departments and applications from the UI.
//
// Design notes
//  · Nothing is ever hard-deleted. "Archive" sets archived_at (reversible via restore), mirroring functions.removed_at.
//    Archived rows keep every history reference (moves, imports, edit requests, audit) but are filtered OUT of every
//    calculation load and every picker (see the `archived_at IS NULL` filters in tracker-data/snapshots/legacy/…).
//  · A newly created department or application enters the weighted roll-up immediately, so the overall % reflects the
//    wider scope at once (retroactive) — no schedule/baseline change is involved.
//  · ids are text slugs (like the seeded 'hr', 'per'). Users rarely type Latin names, so we derive a slug from name_en
//    when it has Latin letters, else from a prefix, and guarantee uniqueness against ALL existing ids (archived too).
import { query } from '../db/pool.js';
import { str, bad } from '../utils/http.js';

const HEX = /^#[0-9a-fA-F]{6}$/;
const ICON = /^[a-z0-9_]{1,40}$/;                  // same style as an ERP/phase icon name (lib/iconPaths.js)
const ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;           // a catalog slug: starts alphanumeric, then a-z0-9_- (≤40)

const num = (v, lo, hi, d) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.min(hi, Math.max(lo, +v)) : d);

// A slug base from a free-text name: the Latin letters/digits of name_en lowercased, else the given fallback.
function slugBase(name, fallback) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return s || fallback;
}

// A unique slug for `table`, derived from base, checked against every existing id (archived included) in that table.
export async function genId(c, table, base) {
  const rel = table === 'departments' ? 'departments' : 'applications';
  const taken = new Set((await c.query(`SELECT id FROM ${rel}`)).rows.map(r => r.id));
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`.slice(0, 40);
  if (!ID.test(id)) throw bad('invalid_value');       // base was empty after sanitising and fallback (never expected)
  return id;
}

// ---- departments ----

// Validated department fields (create or edit). On create, name_ar is required.
export function departmentData(body = {}, { create } = {}) {
  const name_ar = str(body.name_ar, 200);
  if (create && !name_ar) throw bad('name_required');
  const name_en = str(body.name_en, 200);
  const color = str(body.color, 7) || '#2490ef';
  if (!HEX.test(color)) throw bad('invalid_value');
  const emblem = str(body.emblem, 40) || null;
  if (emblem && !ICON.test(emblem)) throw bad('invalid_value');
  const wheel_icon = str(body.wheel_icon, 40) || null;
  if (wheel_icon && !ICON.test(wheel_icon)) throw bad('invalid_value');
  const wheel_order = body.wheel_order === null || body.wheel_order === undefined || body.wheel_order === ''
    ? null : Math.trunc(num(body.wheel_order, 0, 100000, 0));
  return {
    name_ar, name_en: name_en || name_ar,
    short_ar: str(body.short_ar, 120) || name_ar,
    short_en: str(body.short_en, 120) || name_en || name_ar,
    color, emblem, is_base: body.is_base === true,
    // ERP wheel appearance (migration 038): all optional, with sensible fallbacks applied in the wheel itself
    wheel_show: body.wheel_show !== false,
    wheel_icon,
    wheel_label_ar: str(body.wheel_label_ar, 120) || null,
    wheel_label_en: str(body.wheel_label_en, 120) || null,
    wheel_order,
  };
}

export async function createDepartment(c, body, userId) {
  const d = departmentData(body, { create: true });
  const id = await genId(c, 'departments', slugBase(d.name_en, 'dept'));
  const sort = (await c.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM departments')).rows[0].s;
  // a new department defaults to the next wheel position when none is given, so it appears after the existing ones
  const wheelOrder = d.wheel_order ?? (await c.query('SELECT COALESCE(max(wheel_order), 0) + 1 AS s FROM departments')).rows[0].s;
  return (await c.query(`INSERT INTO departments(id, name_ar, name_en, short_ar, short_en, color, emblem, is_base, sort,
      wheel_show, wheel_icon, wheel_label_ar, wheel_label_en, wheel_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [id, d.name_ar, d.name_en, d.short_ar, d.short_en, d.color, d.emblem, d.is_base, sort,
    d.wheel_show, d.wheel_icon, d.wheel_label_ar, d.wheel_label_en, wheelOrder])).rows[0];
}

export async function updateDepartment(c, id, body) {
  const d = departmentData(body, { create: false });
  // name_ar is required when present; an edit that blanks it is rejected (keep the column NOT NULL meaningful)
  if (!d.name_ar) throw bad('name_required');
  return (await c.query(`UPDATE departments SET name_ar=$2, name_en=$3, short_ar=$4, short_en=$5, color=$6, emblem=$7, is_base=$8,
      wheel_show=$9, wheel_icon=$10, wheel_label_ar=$11, wheel_label_en=$12, wheel_order=COALESCE($13, wheel_order)
    WHERE id=$1 AND archived_at IS NULL RETURNING *`,
  [id, d.name_ar, d.name_en, d.short_ar, d.short_en, d.color, d.emblem, d.is_base,
    d.wheel_show, d.wheel_icon, d.wheel_label_ar, d.wheel_label_en, d.wheel_order])).rows[0];
}

export async function archiveDepartment(c, id, reason, userId) {
  // a department may be archived only when it has no live (non-archived) applications — archive or move those first
  const live = (await c.query('SELECT count(*)::int AS n FROM applications WHERE department_id=$1 AND archived_at IS NULL', [id])).rows[0].n;
  if (live > 0) throw bad('department_not_empty');
  return (await c.query(`UPDATE departments SET archived_at=now(), archived_by=$2, archive_reason=$3
    WHERE id=$1 AND archived_at IS NULL RETURNING *`, [id, userId, reason || null])).rows[0];
}

export async function restoreDepartment(c, id) {
  return (await c.query(`UPDATE departments SET archived_at=NULL, archived_by=NULL, archive_reason=NULL
    WHERE id=$1 AND archived_at IS NOT NULL RETURNING *`, [id])).rows[0];
}

// ---- applications ----

export function applicationFields(body = {}, { create } = {}) {
  const name_ar = str(body.name_ar, 300);
  if (create && !name_ar) throw bad('name_required');
  const name_en = str(body.name_en, 300);
  const icon = str(body.icon, 40) || null;
  if (icon && !ICON.test(icon)) throw bad('invalid_value');
  return {
    name_ar, name_en: name_en || name_ar,
    sub_ar: str(body.sub_ar, 300) || null,
    icon,
    note_ar: str(body.note_ar, 2000) || null,
    weight: num(body.weight, 0, 100000, 1),
  };
}

export async function createApplication(c, deptId, body, userId) {
  const a = applicationFields(body, { create: true });
  const id = await genId(c, 'applications', slugBase(a.name_en, 'app'));
  const sort = (await c.query('SELECT COALESCE(max(sort), 0) + 1 AS s FROM applications WHERE department_id=$1', [deptId])).rows[0].s;
  return (await c.query(`INSERT INTO applications(id, department_id, name_ar, name_en, sub_ar, icon, default_weight, weight, note_ar, sort, updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) RETURNING *`,
  [id, deptId, a.name_ar, a.name_en, a.sub_ar, a.icon, a.weight, a.note_ar, sort, userId])).rows[0];
}

// Edit the descriptive fields of an application (NOT its weight — that stays in the Weights screen, perm 'wgt').
export async function updateApplication(c, id, body, userId) {
  const a = applicationFields(body, { create: false });
  if (!a.name_ar) throw bad('name_required');
  return (await c.query(`UPDATE applications SET name_ar=$2, name_en=$3, sub_ar=$4, icon=$5, note_ar=$6,
      updated_at=now(), updated_by=$7
    WHERE id=$1 AND archived_at IS NULL RETURNING *`,
  [id, a.name_ar, a.name_en, a.sub_ar, a.icon, a.note_ar, userId])).rows[0];
}

export async function archiveApplication(c, id, reason, userId) {
  return (await c.query(`UPDATE applications SET archived_at=now(), archived_by=$2, archive_reason=$3,
      updated_at=now(), updated_by=$2
    WHERE id=$1 AND archived_at IS NULL RETURNING *`, [id, userId, reason || null])).rows[0];
}

export async function restoreApplication(c, id, userId) {
  return (await c.query(`UPDATE applications SET archived_at=NULL, archived_by=NULL, archive_reason=NULL,
      updated_at=now(), updated_by=$2
    WHERE id=$1 AND archived_at IS NOT NULL RETURNING *`, [id, userId])).rows[0];
}

// The whole catalog (archived rows included) for the structure screen, with child counts.
export async function structureData() {
  const [d, a] = await Promise.all([
    query(`SELECT dep.*, db.full_name AS archived_by_name,
        (SELECT count(*)::int FROM applications ap WHERE ap.department_id=dep.id) AS app_count,
        (SELECT count(*)::int FROM applications ap WHERE ap.department_id=dep.id AND ap.archived_at IS NULL) AS active_app_count
      FROM departments dep LEFT JOIN users db ON db.id=dep.archived_by ORDER BY dep.sort, dep.id`),
    query(`SELECT ap.*, ab.full_name AS archived_by_name,
        (SELECT count(*)::int FROM functions f WHERE f.app_id=ap.id AND f.removed_at IS NULL) AS function_count
      FROM applications ap LEFT JOIN users ab ON ab.id=ap.archived_by ORDER BY ap.sort, ap.id`),
  ]);
  return { departments: d.rows, applications: a.rows };
}
