import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, downloadText } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, ErrorBox, Field, Loading, PageHeader, toast, useLoad } from '../components/ui.jsx';

export default function Settings() {
  const { t, errText, fmtDate } = useI18n();
  const { can, refresh } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get('/settings'), []);
  const info = useLoad(() => api.get('/system/info'), []);
  const [s, setS] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => { if (data) setS(data.settings); }, [data]);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!s) return null;

  const set = (k, v) => setS({ ...s, [k]: v });
  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.put('/settings', s); toast(t('saved')); reload(); refresh(); } catch (e) { setErr(e); }
    setBusy(false);
  };
  const exportData = async () => {
    try { const d = await api.get('/tracker/export'); downloadText(`ets-export-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(d, null, 1), 'application/json'); }
    catch (e) { toast(errText(e), 'red'); }
  };
  const importFile = async file => {
    if (!file || !window.confirm(t('are_you_sure'))) return;
    try {
      const r = await api.post('/tracker/import', { content: await file.text() });
      toast(t('import_done', { n: r.counts.functions }));
    } catch (e) { toast(errText(e), 'red'); }
    if (fileRef.current) fileRef.current.value = '';
  };
  const num = (k, min, max) => (
    <input className="input" type="number" min={min} max={max} value={s[k]} onChange={e => set(k, parseInt(e.target.value, 10) || 0)} />
  );

  return (
    <div>
      <PageHeader title={t('settings_title')} icon="settings">
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? t('saving') : t('save')}</button>
      </PageHeader>
      {err && <Alert>{errText(err)}</Alert>}

      <Card title={t('sec_2fa')}>
        <div className="radio-list">
          {['off', 'optional', 'required'].map(m => (
            <label key={m} className={'role-opt' + (s['mfa.mode'] === m ? ' on' : '')}>
              <input type="radio" name="mfa" checked={s['mfa.mode'] === m} onChange={() => set('mfa.mode', m)} />
              <b>{t('mfa_' + m)}</b>
            </label>
          ))}
        </div>
        <div className="form-grid mt">
          <Field label={t('mfa_issuer')}><input className="input" dir="ltr" value={s['mfa.issuer']} onChange={e => set('mfa.issuer', e.target.value)} /></Field>
        </div>
      </Card>

      <Card title={t('sec_general')}>
        <div className="form-grid">
          <Field label={t('org_name_ar')}><input className="input" value={s['app.org_name_ar']} onChange={e => set('app.org_name_ar', e.target.value)} /></Field>
          <Field label={t('org_name_en')}><input className="input" dir="ltr" value={s['app.org_name_en']} onChange={e => set('app.org_name_en', e.target.value)} /></Field>
          <Field label={t('default_language')}>
            <select className="input" value={s['app.default_language']} onChange={e => set('app.default_language', e.target.value)}><option value="ar">العربية</option><option value="en">English</option></select>
          </Field>
        </div>
      </Card>

      <Card title={t('sec_security')}>
        <div className="form-grid">
          <Field label={t('password_min_length')}>{num('security.password_min_length', 8, 64)}</Field>
        </div>
      </Card>

      <Card title={t('sec_logs')}>
        <div className="form-grid">
          <Field label={t('retention_days')}>{num('logs.retention_days', 30, 3650)}</Field>
          <Field label={t('access_retention_days')}>{num('logs.access_retention_days', 7, 3650)}</Field>
        </div>
      </Card>

      <Card title={t('sec_data')}>
        <div className="row gap wrap">
          {can('exp') && <button className="btn btn-default btn-sm" onClick={exportData}><Icon name="download" size={14} /> {t('export_data')}</button>}
          {can('imp') && (
            <label className="btn btn-default btn-sm">
              <Icon name="upload" size={14} /> {t('import_data')}
              <input ref={fileRef} type="file" accept=".html,.htm,.json" hidden onChange={e => importFile(e.target.files[0])} />
            </label>
          )}
        </div>
      </Card>

      {info.data && (
        <Card title={t('sec_system')}>
          <div className="kv">
            <div><span>{t('version')}</span><span className="num">{info.data.app_version} · Node {info.data.node}</span></div>
            <div><span>PostgreSQL</span><span className="small" dir="ltr">{info.data.database.version.split(' on ')[0]}</span></div>
            <div><span>{t('db_size')}</span><span dir="ltr">{info.data.database.size} · {info.data.database.migration}</span></div>
            <div><span>{t('uptime')}</span><span>{fmtDate(info.data.started_at)} ({Math.round(info.data.uptime_s / 3600)} h)</span></div>
          </div>
        </Card>
      )}
    </div>
  );
}
