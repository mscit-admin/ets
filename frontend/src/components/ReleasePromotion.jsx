// Settings → «الترقية والنشر» / "Release & deploy" (1.12.18, PHASE 1) — system administrators only (cfg + the admin
// role; the API refuses everyone else). The administrator picks a released version proven on the test server and
// records a promotion REQUEST to production, re-authenticating with the password + OTP (the same re-auth as the backup
// restore / escrow flow). Nothing here deploys: in Phase 1 the API only stores a signed promotion intent — the real
// root agents (ets-release-publisher / ets-deploy-agent) that push, pull, back up, check out and health-gate are
// wired in Phase 2. This page shows the current production / test state, the what-changed preview, and the history.
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Alert, Card, Field, Indicator, Loading, toast, useLoad } from './ui.jsx';
import { ReauthModal } from './BackupCenter.jsx';

const STATUS_COLOR = { requested: 'gray', publishing: 'blue', deploying: 'blue', succeeded: 'green', failed: 'red', rolled_back: 'orange', cancelled: 'gray' };
const shortCommit = c => (c ? String(c).slice(0, 10) : '—');

export function ReleaseSection() {
  const { t, fmtDate, errText } = useI18n();
  const { data, error, reload } = useLoad(() => api.get('/release/versions'), []);
  const status = useLoad(() => api.get('/release/status'), []);
  const history = useLoad(() => api.get('/release/history'), []);
  const [picked, setPicked] = useState('');
  const [autoRollback, setAutoRollback] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [ask, setAsk] = useState(false);

  const promotable = useMemo(() => (data?.versions || []).filter(v => v.promotable), [data]);
  useEffect(() => { if (promotable.length && !picked) setPicked(promotable[0].version); }, [promotable, picked]);
  const selected = useMemo(() => (data?.versions || []).find(v => v.version === picked) || null, [data, picked]);

  if (error) return <Alert>{errText(error)}</Alert>;
  if (!data) return <Loading />;

  const prod = data.production || {};
  const inFlight = status.data?.in_flight;
  const canPromote = !!selected && selected.promotable && data.signing_ready && !inFlight;

  const reloadAll = () => { reload(); status.reload(); history.reload(); };

  const promote = async creds => {
    await api.post('/release/promote', { version: picked, confirm, auto_rollback: autoRollback, ...creds });
    setAsk(false); setConfirm('');
    toast(t('rel_promoted', { version: picked }));
    reloadAll();
  };

  const StatusBadge = ({ s }) => <Indicator color={STATUS_COLOR[s] || 'gray'}>{t('rel_status_' + s)}</Indicator>;

  return (
    <>
      <Card title={t('rel_title')}>
        <Alert kind="blue">{t('rel_phase1_note')}</Alert>

        {/* current state banner */}
        <div className="form-grid mt-s">
          <Field label={t('rel_prod_running')}>
            <div dir="auto">
              {prod.version ? <><b>{prod.version}</b> <span className="muted small ltr">({shortCommit(prod.commit)})</span>
                {prod.deployed_at && <span className="muted small"> · {fmtDate(prod.deployed_at)}</span>}</> : <span className="muted">{t('rel_prod_unknown')}</span>}
              {prod.stale && <div className="muted small">{t('rel_stale')}</div>}
            </div>
          </Field>
          <Field label={t('rel_test_version')}>
            <div dir="auto"><b>{data.test?.version}</b> <span className="muted small ltr">({shortCommit(data.test?.resolved)})</span></div>
          </Field>
        </div>

        {!data.signing_ready && <Alert>{t('rel_signing_unavailable')}</Alert>}

        {/* version picker + what-changed */}
        {promotable.length === 0 ? <p className="muted mt-s">{t('rel_no_versions')}</p> : <>
          <Field label={t('rel_pick_version')} className="mt-s">
            <select className="input" value={picked} onChange={e => { setPicked(e.target.value); setConfirm(''); }}>
              {promotable.map(v => <option key={v.version} value={v.version}>{v.version}{v.date ? ` — ${v.date}` : ''}{v.title ? ` — ${v.title}` : ''}</option>)}
            </select>
          </Field>

          {selected && <Field label={t('rel_what_changed')}>
            <pre className="changelog-preview" dir="auto" style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', margin: 0 }}>{selected.summary || '—'}</pre>
          </Field>}

          <Field label={t('rel_auto_rollback')} hint={t('rel_auto_rollback_hint')}>
            <label className="row gap"><input type="checkbox" checked={autoRollback} onChange={e => setAutoRollback(e.target.checked)} /> {t('rel_auto_rollback')}</label>
          </Field>

          <div className="row gap mt-s wrap">
            <button className="btn btn-primary" disabled={!canPromote} onClick={() => setAsk(true)}>{t('rel_promote')}</button>
            {inFlight && <span className="muted small">{t('rel_in_flight')}</span>}
          </div>
        </>}
      </Card>

      {/* current promotion */}
      <Card title={t('rel_status')}>
        {status.data?.current ? (() => {
          const c = status.data.current;
          return <div className="job-status">
            <div className="row gap wrap"><StatusBadge s={c.status} />
              <span className="muted small" dir="auto">{c.intent === 'rollback' ? '↩ ' : ''}{c.version} <span className="ltr">({shortCommit(c.commit)})</span>
                {c.by_name ? ' · ' + c.by_name : ''}{c.authorized_at ? ' · ' + fmtDate(c.authorized_at) : ''}</span>
            </div>
            <div className="muted small mt-s">{t('rel_signer')}: <span className="ltr">{c.signer || '—'}</span>{c.prev_version ? ` · ${t('rel_prev')}: ${c.prev_version}` : ''}</div>
            {c.error && <Alert>{c.error}</Alert>}
          </div>;
        })() : <p className="muted">{t('rel_none')}</p>}
      </Card>

      {/* history */}
      <Card title={t('rel_history')}>
        {(history.data?.promotions || []).length === 0 ? <p className="muted">{t('rel_none')}</p> : (
          <table className="table">
            <thead><tr><th>{t('rel_col_version')}</th><th>{t('rel_col_by')}</th><th>{t('rel_col_when')}</th><th>{t('rel_col_status')}</th></tr></thead>
            <tbody>
              {history.data.promotions.map(p => (
                <tr key={p.id}>
                  <td dir="auto">{p.intent === 'rollback' ? '↩ ' : ''}{p.version} <span className="muted small ltr">({shortCommit(p.commit)})</span></td>
                  <td dir="auto">{p.by_name || '—'}</td>
                  <td className="muted small">{fmtDate(p.authorized_at || p.created_at)}</td>
                  <td><StatusBadge s={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {ask && <ReauthModal hint={t('rel_promote_hint', { version: picked })} confirmLabel={t('rel_promote')} onClose={() => setAsk(false)} onConfirm={promote}>
        <Field label={t('rel_confirm_version', { version: picked })}>
          <input className="input ltr" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={picked} />
        </Field>
      </ReauthModal>}
    </>
  );
}
