// Turns an audit-log row into plain sentences for the Logs screen: what was changed, on which function /
// application, from which value to which value, and how it came in (direct edit, approved request, import).
// Rows written before migration 007 have no `context`; they still read well from old_value / new_value.

const STATUS_PREFIX = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_', status: 'rs_' };
const PCT_FIELDS = new Set(['progress']);
const BOOL_FIELDS = new Set(['is_active', 'totp_exempt', 'must_change_password', 'approval.edits_need_lead', 'notify.enabled']);
const SETTING_LABEL = {
  'mfa.mode': 'mfa_mode', 'mfa.issuer': 'mfa_issuer', 'approval.edits_need_lead': 'edits_need_lead',
  'app.org_name_ar': 'org_name_ar', 'app.org_name_en': 'org_name_en', 'app.default_language': 'default_language',
  'security.password_min_length': 'password_min_length', 'logs.retention_days': 'retention_days',
  'logs.access_retention_days': 'access_retention_days', 'calc.weight_mode': 'weight_mode',
  'calc.notif_share': 'notif_share', 'calc.reports_share': 'reports_share',
  // notifications (1.9.0): the thresholds use their Settings labels (ns_<name>)
  'notify.enabled': 'notify_enabled', 'notify.timezone': 'notify_timezone', 'notify.digest_hour': 'notify_digest_hour',
  'notify.work_days': 'notify_work_days', 'notify.policy': 'notify_policy',
};
// ns_<key without "notify."> for the thresholds of Settings → «الإشعارات»
const notifyLabel = k => (k.startsWith('notify.') ? 'ns_' + k.slice(7) : null);
// Reports that can be exported to Excel (backend routes/export.js); the audit entity of an export is the report key.
const EXPORT_REPORTS = new Set(['summary', 'project_status', 'department', 'functions', 'weights', 'reports', 'schedule', 'approvals',
  'imports', 'import_detail', 'users']);
const NAME_FIELDS = new Set(['name_ar', 'name_en']);      // a rename (1.9.1)
const MAX_INLINE = 3;      // change lines shown under the sentence in the list; the rest are in the details

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (s, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
const num = v => (Number.isFinite(+v) ? String(Math.round(+v * 100) / 100) : String(v));

export function makeAudit({ t, lang }) {
  const tx = (key, vars) => { const s = t(key, vars); return s === key ? null : s; };   // null when the key is missing
  const fieldLabel = f => tx('au_f_' + f) || tx(f) || f;
  const settingLabel = k => (SETTING_LABEL[k] && tx(SETTING_LABEL[k])) || (notifyLabel(k) && tx(notifyLabel(k))) || k;
  const person = u => (u ? u.full_name || u.username || '—' : '—');
  // the author of a row, with «(محذوف)» when that account was deleted since (logs.js: user_deleted)
  const actorName = r => (r.full_name || r.username || '—') + (r.user_deleted ? ' ' + t('deleted_marker') : '');
  const quote = s => (lang === 'ar' ? `«${s}»` : `“${s}”`);
  const listSep = lang === 'ar' ? '، ' : ', ';
  // codes of the functions a duplicate points at: "D3" in the same application, "att/D3" in another one
  const codes = (list, appId) => (Array.isArray(list) ? list : []).map(d => (d.app_id && appId && d.app_id !== appId ? `${d.app_id}/${d.code}` : d.code)).join(listSep);
  // why a function is excluded: «مكررة مع D3، D5», «خارج النطاق», … (migration 013)
  const reasonPhrase = (m, appId) => {
    const dup = codes(m?.duplicate_of, appId);
    if (m?.disabled_reason === 'duplicate' && dup) return t('dr_duplicate_of_list', { codes: dup });
    return m?.disabled_reason ? tx('dr_' + m.disabled_reason) || m.disabled_reason : t('dr_none');
  };

  // A value as a reader would say it, for the given field.
  function fmt(field, v) {
    if (v === null || v === undefined || v === '') return field === 'note' ? t('au_no_note') : t('au_empty');
    if (STATUS_PREFIX[field] !== undefined) return t(STATUS_PREFIX[field] + v);
    if (PCT_FIELDS.has(field)) return num(v) + '%';
    if (field === 'calc.notif_share' || field === 'calc.reports_share') return num(+v * 100) + '%';
    if (field === 'calc.weight_mode') return tx('weight_mode_' + v) || String(v);
    if (field === 'enabled') return v ? t('au_on') : t('au_off');
    if (field === 'disabled_reason') return tx('dr_' + v) || String(v);
    if (field === 'item_type') return tx('it_' + v) || String(v);
    if (field === 'duplicate_of') return codes(v) || t('au_empty');
    if (field === 'removed') return v ? t('au_removed') : t('au_present');
    if (field === 'language' || field === 'app.default_language') return tx('au_lang_' + v) || String(v);
    if (field === 'mfa.mode') return tx('mfa_' + v) || String(v);
    if (field === 'notify.work_days' && Array.isArray(v)) return v.map(d => tx('wd_' + d) || d).join(listSep);
    if (field === 'notify.digest_hour') return String(v).padStart(2, '0') + ':00';
    if (BOOL_FIELDS.has(field) || typeof v === 'boolean') return v ? t('yes') : t('no');
    if (field === 'role_id') return v;
    if (field === 'note' || typeof v === 'string') return quote(short(String(v)));
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) {
      if (field === 'scopes') return v.map(s => s.ref_id || s).join('، ') || t('au_empty');
      if (field === 'overrides') return v.map(o => `${tx('perm_' + o.permission) || o.permission} ${o.granted ? '+' : '−'}`).join(listSep) || t('au_empty');
      return t('au_values_n', { n: v.length });
    }
    return short(JSON.stringify(v));
  }

  // [{field, label, from, to}] for every value that actually changed.
  function diff(oldV, newV) {
    const o = oldV && typeof oldV === 'object' ? oldV : {};
    const n = newV && typeof newV === 'object' ? newV : {};
    return [...new Set([...Object.keys(o), ...Object.keys(n)])]
      .filter(k => !sameValue(o[k], n[k]))
      .map(k => ({ field: k, label: fieldLabel(k), from: fmt(k, o[k]), to: fmt(k, n[k]) }));
  }

  const fnName = x => {
    const name = (lang === 'en' && x.name_en) || x.name_ar || x.name_en || '';
    return quote([x.code, short(name, 80)].filter(Boolean).join(' '));
  };
  // context items → readable lines
  const itemLines = items => (items || []).map(i => {
    if (i.field === 'enabled' && i.new === false && i.meta) {
      return { item: i.kind === 'function' && (i.code || i.name_ar) ? fnName(i) : i.app_id || '', label: fieldLabel('enabled'), from: fmt('enabled', i.old),
        to: fmt('enabled', false) + ' — ' + reasonPhrase(i.meta, i.app_id) + (i.meta.disabled_note ? ': ' + quote(short(i.meta.disabled_note)) : ''), applied: i.applied };
    }
    const what = i.kind === 'function' && (i.code || i.name_ar) ? fnName(i) : i.app_id || '';
    if (i.field === 'create') return { item: fnName(i.new || {}), label: fieldLabel('create'), from: '', to: '', applied: i.applied };
    if (i.field === 'removed') {
      return { item: what, label: fieldLabel('removed'), from: fmt('removed', i.old?.removed), to: fmt('removed', i.new?.removed) + (i.new?.reason ? ' — ' + t('au_reason', { reason: i.new.reason }) : ''), applied: i.applied };
    }
    if (i.field === 'move') {          // a move (1.10.0): «app/D7» → «destination application»
      return { item: what, label: fieldLabel('move'), from: i.old ? `${i.old.app_id}/${i.old.code}` : '',
        to: ((lang === 'en' && i.new?.name_en) || i.new?.name_ar || i.new?.app_id || '') + (i.meta?.reason ? ' — ' + t('au_reason', { reason: quote(short(i.meta.reason)) }) : ''), applied: i.applied };
    }
    const f = i.kind === 'weight' ? 'weight' : i.field;
    // a rename carries its reason (1.9.1)
    const why = i.meta?.rename_reason ? ' — ' + t('au_reason', { reason: quote(short(i.meta.rename_reason)) }) : '';
    return { item: what, label: fieldLabel(f), from: fmt(f, i.old), to: fmt(f, i.new) + why, applied: i.applied };
  });

  // Main sentence of a change to one function / report, choosing a clearer wording for a single change.
  function changeSentence(r, ch, { one, many, vars }) {
    if (ch.length === 1) {
      const c = ch[0];
      if (r.entity === 'function' && c.field === 'note') {
        const o = r.old_value?.note, n = r.new_value?.note;
        if (!o && n) return t('au_note_added', { ...vars, to: c.to });
        if (o && !n) return t('au_note_removed', { ...vars, from: c.from });
      }
      return t(one, { ...vars, field: c.label, from: c.from, to: c.to });
    }
    return t(many, { ...vars, n: ch.length });
  }

  // A move (1.10.0): «"application" (department)» from the names stored in the row's context.
  const nmc = (ctx, k) => (lang === 'en' && ctx[k + '_name_en']) || ctx[k + '_name_ar'] || ctx[k + '_name_en'] || '';
  const place = (ctx, side) => t('au_move_place', { app: nmc(ctx, side + '_app') || ctx[side + '_app_id'] || '', dept: nmc(ctx, side + '_dept') || ctx[side + '_dept_id'] || '' });
  const share2 = v => (Number.isFinite(+v) ? (+v).toFixed(2) : String(v));

  // Filters an export was made with, as a reader would say them.
  function filterValue(report, k, v) {
    if (k === 'test') return tx('ts_' + v) || v;
    if (k === 'source') return tx('src_' + v) || v;
    if (k === 'status') return tx((report === 'approvals' ? 'rq_' : 'st_') + v) || v;
    if (k === 'type') return tx('log_' + v) || v;
    if (k === 'success') return v === 'true' ? t('yes') : t('no');
    if (k === 'show_off' || k === 'show_removed' || k === 'mine' || k === 'deleted') return t('yes');
    if (k === 'reason') return tx('dr_' + v) || v;
    if (k === 'item_type') return tx('it_' + v) || v;
    return quote(short(String(v), 60));
  }
  const exportNotes = (notes, nv, report) => {
    const f = Object.entries(nv.filters || {}).filter(([k]) => !(report === 'log' && k === 'type'));
    if (f.length) notes.push(t('au_export_filters', { filters: f.map(([k, v]) => `${tx('xf_' + k) || k}: ${filterValue(report, k, v)}`).join(lang === 'ar' ? '، ' : ', ') }));
    if (nv.truncated) notes.push(t('au_export_truncated'));
  };

  // Cells of the notification policy that changed (1.9.0): «وظائف عالقة» أُوقف لدور «عضو فريق»، …
  function policyChanges(o, n) {
    const out = [];
    const typeName = k => tx('nt_' + k) || k;
    for (const k of Object.keys(n || {})) {
      const a = o?.[k] || {}, b = n[k] || {};
      for (const role of Object.keys({ ...(a.roles || {}), ...(b.roles || {}) })) {
        if (!!a.roles?.[role] !== !!b.roles?.[role]) out.push(t('au_policy_role', { type: typeName(k), role: tx('rl_' + role) || role, state: t(b.roles?.[role] ? 'au_policy_on' : 'au_policy_off') }));
      }
      if (!!a.push !== !!b.push) out.push(t('au_policy_push', { type: typeName(k), state: t(b.push ? 'au_policy_push_on' : 'au_policy_push_off') }));
      if (!!a.mandatory !== !!b.mandatory) out.push(t('au_policy_mandatory', { type: typeName(k), state: t(b.mandatory ? 'au_policy_mandatory_on' : 'au_policy_mandatory_off') }));
    }
    return out.length ? out.join(listSep) : t('au_policy_none');
  }

  // { text, lines: [{label, from, to}], items: [...], notes: [string], type }
  return function describe(r) {
    const ctx = r.context || {};
    const app = (lang === 'en' && r.app_name_en) || r.app_name_ar || r.app_name_en || ctx.app_id || r.entity_id || '';
    const fn = r.fn_code ? fnName({ code: r.fn_code, name_ar: r.fn_name_ar, name_en: r.fn_name_en }) : (r.summary ? quote(short(r.summary, 90)) : '#' + r.entity_id);
    const vars = { app, fn, id: r.entity_id };
    const type = tx('au_a_' + r.action) || r.action;
    const notes = [];
    let text = null, lines = [], items = null;
    const key = `${r.action}:${r.entity}`;

    switch (key) {
      case 'update:function': {
        lines = diff(r.old_value, r.new_value);
        const o = r.old_value || {}, n = r.new_value || {};
        const appId = ctx.app_id || r.app_id;
        const who = person({ full_name: r.full_name, username: r.username });
        if (o.enabled === true && n.enabled === false && 'disabled_reason' in n) {
          // «ألغى أحمد احتساب الوظيفة D7 (مكررة مع D3، D5): ملاحظة…»
          const reason = reasonPhrase(n, appId);
          text = n.disabled_note ? t('au_disable_function_note', { ...vars, who, reason, note: quote(short(n.disabled_note, 200)) })
            : t('au_disable_function', { ...vars, who, reason });
          lines = lines.length > 1 ? lines : [];
          if (ctx.bulk) notes.push(t('au_disable_bulk', { n: ctx.count ?? '' }));
        } else if (o.enabled === false && n.enabled === true) {
          text = t('au_enable_function', { ...vars, who });
          if ('disabled_reason' in o) notes.push(t('au_enable_was', { reason: reasonPhrase(o, appId) + (o.disabled_note ? ': ' + quote(short(o.disabled_note)) : '') }));
          if (ctx.bulk) notes.push(t('au_disable_bulk', { n: ctx.count ?? '' }));
        } else if (lines.some(l => NAME_FIELDS.has(l.field)) && lines.every(l => NAME_FIELDS.has(l.field) || l.field === 'rename_reason')) {
          // «غيّر أحمد اسم البند D7 من «…» إلى «…» — السبب: «…»» (1.9.1); the English name as a line when both changed
          const code = r.fn_code || /^[^/]+\/(\S+)/.exec(r.summary || '')?.[1] || '#' + r.entity_id;
          const ar = lines.find(l => l.field === 'name_ar'), en = lines.find(l => l.field === 'name_en');
          const main = ar || en;
          const reason = n.rename_reason ? quote(short(String(n.rename_reason), 200)) : null;
          const key = (ar ? 'au_rename' : 'au_rename_en') + (reason ? '' : '_noreason');
          text = t(key, { ...vars, who, code, from: main.from, to: main.to, reason });
          lines = ar && en ? [en] : [];
        } else if (lines.length === 1 && lines[0].field === 'item_type') {
          // «غيّر أحمد نوع البند D7 من وظيفة إلى تقرير» (1.8.0)
          text = t('au_item_type', { ...vars, who, from: lines[0].from, to: lines[0].to });
          lines = [];
          if (ctx.bulk) notes.push(t('au_type_bulk', { n: ctx.count ?? '' }));
        } else text = lines.length ? changeSentence(r, lines, { one: 'au_update_function_one', many: 'au_update_function', vars }) : null;
        break;
      }
      case 'move:function': {
        // «نقل أحمد البند D7 من «شؤون العاملين» (الموارد البشرية) إلى «الحسابات» (المالية) برمز C12 — نُقل وزن 0.20 — السبب: «…»»
        const o = r.old_value || {}, n = r.new_value || {};
        const share = +n.weight_share || 0;
        const weight = share > 0 ? t('au_move_weight', { share: share2(share) }) : t(ctx.weight_mode === 'auto' ? 'au_move_weight_auto' : 'au_move_weight_none');
        text = t('au_move', { who: person({ full_name: r.full_name, username: r.username }), code: o.code || ctx.code_before || '', from: place(ctx, 'from'),
          to: place(ctx, 'to'), new: n.code || ctx.code_after || '', weight, reason: quote(short(String(n.reason ?? ''), 200)) });
        if (ctx.src_weight && ctx.dst_weight && ctx.total_share > 0) {
          notes.push(t('au_move_weights', { src: nmc(ctx, 'from_app') || ctx.from_app_id, src_from: num(ctx.src_weight.before), src_to: num(ctx.src_weight.after),
            dst: nmc(ctx, 'to_app') || ctx.to_app_id, dst_from: num(ctx.dst_weight.before), dst_to: num(ctx.dst_weight.after) }));
        }
        if (ctx.bulk) notes.push(t('au_move_bulk', { n: ctx.count ?? '' }));
        break;
      }
      case 'create:function': text = t('au_create_function', { ...vars, fn: r.fn_code ? fn : fnName(r.new_value || {}) });
        lines = ['item_type', 'weight', 'progress', 'enabled', 'reference', 'name_en'].filter(k => r.new_value?.[k] != null && r.new_value[k] !== '')
          .map(k => ({ field: k, label: fieldLabel(k), from: '', to: fmt(k, r.new_value[k]) }));
        break;
      case 'remove:function': text = t('au_remove_function', vars);
        if (r.new_value?.reason) notes.push(t('au_reason', { reason: r.new_value.reason }));
        break;
      case 'restore:function': text = t('au_restore_function', vars); break;
      case 'bulk_update:application': {
        const f = r.new_value?.field;
        text = t('au_bulk_update', { ...vars, field: fieldLabel(f), to: fmt(f, r.new_value?.value), n: ctx.changed ?? ctx.count ?? '' });
        items = itemLines(ctx.items);
        break;
      }
      case 'update:application':
        lines = diff(r.old_value, r.new_value);
        text = lines.length === 1 && lines[0].field === 'weight' ? t('au_update_app_weight', { ...vars, from: lines[0].from, to: lines[0].to }) : null;
        if (ctx.move && ctx.reason) notes.push(t('au_weight_move', { reason: ctx.reason }) + (ctx.move_reason ? ' — ' + quote(short(String(ctx.move_reason), 200)) : ''));
        break;
      case 'reset:application': text = t('au_reset_weights'); break;
      case 'update:report':
        lines = diff(r.old_value, r.new_value);
        text = lines.length ? changeSentence(r, lines, { one: 'au_update_report_one', many: 'au_update_report', vars }) : null;
        break;
      case 'update:setting': {
        const k = r.entity_id;
        if (k === 'notify.policy') { text = t('au_policy', { changes: policyChanges(r.old_value?.value, r.new_value?.value) }); break; }
        text = t('au_update_setting', { key: settingLabel(k), from: fmt(k, r.old_value?.value), to: fmt(k, r.new_value?.value) });
        break;
      }
      case 'update:schedule': text = t('au_update_schedule'); lines = diff(r.old_value, r.new_value); break;
      case 'export:tracker': text = t('au_export_tracker'); break;
      case 'import:tracker': text = t('au_import_tracker'); break;
      case 'export:log': {
        const nv = r.new_value || {};
        const n = nv.rows ?? parseInt(r.summary, 10);
        text = t('au_export_log', { log: t('log_' + r.entity_id), format: nv.format === 'xlsx' ? (lang === 'ar' ? 'إكسل' : 'Excel') : 'CSV', n: Number.isFinite(n) ? n : '—' });
        exportNotes(notes, nv, 'log');
        break;
      }
      case 'create:user': text = t('au_create_user', { target: quote(r.summary || r.entity_id) });
        lines = diff({}, r.new_value).filter(l => l.field !== 'password');
        if (ctx.via === 'bulk_import') notes.push(t('au_via_bulk_import'));
        break;
      case 'update:user':
        if (r.summary === 'language') { text = t('au_update_language', { to: fmt('language', r.new_value?.language) }); break; }
        if (r.new_value && 'notify_blocks' in r.new_value) {
          // «حظر تنبيه «تعارض النجاح» على الجوال للمستخدم «سارة»» (1.9.0)
          const list = (r.new_value.notify_blocks || []).map(b => t(b.channel === 'mobile' ? 'au_block_item_mobile' : 'au_block_item_all',
            { type: b.type === '*' ? t('block_every_type') : tx('nt_' + b.type) || b.type })).join(listSep);
          text = t('au_notify_blocks', { target: quote(person(ctx.target) !== '—' ? person(ctx.target) : r.summary || r.entity_id), list: list || t('au_blocks_none') });
          break;
        }
        text = t('au_update_user', { target: quote(r.summary || r.entity_id) });
        lines = diff(r.old_value, r.new_value);
        break;
      case 'reset_password:user': text = t('au_reset_password', { target: quote(r.summary) }); break;
      case 'reset_2fa:user': text = t('au_reset_2fa', { target: quote(r.summary) }); break;
      case 'unlock:user': text = t('au_unlock', { target: quote(r.summary) }); break;
      case 'revoke_sessions:user': text = t('au_revoke_sessions', { target: quote(r.summary) }); break;
      case 'view:user': text = t('au_view_user', { target: quote(r.summary || r.entity_id) }); break;
      case 'view:log': text = t('au_view_log', { log: t('log_' + r.entity_id) }); break;
      case 'verify:log': text = t('au_verify_log', { summary: r.summary || '' }); break;
      case 'purge:log': text = t('au_purge_log', { n: r.new_value?.deleted?.audit_log ?? 0, days: r.new_value?.audit_retention_days ?? '' }); break;
      case 'purge_skipped:log': text = t('au_purge_skipped_log', { tables: (r.new_value?.tables || []).map(x => x.table).join(', ') }); break;
      case 'purge_acknowledge:log': text = t('au_purge_acknowledge_log', { tables: (r.new_value?.tables || []).map(x => x.table).join(', ') }); break;
      case 'restore:database': {
        // 1.12.0: the items restored (web UI or CLI) and the result of the audit-chain check
        const nv = r.new_value || {};
        text = Array.isArray(nv.items) ? t('au_restore_web', { items: nv.items.map(i => tx('bk_item_' + i) || i).join(listSep), verify: nv.verify ? tx('bk_verify_' + (nv.verify === 'ok' ? 'ok' : 'failed')) : '—' })
          : t('au_restore_database');
        if (nv.file || nv.config) notes.push([nv.file, nv.config, nv.logs].filter(Boolean).join(' · '));
        break;
      }
      // backups (1.12.0): Settings → «النسخ الاحتياطي»
      case 'update:backup_config': {
        const ch = ctx.changes || [];
        text = t('au_backup_config', { fields: ch.map(c => c.field).join(listSep) || r.summary || '' });
        lines = ch.map(c => ({ field: c.field, label: c.field, from: c.secret ? (c.old ? t('bk_secret_saved') : t('au_empty')) : fmt(c.field, c.old),
          to: c.secret ? (c.new ? t('au_secret_changed') : t('au_empty')) : fmt(c.field, c.new) }));
        break;
      }
      case 'escrow_confirm:backup_config': text = t('au_backup_escrow', { key: r.entity_id || '—' }); break;
      case 'passphrase_change:backup_config': text = t('au_backup_passphrase', { key: r.new_value?.key_id || '—' }); break;
      case 'backup_job:backup_job': text = t('au_backup_job', { kind: tx('bk_kind_' + r.summary) || r.summary }); break;
      case 'backup_upload:backup_file': text = t('au_backup_upload', { file: r.entity_id || '' }); break;
      case 'restore_inspect:backup_job': text = t('au_restore_inspect', { files: Object.values(r.new_value?.files || {}).join(listSep) }); break;
      case 'restore_start:backup_job': text = t('au_restore_start', { items: (r.new_value?.items || []).map(i => tx('bk_item_' + i) || i).join(listSep),
        source: tx('bk_src_' + r.new_value?.source) || r.new_value?.source || '' }); break;
      case 'bulk_update:user': text = t('au_bulk_user', { summary: r.summary || '' }); break;
      case 'bulk_create:user': text = t('au_bulk_create_user', { n: r.new_value?.count ?? '' });
        if (r.new_value?.usernames?.length) notes.push(short(r.new_value.usernames.join(', '), 300));
        break;
      // deleting / restoring users (1.7.0): «حذف المدير أحمد المستخدم «سالم» — السبب: …»
      case 'delete:user': {
        const reason = ctx.reason ?? r.new_value?.reason ?? '';
        text = t('au_delete_user', { who: actorName(r), target: quote(person(ctx.target) !== '—' ? person(ctx.target) : r.summary || r.entity_id), reason: quote(short(reason, 200)) });
        if (ctx.bulk) notes.push(t('au_delete_bulk', { n: ctx.count ?? '' }));
        if (ctx.sessions_revoked) notes.push(t('au_delete_sessions', { n: ctx.sessions_revoked }));
        const closed = (ctx.requests_withdrawn?.length || 0) + (ctx.imports_rejected?.length || 0);
        if (closed) notes.push(t('au_delete_closed', { n: closed }));
        break;
      }
      case 'bulk_delete:user': {
        const names = (ctx.users || []).map(person);
        text = t('au_bulk_delete_user', { who: actorName(r), n: r.new_value?.count ?? names.length,
          names: short(names.map(quote).join(listSep), 300), reason: quote(short(ctx.reason ?? r.new_value?.reason ?? '', 200)) });
        break;
      }
      case 'restore:user': text = t('au_restore_user', { who: actorName(r), target: quote(person(ctx.target) !== '—' ? person(ctx.target) : r.summary || r.entity_id),
        reason: quote(short(ctx.reason ?? r.new_value?.reason ?? '', 200)) });
        notes.push(t('au_restore_temp_password'));
        break;
      case 'edit_request:edit_request': {
        items = itemLines(ctx.items);
        const only = ctx.items?.length === 1 ? ctx.items[0] : null;
        if (ctx.to_app_id && ctx.items?.every(i => i.field === 'move')) {
          // a move request (1.10.0): «طلب نقل «D7 …» من ess إلى acc — السبب: «…»»
          const first = ctx.items[0];
          text = t('au_edit_request_move', { n: ctx.items.length === 1 ? items[0].item : ctx.items.length, from: app || ctx.app_id,
            to: (lang === 'en' && first?.new?.name_en) || first?.new?.name_ar || ctx.to_app_id, reason: quote(short(String(ctx.reason ?? first?.meta?.reason ?? ''), 200)) });
          if (ctx.items.length === 1) items = null;
          break;
        }
        if (only?.field === 'create') text = t('au_edit_request_add', { ...vars, fn: items[0].item });
        else if (only?.field === 'removed') text = t(only.new?.removed ? 'au_edit_request_remove' : 'au_edit_request_restore', { ...vars, fn: items[0].item });
        else if (only) text = t(only.kind === 'report' ? 'au_edit_request_report_one' : 'au_edit_request_one',
          { ...vars, fn: items[0].item, field: items[0].label, from: items[0].from, to: items[0].to });
        else if (ctx.items?.length && ctx.items.every(i => i.field === 'enabled' && i.new === false && i.meta)) {
          notes.push(t('au_reason', { reason: reasonPhrase(ctx.items[0].meta, ctx.app_id) + (ctx.items[0].meta.disabled_note ? ': ' + ctx.items[0].meta.disabled_note : '') }));
        }
        else if (ctx.items) text = t('au_edit_request', { ...vars, n: ctx.items.length });
        if (only) items = null;          // already said in the sentence
        break;
      }
      case 'edit_approve_source:edit_request':
        // the first of the two approvals of a move (1.10.0)
        text = t('au_edit_approve_source', { ...vars, req: person(ctx.requested_by) });
        if (ctx.reason) notes.push(t('au_approval_note', { note: ctx.reason }));
        items = itemLines(ctx.items);
        break;
      case 'edit_approve:edit_request': case 'edit_reject:edit_request': case 'edit_withdraw:edit_request': {
        if (!ctx.via) break;
        const res = r.new_value || {};
        text = t('au_' + r.action, { ...vars, req: person(ctx.requested_by), applied: res.applied ?? '' });
        if (res.skipped) notes.push(t('au_skipped', { n: res.skipped }));
        if (ctx.user_deleted) notes.push(t('au_closed_user_deleted'));
        else if (ctx.reason) notes.push(t(r.action === 'edit_approve' ? 'au_approval_note' : 'au_reason', { reason: ctx.reason, note: ctx.reason }));
        items = itemLines(ctx.items);
        break;
      }
      case 'import_submit:import_batch': case 'import_approve_lead:import_batch': case 'import_approve_final:import_batch':
      case 'import_apply:import_batch': case 'import_reject:import_batch': {
        if (!ctx.via) break;
        const file = ctx.filename ? quote(ctx.filename) : '—';
        const target = ctx.target === 'reports' ? t('au_import_target_reports') : ctx.department_id || '';
        const res = r.new_value || {};
        text = t('au_' + r.action, { id: r.entity_id, file, target, n: ctx.items?.length ?? res.changes ?? '', applied: res.applied ?? '' });
        if (res.skipped) notes.push(t('au_skipped', { n: res.skipped }));
        if (ctx.user_deleted) notes.push(t('au_closed_user_deleted'));
        else if (ctx.reason) notes.push(t('au_reason', { reason: ctx.reason }));
        if (ctx.note) notes.push(t('au_approval_note', { note: ctx.note }));
        items = itemLines(ctx.items);
        break;
      }
      // phones (1.9.0): «ربط أحمد الجوال «Samsung A54» بحسابه», «إلغاء الجوال … من المسؤول خالد: الحساب معطّل»
      case 'pair:device': text = t('au_pair_device', { who: actorName(r), name: ctx.device?.name || r.new_value?.name || '' }); break;
      case 'revoke:device': {
        const reason = tx('rr_' + (ctx.reason || r.new_value?.reason)) || ctx.reason || '';
        const owner = quote(person(ctx.owner)), name = ctx.device?.name || '';
        text = ctx.by && ctx.by.id !== ctx.owner?.id ? t('au_revoke_device_by', { by: person(ctx.by), owner, name, reason }) : t('au_revoke_device', { owner, name, reason });
        break;
      }
      case 'update:branding': text = t('au_branding_update', { key: tx('brand_' + r.entity_id) || r.entity_id }); break;
      case 'reset:branding': text = t('au_branding_reset', { key: tx('brand_' + r.entity_id) || r.entity_id }); break;
      default:
        if (r.action === 'export' && EXPORT_REPORTS.has(r.entity)) {
          const nv = r.new_value || {};
          const tg = nv.target;
          const target = r.entity === 'functions' && app ? quote(app)
            : tg?.name_ar || tg?.name_en ? quote((lang === 'en' && tg.name_en) || tg.name_ar || tg.name_en)
              : r.entity_id ? '#' + r.entity_id : '';
          text = t(target ? 'au_export_report_of' : 'au_export_report', { report: t('xr_' + r.entity), target, n: nv.rows ?? '—' });
          exportNotes(notes, nv, r.entity);
        }
        break;
    }

    if (!text) {        // anything not covered above (or an older row without context)
      text = t('au_generic', { action: type, entity: tx('au_e_' + r.entity) || r.entity, id: r.entity_id || '' }) + (r.summary ? ' — ' + r.summary : '');
      if (!lines.length) lines = diff(r.old_value, r.new_value);
    }
    // how the change came in
    if (ctx.via === 'edit_request' && ctx.approved_by && !r.action.startsWith('edit_')) {
      notes.unshift(t('au_via_request', { req: person(ctx.requested_by), approver: person(ctx.approved_by), id: ctx.request_id }));
    }
    if (ctx.via === 'import' && ctx.approved_by && !r.action.startsWith('import_')) {
      notes.unshift(t('au_via_import', { file: ctx.filename ? quote(ctx.filename) : '', req: person(ctx.requested_by),
        approver: person(ctx.approved_by), final: person(ctx.final_by), id: ctx.batch_id }));
    }
    return { text, type, lines, items: items?.length ? items : null, notes, who: actorName(r), maxInline: MAX_INLINE };
  };
}
