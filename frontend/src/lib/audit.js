// Turns an audit-log row into plain sentences for the Logs screen: what was changed, on which function /
// application, from which value to which value, and how it came in (direct edit, approved request, import).
// Rows written before migration 007 have no `context`; they still read well from old_value / new_value.

const STATUS_PREFIX = { test_status: 'ts_', notif_status: 'ns_', review_status: 'rv_', status: 'rs_' };
const PCT_FIELDS = new Set(['progress']);
const BOOL_FIELDS = new Set(['is_active', 'totp_exempt', 'must_change_password', 'approval.edits_need_lead']);
const SETTING_LABEL = {
  'mfa.mode': 'mfa_mode', 'mfa.issuer': 'mfa_issuer', 'approval.edits_need_lead': 'edits_need_lead',
  'app.org_name_ar': 'org_name_ar', 'app.org_name_en': 'org_name_en', 'app.default_language': 'default_language',
  'security.password_min_length': 'password_min_length', 'logs.retention_days': 'retention_days',
  'logs.access_retention_days': 'access_retention_days', 'calc.weight_mode': 'weight_mode',
  'calc.notif_share': 'notif_share', 'calc.reports_share': 'reports_share',
};
const MAX_INLINE = 3;      // change lines shown under the sentence in the list; the rest are in the details

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const short = (s, n = 120) => (s.length > n ? s.slice(0, n) + '…' : s);
const num = v => (Number.isFinite(+v) ? String(Math.round(+v * 100) / 100) : String(v));

export function makeAudit({ t, lang }) {
  const tx = (key, vars) => { const s = t(key, vars); return s === key ? null : s; };   // null when the key is missing
  const fieldLabel = f => tx('au_f_' + f) || tx(f) || f;
  const settingLabel = k => (SETTING_LABEL[k] && tx(SETTING_LABEL[k])) || k;
  const person = u => (u ? u.full_name || u.username || '—' : '—');
  const quote = s => (lang === 'ar' ? `«${s}»` : `“${s}”`);

  // A value as a reader would say it, for the given field.
  function fmt(field, v) {
    if (v === null || v === undefined || v === '') return field === 'note' ? t('au_no_note') : t('au_empty');
    if (STATUS_PREFIX[field] !== undefined) return t(STATUS_PREFIX[field] + v);
    if (PCT_FIELDS.has(field)) return num(v) + '%';
    if (field === 'calc.notif_share' || field === 'calc.reports_share') return num(+v * 100) + '%';
    if (field === 'calc.weight_mode') return tx('weight_mode_' + v) || String(v);
    if (field === 'enabled') return v ? t('au_on') : t('au_off');
    if (field === 'removed') return v ? t('au_removed') : t('au_present');
    if (field === 'language' || field === 'app.default_language') return tx('au_lang_' + v) || String(v);
    if (field === 'mfa.mode') return tx('mfa_' + v) || String(v);
    if (BOOL_FIELDS.has(field) || typeof v === 'boolean') return v ? t('yes') : t('no');
    if (field === 'role_id') return v;
    if (field === 'note' || typeof v === 'string') return quote(short(String(v)));
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) {
      if (field === 'scopes') return v.map(s => s.ref_id || s).join('، ') || t('au_empty');
      if (field === 'overrides') return v.map(o => `${o.permission}${o.granted ? '+' : '−'}`).join(', ') || t('au_empty');
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
    const what = i.kind === 'function' && (i.code || i.name_ar) ? fnName(i) : i.app_id || '';
    if (i.field === 'create') return { item: fnName(i.new || {}), label: fieldLabel('create'), from: '', to: '', applied: i.applied };
    if (i.field === 'removed') {
      return { item: what, label: fieldLabel('removed'), from: fmt('removed', i.old?.removed), to: fmt('removed', i.new?.removed) + (i.new?.reason ? ' — ' + t('au_reason', { reason: i.new.reason }) : ''), applied: i.applied };
    }
    const f = i.kind === 'weight' ? 'weight' : i.field;
    return { item: what, label: fieldLabel(f), from: fmt(f, i.old), to: fmt(f, i.new), applied: i.applied };
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
      case 'update:function':
        lines = diff(r.old_value, r.new_value);
        text = lines.length ? changeSentence(r, lines, { one: 'au_update_function_one', many: 'au_update_function', vars }) : null;
        break;
      case 'create:function': text = t('au_create_function', { ...vars, fn: r.fn_code ? fn : fnName(r.new_value || {}) });
        lines = ['weight', 'progress', 'enabled', 'reference', 'name_en'].filter(k => r.new_value?.[k] != null && r.new_value[k] !== '')
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
        break;
      case 'reset:application': text = t('au_reset_weights'); break;
      case 'update:report':
        lines = diff(r.old_value, r.new_value);
        text = lines.length ? changeSentence(r, lines, { one: 'au_update_report_one', many: 'au_update_report', vars }) : null;
        break;
      case 'update:setting': {
        const k = r.entity_id;
        text = t('au_update_setting', { key: settingLabel(k), from: fmt(k, r.old_value?.value), to: fmt(k, r.new_value?.value) });
        break;
      }
      case 'update:schedule': text = t('au_update_schedule'); lines = diff(r.old_value, r.new_value); break;
      case 'export:tracker': text = t('au_export_tracker'); break;
      case 'import:tracker': text = t('au_import_tracker'); break;
      case 'export:log': text = t('au_export_log', { log: t('log_' + r.entity_id), summary: r.summary || '' }); break;
      case 'create:user': text = t('au_create_user', { target: quote(r.summary || r.entity_id) });
        lines = diff({}, r.new_value).filter(l => l.field !== 'password'); break;
      case 'update:user':
        if (r.summary === 'language') { text = t('au_update_language', { to: fmt('language', r.new_value?.language) }); break; }
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
      case 'restore:database': text = t('au_restore_database'); break;
      case 'bulk_update:user': text = t('au_bulk_user', { summary: r.summary || '' }); break;
      case 'edit_request:edit_request': {
        items = itemLines(ctx.items);
        const only = ctx.items?.length === 1 ? ctx.items[0] : null;
        if (only?.field === 'create') text = t('au_edit_request_add', { ...vars, fn: items[0].item });
        else if (only?.field === 'removed') text = t(only.new?.removed ? 'au_edit_request_remove' : 'au_edit_request_restore', { ...vars, fn: items[0].item });
        else if (only) text = t(only.kind === 'report' ? 'au_edit_request_report_one' : 'au_edit_request_one',
          { ...vars, fn: items[0].item, field: items[0].label, from: items[0].from, to: items[0].to });
        else if (ctx.items) text = t('au_edit_request', { ...vars, n: ctx.items.length });
        if (only) items = null;          // already said in the sentence
        break;
      }
      case 'edit_approve:edit_request': case 'edit_reject:edit_request': case 'edit_withdraw:edit_request': {
        if (!ctx.via) break;
        const res = r.new_value || {};
        text = t('au_' + r.action, { ...vars, req: person(ctx.requested_by), applied: res.applied ?? '' });
        if (res.skipped) notes.push(t('au_skipped', { n: res.skipped }));
        if (ctx.reason) notes.push(t(r.action === 'edit_approve' ? 'au_approval_note' : 'au_reason', { reason: ctx.reason, note: ctx.reason }));
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
        if (ctx.reason) notes.push(t('au_reason', { reason: ctx.reason }));
        if (ctx.note) notes.push(t('au_approval_note', { note: ctx.note }));
        items = itemLines(ctx.items);
        break;
      }
      case 'update:branding': text = t('au_branding_update', { key: tx('brand_' + r.entity_id) || r.entity_id }); break;
      case 'reset:branding': text = t('au_branding_reset', { key: tx('brand_' + r.entity_id) || r.entity_id }); break;
      default: break;
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
    return { text, type, lines, items: items?.length ? items : null, notes, who: r.full_name || r.username || '—', maxInline: MAX_INLINE };
  };
}
