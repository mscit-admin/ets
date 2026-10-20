import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { pc } from '../lib/format.js';
import { Alert, Card, ErrorBox, Field, Loading, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { useLiveUpdates } from '../lib/live.js';

export default function Weights() {
  const { t, nm, errText } = useI18n();
  const { can, user, readonly } = useAuth();
  const { data, error, loading, reload, refresh } = useLoad(o => api.get('/tracker/weights', o), []);
  const [w, setW] = useState({});
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useLiveUpdates(refresh);

  // New data from the server (first load, save, or a live update by another user): a field the user has changed
  // and not saved yet keeps the typed value; every other field takes the server's value.
  const server = useRef(null);
  useEffect(() => {
    if (!data) return;
    const prev = server.current;
    const nextW = Object.fromEntries(data.applications.map(a => [a.id, a.weight]));
    setW(cur => (prev ? Object.fromEntries(Object.entries(nextW).map(([id, v]) =>
      [id, id in cur && String(cur[id]) !== String(prev.w[id]) ? cur[id] : v])) : nextW));
    setS(cur => (prev && cur ? Object.fromEntries(Object.entries(data.settings).map(([k, v]) =>
      [k, cur[k] !== prev.s[k] ? cur[k] : v])) : data.settings));
    server.current = { w: nextW, s: data.settings };
  }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const editable = can('wgt');
  const global = editable && user.fullScope;
  const auto = s?.weight_mode === 'auto';
  const total = data.applications.reduce((acc, a) => acc + (auto ? a.fnWeight : +w[a.id] || 0), 0);

  const save = async () => {
    setBusy(true); setErr(null);
    const changed = Object.fromEntries(data.applications.filter(a => +w[a.id] !== a.weight).map(a => [a.id, +w[a.id]]));
    const body = { weights: changed };
    if (global) Object.assign(body, s);
    try { await api.put('/tracker/weights', body); toast(t('saved')); reload(); } catch (e) { setErr(e); }
    setBusy(false);
  };
  const reset = async () => {
    if (!window.confirm(t('are_you_sure'))) return;
    try { await api.post('/tracker/weights/reset'); toast(t('saved')); reload(); } catch (e) { toast(errText(e), 'red'); }
  };

  return (
    <div>
      <PageHeader title={t('weights_title')} icon="scale">
        <ExportButton report="weights" />
        {global && <button className="btn btn-default btn-sm" onClick={reset}>{t('reset_defaults')}</button>}
        {editable && <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? t('saving') : t('save')}</button>}
      </PageHeader>
      {err && <Alert>{errText(err)}</Alert>}
      {s && (
        <Card title={t('sec_calc')}>
          <div className="form-grid">
            <Field label={t('weight_mode')}>
              <select className="input" value={s.weight_mode} disabled={!global} onChange={e => setS({ ...s, weight_mode: e.target.value })}>
                <option value="fixed">{t('weight_mode_fixed')}</option>
                <option value="auto">{t('weight_mode_auto')}</option>
              </select>
            </Field>
            <Field label={`${t('notif_share')} (${Math.round(s.notif_share * 100)}%)`}>
              <input type="range" min={0} max={50} step={5} value={Math.round(s.notif_share * 100)} disabled={!global}
                onChange={e => setS({ ...s, notif_share: +e.target.value / 100 })} />
            </Field>
            <Field label={`${t('reports_share')} (${Math.round(s.reports_share * 100)}%)`}>
              <input type="range" min={0} max={50} step={5} value={Math.round(s.reports_share * 100)} disabled={!global}
                onChange={e => setS({ ...s, reports_share: +e.target.value / 100 })} />
            </Field>
          </div>
        </Card>
      )}
      {data.departments.map(d => {
        const apps = data.applications.filter(a => a.department_id === d.id);
        const dw = apps.reduce((acc, a) => acc + (auto ? a.fnWeight : +w[a.id] || 0), 0);
        return (
          <Card key={d.id} title={nm(d)} actions={<span className="muted small">{t('weight')} <b className="num">{pc(dw)}</b> · <b className="num">{pc(total ? (dw / total) * 100 : 0)}%</b></span>}>
            {/* phones: the table scrolls inside its card, never the page; the two reference columns are left out */}
            <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('application')}</th><th className="num-col hide-mobile">{t('default_weight')}</th><th className="num-col hide-mobile">{t('fn_weight_sum')}</th><th className="num-col">{t('weight')}</th><th className="num-col">{t('share')}</th></tr></thead>
              <tbody>
                {apps.map(a => {
                  const val = auto ? a.fnWeight : +w[a.id] || 0;
                  return (
                    <tr key={a.id}>
                      <td>{nm(a)}</td>
                      <td className="num-col num muted hide-mobile">{pc(a.default_weight)}</td>
                      <td className="num-col num muted hide-mobile">{pc(a.fnWeight)}</td>
                      <td className="num-col">
                        {/* read-only session (the Android app, 1.11.0): the value as text */}
                        {readonly ? <b className="num">{pc(val)}</b> : (
                        <input className="input input-sm num-input" type="number" min={0} max={1000} step={0.5} value={w[a.id] ?? ''}
                          disabled={!editable || auto} aria-label={t('weight')} onChange={e => setW({ ...w, [a.id]: e.target.value })} />)}
                      </td>
                      <td className="num-col num">{pc(total ? (val / total) * 100 : 0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
