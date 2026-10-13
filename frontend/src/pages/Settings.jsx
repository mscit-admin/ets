import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, downloadText } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, ErrorBox, Field, Loading, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { useBranding } from '../lib/branding.jsx';
import { addPeriods } from '../components/SCurve.jsx';

export default function Settings() {
  const { t, errText, fmtDate } = useI18n();
  const { can, refresh } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.get('/settings'), []);
  const info = useLoad(() => api.get('/system/info'), []);
  const sched = useLoad(() => api.get('/tracker/schedule'), []);
  const [tl, setTl] = useState(null);
  useEffect(() => { if (sched.data) setTl({ start_date: sched.data.start_date || '', end_date: sched.data.end_date || '' }); }, [sched.data]);
  useEffect(() => { if (tl && window.location.hash === '#timeline') document.getElementById('timeline')?.scrollIntoView(); }, [!!tl]); // eslint-disable-line react-hooks/exhaustive-deps
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
    // logo sizes are saved by their own sliders (Branding card), not by this button
    const { 'app.logo_height': _lh, 'app.login_logo_height': _llh, ...rest } = s;
    try {
      await api.put('/settings', rest);
      if (tl && sched.data?.can.timeline && (tl.start_date !== (sched.data.start_date || '') || tl.end_date !== (sched.data.end_date || ''))) {
        await api.put('/tracker/timeline', { start_date: tl.start_date || null, end_date: tl.end_date || null });
        sched.reload();
      }
      toast(t('saved')); reload(); refresh();
    } catch (e) { setErr(e); }
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

      {tl && sched.data?.can.timeline && <TimelineCard tl={tl} setTl={setTl} unit={sched.data.unit} />}

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

      <Card title={t('sec_approvals')}>
        <label className="check"><input type="checkbox" checked={!!s['approval.edits_need_lead']}
          onChange={e => set('approval.edits_need_lead', e.target.checked)} /> {t('edits_need_lead')}</label>
        <div className="field-hint mt-s">{t('edits_need_lead_hint')}</div>
      </Card>

      <BrandingCard />

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
              <Icon name="upload" size={14} /> {t('import_data_full')}
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

// Settings → Branding: logo (navbar + login), favicon (browser tab), login background.
function BrandingCard() {
  const { t, errText } = useI18n();
  const b = useBranding();
  const slots = [
    { key: 'logo', label: t('brand_logo'), hint: t('brand_logo_hint'), preview: b.custom.logo ? b.logo : '/favicon.svg', cls: 'pv-logo' },
    { key: 'favicon', label: t('brand_favicon'), hint: t('brand_favicon_hint'), preview: b.custom.favicon ? `/api/branding/favicon?v=${b.versions.favicon}` : null, cls: 'pv-fav' },
    { key: 'login_bg', label: t('brand_login_bg'), hint: t('brand_login_bg_hint'), preview: b.loginBg, cls: 'pv-bg' },
  ];
  const upload = async (key, file) => {
    if (!file) return;
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    try { await api.put('/branding/' + key, { data }); toast(t('saved')); b.reload(); } catch (e) { toast(errText(e), 'red'); }
  };
  // logo size: applied live while dragging, saved when released
  const [h, setH] = useState(null);
  const cur = { logo: h?.logo ?? b.logoHeight, login: h?.login ?? b.loginLogoHeight };
  const preview = v => {
    document.documentElement.style.setProperty('--logo-h', v + 'px');
    document.documentElement.style.setProperty('--navbar-h', Math.max(52, v + 20) + 'px');
  };
  const saveSize = async (key, v) => {
    try { await api.put('/settings', { [key]: v }); toast(t('saved')); b.reload(); } catch (e) { toast(errText(e), 'red'); }
  };
  const reset = async key => {
    if (!window.confirm(t('are_you_sure'))) return;
    try { await api.del('/branding/' + key); toast(t('saved')); b.reload(); } catch (e) { toast(errText(e), 'red'); }
  };
  return (
    <Card title={t('sec_branding')}>
      <div className="brand-grid">
        {slots.map(s => (
          <div key={s.key} className="brand-slot">
            <div className="field-label">{s.label}</div>
            <div className={'brand-preview ' + s.cls}>
              {s.preview ? <img src={s.preview} alt="" /> : <span className="muted small">{t('brand_default')}</span>}
            </div>
            <div className="field-hint">{s.hint}</div>
            <div className="row gap wrap">
              <label className="btn btn-default btn-sm">
                <Icon name="upload" size={14} /> {t('brand_upload')}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon,.ico" hidden onChange={e => { upload(s.key, e.target.files[0]); e.target.value = ''; }} />
              </label>
              {b.custom[s.key] && <button className="btn btn-default btn-sm" onClick={() => reset(s.key)}>{t('brand_reset')}</button>}
            </div>
          </div>
        ))}
      </div>
      <div className="form-grid mt">
        <Field label={`${t('brand_logo_size')} — ${cur.logo}px`}>
          <div className="size-row">
            <input type="range" min={20} max={80} step={2} value={cur.logo}
              onChange={e => { const v = +e.target.value; setH({ ...h, logo: v }); preview(v); }}
              onMouseUp={e => saveSize('app.logo_height', +e.target.value)} onTouchEnd={e => saveSize('app.logo_height', +e.target.value)}
              onKeyUp={e => saveSize('app.logo_height', +e.target.value)} />
            <img src={b.logo} alt="" style={{ height: cur.logo, width: 'auto', maxWidth: 200 }} />
          </div>
        </Field>
        <Field label={`${t('brand_login_logo_size')} — ${cur.login}px`}>
          <div className="size-row">
            <input type="range" min={40} max={200} step={4} value={cur.login}
              onChange={e => setH({ ...h, login: +e.target.value })}
              onMouseUp={e => saveSize('app.login_logo_height', +e.target.value)} onTouchEnd={e => saveSize('app.login_logo_height', +e.target.value)}
              onKeyUp={e => saveSize('app.login_logo_height', +e.target.value)} />
            <img src={b.logo} alt="" style={{ height: Math.min(cur.login, 120), width: 'auto', maxWidth: 240 }} />
          </div>
        </Field>
      </div>
    </Card>
  );
}

// Settings → project timeline: start and planned close date (saved with the page's Save button).
function TimelineCard({ tl, setTl, unit }) {
  const { t, fmtDay } = useI18n();
  const ok = tl.start_date && tl.end_date && tl.end_date > tl.start_date;
  const days = ok ? Math.round((new Date(tl.end_date) - new Date(tl.start_date)) / 864e5) : null;
  let periods = null;
  if (ok) { periods = 1; while (addPeriods(tl.start_date, unit, periods) < new Date(tl.end_date + 'T00:00:00') && periods <= 61) periods++; }
  return (
    <section id="timeline">
      <Card title={t('sec_timeline')}>
        <div className="form-grid">
          <Field label={t('project_start')}><input className="input" type="date" value={tl.start_date} onChange={e => setTl({ ...tl, start_date: e.target.value })} /></Field>
          <Field label={t('project_end')}><input className="input" type="date" min={tl.start_date || undefined} value={tl.end_date} onChange={e => setTl({ ...tl, end_date: e.target.value })} /></Field>
          <div className="field"><span className="field-label">{t('project_duration')}</span>
            <div className="field-static">{ok ? <>{t('n_days', { n: days })} · {t('n_periods', { n: periods })} ({t('unit_' + unit)}) · {fmtDay(tl.start_date)} – {fmtDay(tl.end_date)}</>
              : tl.start_date && tl.end_date ? <span className="text-red">{t('err_end_before_start')}</span> : '—'}</div>
          </div>
        </div>
        <div className="field-hint mt-s">{t('timeline_hint')}</div>
      </Card>
    </section>
  );
}
