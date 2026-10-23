// Settings → «الترقية والنشر» / "Release & deploy" (1.12.20, PHASE 3 — feature-complete) — system administrators only
// (cfg + the admin role; the API refuses everyone else). The administrator picks a released version proven on the test
// server and records a promotion REQUEST to production, re-authenticating with the password + OTP (the same re-auth as
// the backup restore / escrow flow). The API only records a signed promotion intent; the root agents (ets-release-
// publisher / ets-deploy-agent) push, pull, back up, check out, health-gate and report back — their live setup is
// OPERATOR-VERIFIED (docs/handover/13 §8a). This page shows the current production / test state with an agent
// freshness warning, the what-changed preview, a one-click rollback, a DB-restore guidance panel when a failed deploy
// needs a manual restore (§5.3), and an expandable promotion history.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Alert, Card, Field, Indicator, Loading, toast, useLoad } from './ui.jsx';
import { ReauthModal } from './BackupCenter.jsx';

const STATUS_COLOR = { requested: 'gray', publishing: 'blue', deploying: 'blue', succeeded: 'green', failed: 'red', rolled_back: 'orange', cancelled: 'gray' };
// The lifecycle phases shown as a progression; the final cell becomes succeeded / failed / rolled_back.
const PHASES = ['requested', 'publishing', 'deploying'];
const shortCommit = c => (c ? String(c).slice(0, 10) : '—');
// Does this promotion's recorded result ask for a manual DB restore (§5.3)?
const needsDbRestore = p => !!(p && (p.result?.needs_db_restore || p.status === 'failed' && p.result?.rollback_action === 'stop_needs_db_restore'));
const restoreCommand = p => p?.result?.restore_command || (p?.backup_ref ? `ets-restore ${p.backup_ref}` : 'ets-restore <backup_ref>');

export function ReleaseSection() {
  const { t, fmtDate, errText } = useI18n();
  const { data, error, reload } = useLoad(() => api.get('/release/versions'), []);
  const status = useLoad(() => api.get('/release/status'), []);
  const history = useLoad(() => api.get('/release/history'), []);
  const [picked, setPicked] = useState('');
  const [autoRollback, setAutoRollback] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [ask, setAsk] = useState(null);     // null | 'promote' | 'rollback'
  const [open, setOpen] = useState(null);    // expanded history row id

  const promotable = useMemo(() => (data?.versions || []).filter(v => v.promotable), [data]);
  useEffect(() => { if (promotable.length && !picked) setPicked(promotable[0].version); }, [promotable, picked]);
  const selected = useMemo(() => (data?.versions || []).find(v => v.version === picked) || null, [data, picked]);

  if (error) return <Alert>{errText(error)}</Alert>;
  if (!data) return <Loading />;

  const prod = status.data?.production || data.production || {};
  const agent = status.data?.agent || {};
  const cur = status.data?.current || null;
  const inFlight = status.data?.in_flight;
  const canPromote = !!selected && selected.promotable && data.signing_ready && !inFlight;
  // rollback is offered when the last promotion failed (break-glass) and production has a known previous version
  const canRollback = !!cur && cur.status === 'failed' && !inFlight && data.signing_ready && !!prod.version;
  const confirmTarget = ask === 'rollback' ? (cur?.prev_version || '') : picked;

  const reloadAll = () => { reload(); status.reload(); history.reload(); };

  const submit = async creds => {
    const path = ask === 'rollback' ? '/release/rollback' : '/release/promote';
    const version = ask === 'rollback' ? cur.prev_version : picked;
    await api.post(path, { version, confirm, auto_rollback: autoRollback, ...creds });
    setAsk(null); setConfirm('');
    toast(t(ask === 'rollback' ? 'rel_rolled_back_toast' : 'rel_promoted', { version }));
    reloadAll();
  };

  const StatusBadge = ({ s }) => <Indicator color={STATUS_COLOR[s] || 'gray'}>{t('rel_status_' + s)}</Indicator>;

  // The phase progression for a promotion row: the ordered lifecycle with the reached / current / pending state.
  const PhaseTrail = ({ p }) => {
    const terminal = ['succeeded', 'failed', 'rolled_back'].includes(p.status);
    const reachedIdx = PHASES.indexOf(p.status);
    const cells = PHASES.map((ph, i) => ({ key: ph,
      state: terminal ? 'done' : i < reachedIdx ? 'done' : i === reachedIdx ? 'current' : 'pending' }));
    return (
      <ol className="phase-trail row gap wrap" style={{ listStyle: 'none', padding: 0, margin: '4px 0' }}>
        {cells.map(c => (
          <li key={c.key} className={`small ${c.state === 'current' ? '' : 'muted'}`} style={c.state === 'current' ? { fontWeight: 700 } : undefined}>
            {c.state === 'done' ? '●' : c.state === 'current' ? '◉' : '○'} {t('rel_status_' + c.key)}
          </li>
        ))}
        <li className="small"><StatusBadge s={p.status} /></li>
      </ol>
    );
  };

  // The per-row detail shown when a history row is expanded.
  const Detail = ({ p }) => {
    const r = p.result || {};
    const checks = Array.isArray(r.health_checks) ? r.health_checks : [];
    return (
      <div className="release-detail" style={{ padding: '8px 4px' }}>
        <PhaseTrail p={p} />
        <div className="form-grid">
          <Field label={t('rel_col_version')}><span dir="auto">{p.intent === 'rollback' ? '↩ ' : ''}{p.version} <span className="muted small ltr">({shortCommit(p.commit)})</span></span></Field>
          <Field label={t('rel_detail_authorized')}><span dir="auto">{p.by_name || '—'}{p.authorized_at ? ` · ${fmtDate(p.authorized_at)}` : ''}</span></Field>
          <Field label={t('rel_prev')}><span dir="auto">{p.prev_version || '—'} <span className="muted small ltr">({shortCommit(p.prev_commit)})</span></span></Field>
          <Field label={t('rel_signer')}><span className="ltr">{p.signer || '—'}</span></Field>
          <Field label={t('rel_detail_backup')}><span className="ltr small" dir="auto">{p.backup_ref || '—'}</span></Field>
          <Field label={t('rel_detail_finished')}><span className="muted small">{p.finished_at ? fmtDate(p.finished_at) : '—'}</span></Field>
        </div>
        {r.health_summary && <Field label={t('rel_detail_health')}><span dir="auto" className="small">{r.health_summary}</span></Field>}
        {checks.length > 0 && (
          <ul className="small" style={{ margin: '4px 0' }}>
            {checks.map((c, i) => <li key={i} dir="auto">{c.ok ? '✓' : '✗'} <span className="ltr">{c.name}</span>{c.detail ? ` — ${c.detail}` : ''}</li>)}
          </ul>
        )}
        {r.rollback_action && <div className="muted small" dir="auto">{t('rel_detail_action')}: {t('rel_action_' + r.rollback_action)}</div>}
        {needsDbRestore(p) && (
          <Alert kind="red">
            <b>{t('rel_db_restore_title')}</b>
            <p className="small">{t('rel_db_restore_body')}</p>
            <pre className="ltr" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{restoreCommand(p)}</pre>
            <p className="small muted">{t('rel_db_restore_runbook')}</p>
          </Alert>
        )}
        {p.error && <Alert>{p.error}</Alert>}
      </div>
    );
  };

  return (
    <>
      <Card title={t('rel_title')}>
        <Alert kind="blue">{t('rel_phase3_note')}</Alert>

        {/* current state banner: what production runs + the deploy-agent heartbeat freshness */}
        <div className="form-grid mt-s">
          <Field label={t('rel_prod_running')}>
            <div dir="auto">
              {prod.version ? <><b>{prod.version}</b> <span className="muted small ltr">({shortCommit(prod.commit)})</span>
                {prod.deployed_at && <span className="muted small"> · {fmtDate(prod.deployed_at)}</span>}</> : <span className="muted">{t('rel_prod_unknown')}</span>}
            </div>
            {agent.seen_at
              ? <div className={`small ${agent.ok ? 'muted' : 'red-text'}`}>{t('rel_agent_seen', { when: fmtDate(agent.seen_at) })}{!agent.ok && ` — ${t('rel_agent_stale')}`}</div>
              : <div className="small red-text">{t('rel_agent_never')}</div>}
            {prod.stale && prod.version && <div className="small red-text">{t('rel_stale')}</div>}
            {agent.apply_error && <div className="small red-text" dir="auto">{agent.apply_error}</div>}
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
            <button className="btn btn-primary" disabled={!canPromote} onClick={() => { setConfirm(''); setAsk('promote'); }}>{t('rel_promote')}</button>
            {inFlight && <span className="muted small">{t('rel_in_flight')}</span>}
          </div>
        </>}
      </Card>

      {/* current promotion + rollback */}
      <Card title={t('rel_status')}>
        {cur ? <div className="job-status">
          <div className="row gap wrap"><StatusBadge s={cur.status} />
            <span className="muted small" dir="auto">{cur.intent === 'rollback' ? '↩ ' : ''}{cur.version} <span className="ltr">({shortCommit(cur.commit)})</span>
              {cur.by_name ? ' · ' + cur.by_name : ''}{cur.authorized_at ? ' · ' + fmtDate(cur.authorized_at) : ''}</span>
          </div>
          <PhaseTrail p={cur} />
          <div className="muted small mt-s">{t('rel_signer')}: <span className="ltr">{cur.signer || '—'}</span>{cur.prev_version ? ` · ${t('rel_prev')}: ${cur.prev_version}` : ''}{cur.backup_ref ? ` · ${t('rel_detail_backup')}: ` : ''}<span className="ltr">{cur.backup_ref || ''}</span></div>
          {cur.result?.health_summary && <div className="muted small" dir="auto">{t('rel_detail_health')}: {cur.result.health_summary}</div>}
          {needsDbRestore(cur) && (
            <Alert kind="red">
              <b>{t('rel_db_restore_title')}</b>
              <p className="small">{t('rel_db_restore_body')}</p>
              <pre className="ltr" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}>{restoreCommand(cur)}</pre>
              <p className="small muted">{t('rel_db_restore_runbook')}</p>
            </Alert>
          )}
          {cur.error && <Alert>{cur.error}</Alert>}
          {canRollback && <div className="row gap mt-s wrap">
            <button className="btn" onClick={() => { setConfirm(''); setAsk('rollback'); }}>{t('rel_rollback')}</button>
            <span className="muted small">{t('rel_rollback_hint_short', { version: cur.prev_version || '—' })}</span>
          </div>}
        </div> : <p className="muted">{t('rel_none')}</p>}
      </Card>

      {/* history — expandable rows */}
      <Card title={t('rel_history')}>
        {(history.data?.promotions || []).length === 0 ? <p className="muted">{t('rel_none')}</p> : (
          <table className="table">
            <thead><tr><th style={{ width: 24 }} /><th>{t('rel_col_version')}</th><th>{t('rel_col_by')}</th><th>{t('rel_col_when')}</th><th>{t('rel_col_status')}</th><th>{t('rel_detail_backup')}</th></tr></thead>
            <tbody>
              {history.data.promotions.map(p => (
                <Fragment key={p.id}>
                  <tr className="clickable" onClick={() => setOpen(open === p.id ? null : p.id)} style={{ cursor: 'pointer' }}>
                    <td aria-hidden>{open === p.id ? '▾' : '▸'}</td>
                    <td dir="auto">{p.intent === 'rollback' ? '↩ ' : ''}{p.version} <span className="muted small ltr">({shortCommit(p.commit)})</span>{needsDbRestore(p) && <span className="red-text small"> ⚠</span>}</td>
                    <td dir="auto">{p.by_name || '—'}</td>
                    <td className="muted small">{fmtDate(p.finished_at || p.authorized_at || p.created_at)}</td>
                    <td><StatusBadge s={p.status} /></td>
                    <td className="ltr small" dir="auto">{p.backup_ref || '—'}</td>
                  </tr>
                  {open === p.id && <tr><td colSpan={6}><Detail p={p} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {ask && <ReauthModal
        hint={ask === 'rollback' ? t('rel_rollback_hint', { version: confirmTarget }) : t('rel_promote_hint', { version: confirmTarget })}
        confirmLabel={ask === 'rollback' ? t('rel_rollback') : t('rel_promote')} onClose={() => setAsk(null)} onConfirm={submit}>
        {ask === 'rollback' && <Alert kind="red">{t('rel_rollback_db_caveat')}</Alert>}
        <Field label={t('rel_confirm_version', { version: confirmTarget })}>
          <input className="input ltr" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={confirmTarget} />
        </Field>
      </ReauthModal>}
    </>
  );
}
