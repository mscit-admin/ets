import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { STANDARD_MODULES, EXTRA_MODULES } from '../lib/erpModules.js';
import { Alert, Modal, toast } from './ui.jsx';
import { REASON_MAX, REASON_MIN, emptyMove, moveAppAfterDept, moveReady, moveReasonProblem, num2, pctDelta, weightDelta } from '../lib/itemRules.js';

// Moving items to another application (1.10.0, backend services/move.js): the module (department) first, then the
// application (only those in the reader's scope, not the current one), a required reason (3–500 characters, spaces
// not counted — the rule of a rename; lib/itemRules.js, shared with the mobile app), and the impact before → after on both applications, their department(s) and
// the project, with the application weight that goes with the items. Confirm stays disabled until all is valid.
// ERP module of a department (lib/erpModules.js), shown next to its name in the module list.
const moduleOf = id => [...STANDARD_MODULES, ...EXTRA_MODULES].find(m => m.depts.includes(id)) || null;

// Departments → applications the reader may move to (GET /tracker/move-targets).
function useTargets(appId) {
  const [v, setV] = useState({ departments: null, error: null });
  useEffect(() => {
    let alive = true;
    api.get(path`/tracker/move-targets?app_id=${appId}`).then(r => { if (alive) setV({ departments: r.departments, error: null }); })
      .catch(e => { if (alive) setV({ departments: [], error: e }); });
    return () => { alive = false; };
  }, [appId]);
  return v;
}

// Impact of moving these items to toApp (debounced POST …/preview); null while loading or without a destination.
function usePreview(appId, ids, toApp, single) {
  const [v, setV] = useState({ data: null, error: null, loading: false });
  const key = ids.join(',');
  useEffect(() => {
    const list = key ? key.split(',').map(Number) : [];
    if (!toApp || !list.length) { setV({ data: null, error: null, loading: false }); return undefined; }
    let alive = true;
    setV(x => ({ ...x, loading: true }));
    const h = setTimeout(() => {
      const req = single ? api.post(path`/tracker/functions/${list[0]}/move/preview`, { to_app_id: toApp })
        : api.post(path`/tracker/applications/${appId}/bulk-move/preview`, { to_app_id: toApp, function_ids: list });
      req.then(r => { if (alive) setV({ data: r, error: null, loading: false }); }).catch(e => { if (alive) setV({ data: null, error: e, loading: false }); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [appId, key, toApp, single]);
  return v;
}

// Before → after table of a move (also the approvals screen, with the impact stored when the move was requested).
export function MoveImpact({ impact }) {
  const { t, nm } = useI18n();
  if (!impact) return null;
  const [src, dst] = impact.apps;
  const delta = (b, a) => {
    const d = pctDelta(b, a, pc);
    return <td className={'num-col num ' + (d.tone === 'muted' ? 'muted' : d.tone + '-text')}>{d.text}</td>;
  };
  const pctRow = (label, x, k) => (
    <tr key={k}><th scope="row" className="mv-row-label">{label}</th><td className="num-col num">{pc(x.before)}%</td><td className="num-col num"><b>{pc(x.after)}%</b></td>{delta(x.before, x.after)}</tr>
  );
  const wRow = (label, x, k) => {
    const d = weightDelta(x.before, x.after);
    return (
      <tr key={k}><th scope="row" className="mv-row-label">{label}</th><td className="num-col num">{num2(x.before)}</td><td className="num-col num"><b>{num2(x.after)}</b></td>
        <td className={'num-col num ' + (d.tone === 'muted' ? 'muted' : '')}>{d.text}</td></tr>
    );
  };
  const w = impact.weight;
  return (
    <div className="impact mv-impact">
      <div className="impact-title">{t('mv_impact_title')}</div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th scope="col" /><th scope="col" className="num-col">{t('before')}</th><th scope="col" className="num-col">{t('after')}</th><th scope="col" className="num-col">{t('change')}</th></tr></thead>
          <tbody>
            {pctRow(t('mv_row_src', { name: nm(src) }), src.pct, 'src')}
            {pctRow(t('mv_row_dst', { name: nm(dst) }), dst.pct, 'dst')}
            {impact.departments.map(d => pctRow(t('mv_row_dept', { name: nm(d) }), d.pct, 'd' + d.id))}
            {pctRow(t('mv_row_project'), impact.total, 'total')}
            <tr className="mv-sep"><th scope="rowgroup" colSpan={4}>{t('mv_weights')}</th></tr>
            {wRow(t('mv_weight_src'), w.src, 'ws')}
            {wRow(t('mv_weight_dst'), w.dst, 'wd')}
            <tr className="mv-moved"><th scope="row" className="mv-row-label">{t('mv_weight_moved')}</th><td /><td className="num-col num"><b>{num2(w.share)}</b></td><td /></tr>
          </tbody>
        </table>
      </div>
      <p className="muted small mv-note">{t('mv_counted', { n: impact.counted, total: impact.items })}</p>
      <p className="muted small mv-note">{impact.mode === 'auto' ? t('mv_weight_auto')
        : w.share > 0 ? t('mv_weight_rule', { src: num2(w.src.before), w: num2(w.moved_weight), sum: num2(w.src_items_weight) }) : t('mv_weight_none')}</p>
      {w.overflow && <Alert kind="red">{t('mv_weight_overflow')}</Alert>}
    </div>
  );
}

// Module, application and reason of a move, and its impact. ids: the items; single: one item (its own endpoints).
// value: { dept, app, reason }; returns the preview to the parent through onPreview.
export function MoveFields({ appId, ids, single, value, onChange, onPreview, showErrors }) {
  const { t, nm, errText } = useI18n();
  const uid = useId();
  const { departments, error } = useTargets(appId);
  const dept = departments?.find(d => d.id === value.dept) || null;
  const pv = usePreview(appId, ids, value.app, single);
  const report = useRef(onPreview);
  report.current = onPreview;
  useEffect(() => { report.current?.(pv); }, [pv]);
  const rProblem = moveReasonProblem(value.reason);
  const showReasonErr = !!rProblem && (showErrors || value.touched);
  const len = value.reason.trim().length;
  if (error) return <Alert>{errText(error)}</Alert>;
  if (!departments) return <div className="muted small">{t('loading')}…</div>;
  if (!departments.length) return <Alert kind="orange">{t('mv_no_targets')}</Alert>;
  return (
    <>
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor={uid + '-d'}>{t('mv_module')} *</label>
          <select id={uid + '-d'} className="input" value={value.dept} required aria-required="true"
            onChange={e => {
              const d = departments.find(x => x.id === e.target.value);
              onChange({ ...value, dept: e.target.value, app: moveAppAfterDept(d) });
            }}>
            <option value="">{t('mv_module_pick')}</option>
            {departments.map(d => {
              const m = moduleOf(d.id);
              const mod = m ? nm(m) : null;
              return <option key={d.id} value={d.id}>{nm(d)}{mod && mod !== nm(d) ? ` — ${mod}` : ''}</option>;
            })}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={uid + '-a'}>{t('mv_app')} *</label>
          <select id={uid + '-a'} className="input" value={value.app} disabled={!dept} required aria-required="true"
            aria-describedby={!dept ? uid + '-ah' : undefined} onChange={e => onChange({ ...value, app: e.target.value })}>
            <option value="">{dept ? t('mv_app_pick') : t('mv_app_first')}</option>
            {dept?.applications.map(a => <option key={a.id} value={a.id}>{nm(a)}</option>)}
          </select>
          {!dept && <span id={uid + '-ah'} className="field-hint">{t('mv_app_first')}</span>}
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={uid + '-r'}>{t('mv_reason')} *</label>
        <textarea id={uid + '-r'} className={'input' + (showReasonErr ? ' input-required' : '')} rows={3} maxLength={REASON_MAX + 50}
          value={value.reason} placeholder={t('mv_reason_placeholder')} required aria-required="true" aria-invalid={showReasonErr || undefined}
          aria-describedby={uid + '-rh' + (showReasonErr ? ' ' + uid + '-re' : '')}
          onChange={e => onChange({ ...value, reason: e.target.value, touched: value.touched || !!e.target.value.trim() })}
          onBlur={() => onChange({ ...value, touched: true })} />
        <span id={uid + '-rh'} className="field-hint dr-count">
          <span>{t('mv_reason_hint', { min: REASON_MIN })}</span>
          <bdi dir="ltr" className={len > REASON_MAX ? 'red-text' : ''} aria-live="polite">{len}/{REASON_MAX}</bdi>
        </span>
        {showReasonErr && <span id={uid + '-re'} className="field-hint red-text" role="alert">{t(rProblem, { min: REASON_MIN })}</span>}
      </div>
      {!value.app ? <div className="impact muted small">{t('mv_impact_pick')}</div>
        : pv.error ? <Alert>{errText(pv.error)}</Alert>
          : pv.data ? <>
            {pv.data.needs_approval && <Alert kind="blue">{t('mv_needs_approval')}</Alert>}
            <MoveImpact impact={pv.data} />
          </> : <div className="muted small">{t('loading')}…</div>}
      <p className="muted small">{t('mv_code_note')}</p>
    </>
  );
}

// One item: the «نقل» action of a row (pages/Application.jsx).
export function MoveDialog({ app, f, onClose, onDone }) {
  const { t, nm, errText } = useI18n();
  const [v, setV] = useState(emptyMove);
  const [pv, setPv] = useState(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ids = useMemo(() => [f.id], [f.id]);
  const ok = moveReady(v, pv);
  const run = async () => {
    setTried(true);
    if (!ok || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/functions/${f.id}/move`, { to_app_id: v.app, reason: v.reason.trim() });
      toast(r?.pending ? t('sent_for_approval') : t('mv_done'), r?.pending ? 'blue' : 'green');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={t('mv_title')} onClose={onClose} wide
      footer={<>
        <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" disabled={!ok || busy} onClick={run}>{t('mv_confirm')}</button>
      </>}>
      {err && <Alert>{errText(err)}</Alert>}
      <dl className="rn-current">
        <div><dt>{t('mv_item')}</dt><dd><span className="code">{f.code}</span> <span lang="ar" dir="rtl">{f.name_ar}</span></dd></div>
        <div><dt>{t('application')}</dt><dd>{nm(app)}</dd></div>
      </dl>
      <MoveFields appId={app.id} ids={ids} single value={v} onChange={setV} onPreview={setPv} showErrors={tried} />
    </Modal>
  );
}
