import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { REPORT_COLORS } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { Card, ErrorBox, Indicator, Loading, Modal, NumberCard, PageHeader, Pct, ProgressBar, toast, useLoad } from '../components/ui.jsx';

export default function Reports() {
  const { t, nm, errText } = useI18n();
  const { dept } = useParams();
  const { data, error, loading, reload } = useLoad(() => api.get('/tracker/reports'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { can, settings } = data;
  // /reports/:dept shows one department's reports (opened from that department's sub-list in the sidebar)
  const departments = dept ? data.departments.filter(d => d.id === dept) : data.departments;
  const applications = dept ? data.applications.filter(a => a.department_id === dept) : data.applications;

  let sw = 0, sp = 0;
  applications.forEach(a => { sw += a.weight; sp += a.weight * (a.report?.progress || 0); });
  const counts = [0, 0, 0, 0];
  applications.forEach(a => { counts[a.report?.status || 0]++; });

  const save = async (a, body) => {
    try { await api.patch('/tracker/reports/' + a.id, body); toast(t('saved')); setEdit(null); reload(); }
    catch (e) { toast(errText(e), 'red'); }
  };

  return (
    <div>
      {dept && departments[0] && (
        <div className="breadcrumb"><Link to={'/department/' + dept}>{nm(departments[0], 'short')}</Link><Icon name="chevron" size={12} className="flip" /><span>{t('reports_title')}</span></div>
      )}
      <PageHeader title={dept && departments[0] ? `${t('reports_title')} — ${nm(departments[0], 'short')}` : t('reports_title')}
        sub={t('reports_sub')} icon="report" />
      <div className="grid-cards">
        <NumberCard label={t('report_progress')} value={<Pct value={sw ? sp / sw : 0} />} sub={<>{t('reports_share')}: <span className="num">{Math.round(settings.reports_share * 100)}%</span></>} />
        {[1, 2, 3].map(i => <NumberCard key={i} label={t('rs_' + i)} value={counts[i]} color={REPORT_COLORS[i]} />)}
      </div>
      {departments.map(d => (
        <Card key={d.id} title={nm(d)}>
          <table className="table">
            <thead><tr><th>{t('application')}</th><th>{t('report_status')}</th><th className="w-30">{t('progress')}</th><th className="num-col">%</th><th>{t('note')}</th>{can.rep && <th />}</tr></thead>
            <tbody>
              {applications.filter(a => a.department_id === d.id).map(a => {
                const r = a.report || { progress: 0, status: 0, note: '' };
                return (
                  <tr key={a.id}>
                    <td><Link to={'/app/' + a.id} className="link-row"><Icon name={a.icon} size={15} /> {nm(a)}</Link></td>
                    <td><Indicator color={REPORT_COLORS[r.status]}>{t('rs_' + r.status)}</Indicator></td>
                    <td><ProgressBar value={r.progress} /></td>
                    <td className="num-col"><Pct value={r.progress} /></td>
                    <td className="muted small ellipsis" title={r.note}>{r.note}</td>
                    {can.rep && <td className="end"><button className="btn btn-default btn-xs" onClick={() => setEdit(a)}>{t('edit')}</button></td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ))}
      {edit && <ReportModal a={edit} onClose={() => setEdit(null)} onSave={b => save(edit, b)} />}
    </div>
  );
}

function ReportModal({ a, onClose, onSave }) {
  const { t, nm } = useI18n();
  const r = a.report || { progress: 0, status: 0, note: '' };
  const [f, setF] = useState({ progress: r.progress, status: r.status, note: r.note });
  return (
    <Modal title={nm(a)} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={() => onSave({ progress: +f.progress, status: +f.status, note: f.note })}>{t('save')}</button></>}>
      <label className="field"><span className="field-label">{t('progress')} %</span>
        <input className="input" type="number" min={0} max={100} value={f.progress} onChange={e => setF({ ...f, progress: e.target.value })} /></label>
      <label className="field"><span className="field-label">{t('report_status')}</span>
        <select className="input" value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{[0, 1, 2, 3].map(i => <option key={i} value={i}>{t('rs_' + i)}</option>)}</select></label>
      <label className="field"><span className="field-label">{t('note')}</span>
        <textarea className="input" rows={4} maxLength={2000} value={f.note} onChange={e => setF({ ...f, note: e.target.value })} /></label>
    </Modal>
  );
}
