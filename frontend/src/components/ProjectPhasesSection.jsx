import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { pc, pctTone } from '../lib/format.js';
import { Alert, Card, ErrorBox, Loading, toast, useLoad } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { useLiveUpdates } from '../lib/live.js';

// The icons an administrator may pick for a phase (a curated subset of the app's icon set — see lib/iconPaths.js).
const PHASE_ICONS = ['planning', 'factory', 'settings', 'users', 'flag', 'pulse', 'curve', 'scale', 'report', 'chart',
  'crm', 'item_function', 'item_report', 'clock', 'check', 'megaphone', 'search', 'edit', 'note', 'filter', 'home', 'circle'];

// A compact icon picker: a button showing the current icon that opens a small grid to choose from.
function IconPicker({ value, onChange, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <span className="icon-picker" ref={ref}>
      <button type="button" className="btn-icon" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label}>
        <Icon name={value || 'circle'} size={18} />
      </button>
      {open && (
        <div className="icon-picker-pop" role="menu">
          {PHASE_ICONS.map(n => (
            <button type="button" key={n} role="menuitemradio" aria-checked={n === value} aria-label={n}
              className={'icon-opt' + (n === value ? ' on' : '')} onClick={() => { onChange(n); setOpen(false); }}>
              <Icon name={n} size={18} />
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// A short unique slug for a new phase row (the key is required by the API; a-z0-9_- only).
const newKey = existing => {
  let i = existing.length + 1, k;
  do { k = 'phase' + i++; } while (existing.includes(k));
  return k;
};

// Live preview of the project roll-up as the user edits (same maths as backend services/project-phases.js).
function preview(rows, systemPct) {
  const totalW = rows.reduce((a, r) => a + Math.max(0, +r.weight || 0), 0);
  const phases = rows.map(r => {
    const eff = r.auto ? (+systemPct || 0) : (+r.pct || 0);
    return { ...r, effective_pct: eff, contribution: totalW > 0 ? Math.max(0, +r.weight || 0) * eff / totalW : 0 };
  });
  return { totalW, pct: phases.reduce((a, p) => a + p.contribution, 0), phases };
}

// The project-phases editor, rendered inside the Settings page as the «مراحل المشروع» tab (it was a standalone page
// before 1.12.54). Reading / writing the phases is for cfg | apv_final (the API enforces it); the Settings page lets
// an apv_final-only project manager in and shows only this tab.
export function ProjectPhasesSection() {
  const { t, errText } = useI18n();
  const { data, error, loading, reload, refresh } = useLoad(o => api.get('/tracker/project-phases', o), []);
  const [rows, setRows] = useState([]);
  const [systemPct, setSystemPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useLiveUpdates(refresh);

  // Load the server's phases on first load and on a live update, but keep the user's unsaved edits in place: only
  // re-seed the table when it has not been touched since the last load (dirty flag), mirroring Weights.jsx.
  const dirty = useRef(false);
  useEffect(() => {
    if (!data) return;
    setSystemPct(data.system_pct);
    if (!dirty.current) setRows(data.phases.map(p => ({ ...p, weight: String(p.weight), pct: String(p.pct) })));
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const edit = (i, patch) => { dirty.current = true; setRows(rs => rs.map((r, k) => (k === i ? { ...r, ...patch } : r))); };
  const setAuto = (i, on) => { dirty.current = true; setRows(rs => rs.map((r, k) => ({ ...r, auto: k === i ? on : (on ? false : r.auto) }))); };
  const add = () => { dirty.current = true; setRows(rs => [...rs, { key: newKey(rs.map(r => r.key)), name_ar: '', name_en: '', icon: 'circle', weight: '1', pct: '0', auto: false }]); };
  const del = i => { dirty.current = true; setRows(rs => rs.filter((_, k) => k !== i)); };
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    dirty.current = true;
    setRows(rs => { const n = [...rs]; [n[i], n[j]] = [n[j], n[i]]; return n; });
  };

  const pv = preview(rows, systemPct);
  // client-side validation: a non-empty Arabic name per row, non-negative numeric weights, at most one auto, weight sum > 0
  const nameBad = rows.some(r => !String(r.name_ar).trim());
  const weightBad = rows.some(r => !(Number.isFinite(+r.weight) && +r.weight >= 0));
  const autoBad = rows.filter(r => r.auto).length > 1;
  const sumZero = pv.totalW <= 0;
  const invalid = !rows.length || nameBad || weightBad || autoBad || sumZero;
  const problem = nameBad ? 'pp_err_name_required' : weightBad ? 'pp_err_weight' : autoBad ? 'pp_err_one_auto' : sumZero ? 'pp_err_sum_zero' : null;

  const save = async () => {
    setBusy(true); setErr(null);
    const phases = rows.map(r => ({ key: r.key, name_ar: String(r.name_ar).trim(), name_en: String(r.name_en || '').trim(),
      icon: r.icon || '', weight: +r.weight, pct: r.auto ? 0 : +r.pct, auto: !!r.auto }));
    try { await api.put('/tracker/project-phases', { phases }); toast(t('saved')); dirty.current = false; reload(); }
    catch (e) { setErr(e); }
    setBusy(false);
  };

  return (
    <div className="pp-section">
      <p className="muted small mb">{t('pp_intro')}</p>
      {err && <Alert>{errText(err)}</Alert>}
      {problem && <Alert kind="orange">{t(problem)}</Alert>}

      <Card title={t('pp_title')} actions={
        <div className="row gap wrap" style={{ alignItems: 'center' }}>
          <span className="muted small">{t('pp_total_weight')} <b className="num">{pc(pv.totalW)}</b> · {t('pp_overall')} <b className="num" style={{ color: pctTone(pv.pct).text }}>{pc(pv.pct)}%</b> · {t('pp_system_pct')} <b className="num">{pc(systemPct)}%</b></span>
          <button className="btn btn-default btn-sm" onClick={add}><Icon name="plus" size={14} /> {t('pp_add_phase')}</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={busy || invalid}>{busy ? t('saving') : t('save')}</button>
        </div>}>
        <div className="table-wrap">
          <table className="table pp-table">
            <thead>
              <tr>
                <th className="pp-ord" />
                <th>{t('pp_name_ar')}</th>
                <th>{t('pp_name_en')}</th>
                <th className="pp-icon-col">{t('pp_icon')}</th>
                <th className="num-col">{t('pp_weight')}</th>
                <th className="num-col">{t('pp_pct')}</th>
                <th>{t('pp_auto')}</th>
                <th className="num-col">{t('pp_contribution')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const p = pv.phases[i];
                return (
                  <tr key={r.key}>
                    <td className="pp-ord">
                      <button className="btn-icon btn-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('pp_move_up')}><Icon name="chevron" size={13} className="rot-up" /></button>
                      <button className="btn-icon btn-xs" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={t('pp_move_down')}><Icon name="chevron" size={13} /></button>
                    </td>
                    <td><input className="input input-sm" value={r.name_ar} onChange={e => edit(i, { name_ar: e.target.value })} aria-label={t('pp_name_ar')} maxLength={120} /></td>
                    <td><input className="input input-sm" value={r.name_en} onChange={e => edit(i, { name_en: e.target.value })} aria-label={t('pp_name_en')} maxLength={120} dir="ltr" /></td>
                    <td className="pp-icon-col"><IconPicker value={r.icon} onChange={v => edit(i, { icon: v })} label={t('pp_icon')} /></td>
                    <td className="num-col"><input className="input input-sm num-input" type="number" min={0} max={100000} step={0.5} value={r.weight} onChange={e => edit(i, { weight: e.target.value })} aria-label={t('pp_weight')} /></td>
                    <td className="num-col">
                      <input className="input input-sm num-input" type="number" min={0} max={100} step={1} value={r.auto ? Math.round(systemPct * 10) / 10 : r.pct}
                        onChange={e => edit(i, { pct: e.target.value })} disabled={r.auto} aria-label={t('pp_pct')} />
                    </td>
                    <td><label className="pp-auto"><input type="checkbox" checked={!!r.auto} onChange={e => setAuto(i, e.target.checked)} /> <span className="muted small">{r.auto ? t('proj_auto_note') : ''}</span></label></td>
                    <td className="num-col num" style={{ color: pctTone(p.effective_pct).text }}>{pc(p.contribution)}%</td>
                    <td><button className="btn-icon btn-xs" onClick={() => del(i)} aria-label={t('pp_delete_phase')}><Icon name="trash" size={14} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
