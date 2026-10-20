// Idempotent seeding: roles, default settings, the tracker catalog, report rows
// and the schedule row. Existing progress data is never overwritten — catalog
// rows are inserted only when missing and descriptive fields are refreshed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, tx } from './pool.js';
import { NOTIFY_DEFAULTS } from '../services/notify-catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const ROLES = [
  { id: 'admin', name_ar: 'مسؤول النظام', name_en: 'System Administrator', full_scope: true,
    description_ar: 'كل الشاشات والصلاحيات، وإدارة المستخدمين والسجلات',
    description_en: 'All screens and permissions, user and log administration',
    permissions: ['pct', 'wgt', 'tst', 'tog', 'ren', 'sch', 'rep', 'exp', 'imp', 'usr', 'log', 'cfg'] },
  { id: 'mgr', name_ar: 'مسؤول إدارة', name_en: 'Department Manager', full_scope: false,
    description_ar: 'كل تطبيقات إدارته: النسب والأوزان والاختبار والسجل',
    description_en: 'All applications of the department: progress, weights, testing, logs',
    permissions: ['pct', 'wgt', 'tst', 'tog', 'ren', 'sch', 'rep', 'exp', 'log'] },
  { id: 'ed', name_ar: 'محرّر تطبيق', name_en: 'Application Editor', full_scope: false,
    description_ar: 'نسب الإنجاز وحالة الاختبار داخل تطبيقاته، دون الأوزان',
    description_en: 'Progress and test status inside assigned applications, no weights',
    permissions: ['pct', 'tst', 'rep'] },
  { id: 'qa', name_ar: 'مختبِر', name_en: 'Tester', full_scope: false,
    description_ar: 'حالة الاختبار والملاحظات فقط — لا يغيّر نسبة ولا وزناً',
    description_en: 'Test status and notes only — cannot change progress or weights',
    permissions: ['tst'] },
  { id: 'pm', name_ar: 'مدير المشروع', name_en: 'Project Manager', full_scope: true,
    description_ar: 'كل الإدارات: متابعة وتعديل واستيراد، والاعتماد النهائي لنتائج الإدارات',
    description_en: 'All departments: tracking, editing, imports, and final approval of department results',
    permissions: ['pct', 'wgt', 'tst', 'tog', 'ren', 'sch', 'rep', 'exp', 'imp', 'log', 'apv_final'] },
  { id: 'tm', name_ar: 'المدير الفني للمشروع', name_en: 'Technical Project Manager', full_scope: true,
    description_ar: 'كل الإدارات: متابعة وتعديل واستيراد، والاعتماد النهائي لنتائج الإدارات',
    description_en: 'All departments: tracking, editing, imports, and final approval of department results',
    permissions: ['pct', 'wgt', 'tst', 'tog', 'ren', 'sch', 'rep', 'exp', 'imp', 'log', 'apv_final'] },
  { id: 'lead', name_ar: 'رئيس فريق إدارة', name_en: 'Department Team Lead', full_scope: false,
    description_ar: 'إدارته فقط: التعديل والاستيراد واعتماد نتائج فريقه (الاعتماد الأول)',
    description_en: "Own department: editing, imports and first approval of the team's results",
    permissions: ['pct', 'tst', 'tog', 'ren', 'rep', 'exp', 'imp', 'log', 'apv_dept'] },
  { id: 'member', name_ar: 'عضو فريق', name_en: 'Team Member', full_scope: false,
    description_ar: 'إدارته فقط: تحديث الإنجاز والاختبار والتقارير، واقتراح إضافة/إزالة/تضمين الوظائف، ورفع ملفات النتائج — كلها باعتماد رئيس الفريق',
    description_en: 'Own department: progress, testing, reports, proposing to add / remove / include functions, and uploading result files — all approved by the team lead',
    permissions: ['pct', 'tst', 'tog', 'ren', 'rep', 'imp'] },
  { id: 'obs', name_ar: 'مطّلع', name_en: 'Observer', full_scope: false,
    description_ar: 'قراءة فقط داخل نطاقه', description_en: 'Read-only within scope',
    permissions: [] },
];

export const DEFAULT_SETTINGS = {
  'mfa.mode': 'optional',              // off | optional | required
  'mfa.issuer': 'ETS',
  'calc.weight_mode': 'fixed',         // fixed | auto
  'calc.notif_share': 0.10,            // share of notification status inside a function's %
  'calc.reports_share': 0.15,          // share of the reports track inside an application's %
  'security.password_min_length': 10,
  'logs.retention_days': 365,          // auth/error/system logs
  'logs.audit_retention_days': 365,    // change history (audit_log), at least 365
  'logs.access_retention_days': 90,    // HTTP access log
  'app.org_name_ar': 'مركز متابعة إنجاز ERP',
  'app.org_name_en': 'ERP Implementation Tracking Center',
  'app.default_language': 'ar',
  'approval.edits_need_lead': true,    // data-entry edits wait for the department team lead
  'app.logo_height': 28,               // logo height in the top bar (px)
  'app.login_logo_height': 64,         // logo height on the login screen (px)
  // notifications (1.9.0): thresholds, schedule, rate cap, retention, policy matrix — services/notify-catalog.js
  ...NOTIFY_DEFAULTS,
};

export async function seed({ log = console.log } = {}) {
  const cat = JSON.parse(fs.readFileSync(path.join(here, 'seed/catalog.json'), 'utf8'));
  await tx(async c => {
    for (const r of ROLES) {
      await c.query(`INSERT INTO roles(id,name_ar,name_en,description_ar,description_en,full_scope,permissions)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (id) DO UPDATE SET name_ar=EXCLUDED.name_ar, name_en=EXCLUDED.name_en,
          description_ar=EXCLUDED.description_ar, description_en=EXCLUDED.description_en,
          full_scope=EXCLUDED.full_scope, permissions=EXCLUDED.permissions`,
        [r.id, r.name_ar, r.name_en, r.description_ar, r.description_en, r.full_scope, r.permissions]);
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      await c.query('INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [k, JSON.stringify(v)]);
    }
    for (const d of cat.departments) {
      await c.query(`INSERT INTO departments(id,name_ar,name_en,short_ar,short_en,color,emblem,is_base,sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (id) DO UPDATE SET name_ar=EXCLUDED.name_ar, name_en=EXCLUDED.name_en,
          short_ar=EXCLUDED.short_ar, short_en=EXCLUDED.short_en, emblem=EXCLUDED.emblem,
          is_base=EXCLUDED.is_base, sort=EXCLUDED.sort`,
        [d.id, d.name_ar, d.name_en, d.short_ar, d.short_en, d.color, d.emblem, d.is_base, d.sort]);
    }
    for (const a of cat.applications) {
      await c.query(`INSERT INTO applications(id,department_id,name_ar,name_en,sub_ar,icon,default_weight,weight,
          note_ar,addendum,scope_cut,extra_module,sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET department_id=EXCLUDED.department_id, name_ar=EXCLUDED.name_ar,
          name_en=EXCLUDED.name_en, sub_ar=EXCLUDED.sub_ar, icon=EXCLUDED.icon,
          default_weight=EXCLUDED.default_weight, note_ar=EXCLUDED.note_ar, addendum=EXCLUDED.addendum,
          scope_cut=EXCLUDED.scope_cut, extra_module=EXCLUDED.extra_module, sort=EXCLUDED.sort`,
        [a.id, a.department_id, a.name_ar, a.name_en, a.sub_ar, a.icon, a.weight, a.note_ar,
          a.addendum, a.scope_cut, a.extra_module, a.sort]);
    }
    let added = 0;
    for (const f of cat.functions) {
      const r = await c.query(`INSERT INTO functions(app_id,code,source,name_ar,reference,vendor_status,enabled,sort)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (app_id,code) DO UPDATE SET name_ar=EXCLUDED.name_ar, reference=EXCLUDED.reference,
          vendor_status=EXCLUDED.vendor_status, source=EXCLUDED.source, sort=EXCLUDED.sort
        RETURNING (xmax = 0) AS inserted`,
        [f.app_id, f.code, f.source, f.name_ar, f.reference, f.vendor_status, f.enabled, f.sort]);
      if (r.rows[0].inserted) added++;
    }
    await c.query(`INSERT INTO app_reports(app_id)
      SELECT a.id FROM applications a JOIN departments d ON d.id=a.department_id
      WHERE NOT d.is_base ON CONFLICT DO NOTHING`);
    await c.query('INSERT INTO schedule(id) VALUES (1) ON CONFLICT DO NOTHING');
    await c.query(`INSERT INTO system_log(event,message,detail) VALUES ('seed','catalog seeded',$1)`,
      [JSON.stringify({ departments: cat.departments.length, applications: cat.applications.length,
        functions: cat.functions.length, newFunctions: added })]);
    log(`seeded: ${cat.departments.length} departments, ${cat.applications.length} applications, ` +
      `${cat.functions.length} functions (${added} new)`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seed().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}
