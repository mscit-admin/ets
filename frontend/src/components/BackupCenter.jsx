// Settings → «النسخ الاحتياطي» (1.12.0) — system administrators only (cfg + the admin role; the API refuses everyone
// else). Status, schedule and retention, destinations (SSH / NAS / cloud) with connection tests and the SSH key, the
// backup key / passphrase and its escrow, the backup files, «نسخ احتياطي الآن», «تحقق الآن» and the restore wizard.
// Nothing here runs as root: the API stores the settings and queues jobs, the backup agent on the server carries them
// out (backend/src/backup/agent.js); this page polls the jobs and shows their progress.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, downloadFile, postDownloadFile } from '../lib/api.js';
import { Icon } from './Icon.jsx';
import { Alert, Card, Field, Indicator, Loading, Modal, toast, useLoad } from './ui.jsx';
import { ProgressPanel, fmtBytes, useJob } from './ProgressPanel.jsx';
import { RestoreWizard } from './RestoreWizard.jsx';

const DESTS = ['ssh', 'nas', 'cloud'];
const KINDS = ['dump', 'config', 'logs'];
const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));
const tsLabel = (ts, fmtDate) => (ts ? fmtDate(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}`) : '—');

// Password (and 2FA code or recovery code) again — for destinations, credentials, the SSH key and the passphrase.
export function ReauthModal({ title, hint, children, onConfirm, onClose, confirmLabel }) {
  const { t, errText } = useI18n();
  const { user } = useAuth();
  const [pw, setPw] = useState(''), [code, setCode] = useState(''), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const needCode = !!user?.totp_enabled;
  const go = async () => {
    setBusy(true); setErr(null);
    const second = !needCode ? {} : /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
    try { await onConfirm({ password: pw, ...second }); } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={title || t(needCode ? 'confirm_with_password_code' : 'confirm_with_password')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={go} disabled={busy || !pw}>{confirmLabel || t('confirm')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      {hint && <p className="muted small">{hint}</p>}
      {children}
      <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
      {needCode && <Field label={t('code_or_recovery')}><input className="input otp" dir="ltr" autoComplete="one-time-code" value={code} placeholder="123456 / xxxx-xxxx-xxxx" onChange={e => setCode(e.target.value)} /></Field>}
    </Modal>
  );
}

function JobStatus({ job }) {
  const { t, fmtDate } = useI18n();
  if (!job) return null;
  const color = { queued: 'gray', running: 'blue', ok: 'green', failed: 'red', cancelled: 'gray' }[job.status];
  const snap = job.progress && { ...job.progress, state: job.status === 'failed' ? 'failed' : job.status === 'ok' ? 'done' : job.progress.state };
  return (
    <div className="job-status mt-s">
      <div className="row gap wrap">
        <Indicator color={color}>{t('bk_job_' + job.status)}</Indicator>
        <span className="muted small">{t('bk_kind_' + job.kind)} · #{job.id} · {fmtDate(job.requested_at)}{job.status === 'queued' ? ' · ' + t('bk_job_waiting_agent') : ''}</span>
      </div>
      {snap && <ProgressPanel snap={snap} compact />}
      {job.result?.error && <Alert>{t('bk_job_error', { error: job.result.error })}</Alert>}
      {job.kind === 'verify_now' && job.result?.details && <ul className="small mt-s">{job.result.details.map((d, i) => <li key={i} dir="auto">{d}</li>)}</ul>}
    </div>
  );
}

export function BackupSection() {
  const { t, fmtDate, lang, errText } = useI18n();
  const { data, error, reload } = useLoad(() => api.get('/backups'), []);
  const [cfg, setCfg] = useState(null);
  const [secrets, setSecrets] = useState({ cloud_access_key_id: '', cloud_secret_access_key: '' });
  const [ask, setAsk] = useState(null);           // reauth modal: { kind }
  const [jobs, setJobs] = useState({});           // kind/dest → job id
  const [testRes, setTestRes] = useState({});
  const [wizard, setWizard] = useState(false);
  const [escrowOk, setEscrowOk] = useState(false);
  const [pp, setPp] = useState({ a: '', b: '' });
  const [keyResult, setKeyResult] = useState(null);
  const restore = useLoad(() => api.get('/backups/restore/status'), []);
  useEffect(() => { if (data) setCfg(structuredClone(data.config)); }, [data]);
  // links of the backup alerts: /settings#backups
  useEffect(() => { if (data && window.location.hash === '#backups') document.getElementById('backups')?.scrollIntoView(); }, [!!data]);
  // the overview is refreshed while a job runs, and every 30 s otherwise
  useEffect(() => { const h = setInterval(() => reload(), 30000); return () => clearInterval(h); }, [reload]);
  const jobEnd = useCallback(() => reload(), [reload]);
  const backupJob = useJob(jobs.backup_now, jobEnd);
  const verifyJob = useJob(jobs.verify_now, jobEnd);
  const keyJob = useJob(jobs.generate_ssh_key, j => { if (j.status === 'ok') setKeyResult(j.result); reload(); });
  const ppJob = useJob(jobs.set_passphrase, jobEnd);
  const testSsh = useJob(jobs['test_ssh'], j => setTestRes(r => ({ ...r, ssh: j })));
  const testNas = useJob(jobs['test_nas'], j => setTestRes(r => ({ ...r, nas: j })));
  const testCloud = useJob(jobs['test_cloud'], j => setTestRes(r => ({ ...r, cloud: j })));
  const testJob = { ssh: testSsh, nas: testNas, cloud: testCloud };

  const dirty = useMemo(() => data && cfg && (canon(cfg) !== canon(data.config) || Object.values(secrets).some(Boolean)), [data, cfg, secrets]);
  if (error) return <Card title={t('bk_title')}><Alert>{errText(error)}</Alert></Card>;
  if (!data || !cfg) return <Card title={t('bk_title')}><Loading /></Card>;
  const st = data.status || {}, sum = data.summary || {};
  const set = (p, v) => setCfg(c => { const n = structuredClone(c); const k = p.split('.'); let o = n; for (const x of k.slice(0, -1)) o = o[x]; o[k.at(-1)] = v; return n; });
  const needReauth = DESTS.some(d => canon(cfg[d]) !== canon(data.config[d])) || Object.values(secrets).some(Boolean);
  const save = async (auth = {}) => {
    const body = { config: cfg, secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)), ...auth };
    await api.put('/backups/config', body);
    toast(t('saved')); setAsk(null); setSecrets({ cloud_access_key_id: '', cloud_secret_access_key: '' }); reload();
  };
  const trySave = async () => { if (needReauth) setAsk({ kind: 'save' }); else { try { await save(); } catch (e) { toast(errText(e), 'red'); } } };
  const startJob = async (kind, extra = {}, key = kind) => {
    try { const r = await api.post('/backups/jobs', { kind, ...extra }); setJobs(j => ({ ...j, [key]: r.job.id })); setAsk(null); }
    catch (e) { if (ask) throw e; toast(errText(e), 'red'); }
  };
  const num = (p, [lo, hi]) => (
    <input className="input" type="number" min={lo} max={hi} value={p.split('.').reduce((o, k) => o[k], cfg)} onChange={e => set(p, parseInt(e.target.value, 10) || 0)} />
  );
  const local = st.local || [];
  const lastLocal = sum.local || {};
  const destState = d => (sum.offsite || []).find(x => x.dest === d);
  const lastRestore = restore.data?.status && Date.now() - new Date(restore.data.status.updated_at) < 7 * 864e5 ? restore.data.status : null;

  return (
    <section id="backups">
      {data.escrow.due && (
        <div className="alert orange escrow-banner">
          <b>{t('bk_escrow_title')}</b>
          <p className="small">{t(data.escrow.confirmed_at ? 'bk_escrow_again' : 'bk_escrow_text', { key: data.escrow.key_id || '—' })}</p>
          <label className="check"><input type="checkbox" checked={escrowOk} onChange={e => setEscrowOk(e.target.checked)} /> {t('bk_escrow_check', { key: data.escrow.key_id || '—' })}</label>
          <button className="btn btn-primary btn-sm mt-s" disabled={!escrowOk} onClick={async () => { await api.post('/backups/escrow', { confirmed: true }); toast(t('saved')); reload(); }}>{t('bk_escrow_confirm')}</button>
        </div>
      )}
      {!data.agent.ok && <Alert>{t('bk_agent_down', { at: data.agent.seen_at ? fmtDate(data.agent.seen_at) : '—' })}</Alert>}
      {data.apply_error && <Alert>{t('bk_apply_error', { error: data.apply_error })}</Alert>}
      {lastRestore && lastRestore.state !== 'running' && (
        <Card title={t('bk_last_restore')}>
          <ProgressPanel snap={lastRestore} compact />
          <p className="small mt-s">{t('bk_last_restore_items', { items: (lastRestore.items || []).map(i => t('bk_item_' + i)).join('، '), at: fmtDate(lastRestore.updated_at) })}</p>
        </Card>
      )}

      <Card title={t('bk_status')} actions={<span className="row gap">
        <button className="btn btn-primary btn-sm" disabled={!!backupJob && !['ok', 'failed', 'cancelled'].includes(backupJob.status)} onClick={() => startJob('backup_now')}><Icon name="download" size={14} /> {t('bk_backup_now')}</button>
        <button className="btn btn-default btn-sm" disabled={!!verifyJob && !['ok', 'failed', 'cancelled'].includes(verifyJob.status)} onClick={() => startJob('verify_now')}><Icon name="check" size={14} /> {t('bk_verify_now')}</button>
      </span>}>
        <div className="kv bk-kv">
          <div><span>{t('bk_last_local')}</span><span>{lastLocal.last ? <>{fmtDate(lastLocal.last)} · <span dir="ltr">{fmtBytes(lastLocal.size, lang)}</span> {lastLocal.stale ? <Indicator color="red">{t('bk_late')}</Indicator> : <Indicator color="green">{t('bk_ok')}</Indicator>}</> : <Indicator color="red">{t('bk_none_yet')}</Indicator>}
            {lastLocal.failed_at && <Indicator color="red">{t('bk_failed_at', { at: fmtDate(lastLocal.failed_at), step: lastLocal.failed_step || '' })}</Indicator>}</span></div>
          <div><span>{t('bk_next_run')}</span><span>{st.next_backup ? fmtDate(st.next_backup) : '—'} · {t('bk_every_' + cfg.frequency_hours)}</span></div>
          {DESTS.filter(d => data.config[d].enabled).map(d => {
            const x = destState(d);
            return <div key={d}><span>{t('bk_dest_' + d)}</span><span>
              {!x ? <Indicator color="gray">{t('bk_dest_pending')}</Indicator> : x.ok ? <Indicator color={x.stale ? 'orange' : 'green'}>{t('bk_dest_ok')}</Indicator> : <Indicator color="red">{t('bk_dest_failed')}</Indicator>}
              {x?.last_ok && <span className="small"> {t('bk_last_copy', { at: fmtDate(x.last_ok) })}</span>}
              {x?.error && <span className="small text-red" dir="auto"> · {x.error}</span>}</span></div>;
          })}
          <div><span>{t('bk_last_verify')}</span><span>{sum.verify?.last ? <>{fmtDate(sum.verify.last)} {sum.verify.ok ? <Indicator color="green">{t('bk_verify_ok')}</Indicator> : <Indicator color="red">{t('bk_verify_failed')}</Indicator>}</> : <Indicator color="gray">{t('bk_none_yet')}</Indicator>}
            <span className="small"> · {t('bk_next_verify', { at: st.next_verify ? fmtDate(st.next_verify) : '—' })}</span></span></div>
          <div><span>{t('bk_disk')}</span><span dir="auto">{st.disk ? t('bk_disk_free', { free: fmtBytes(st.disk.free, lang), total: fmtBytes(st.disk.total, lang), dir: st.backup_dir }) : '—'}</span></div>
          <div><span>{t('bk_key')}</span><span><code dir="ltr">{data.escrow.key_id || st.key_id || '—'}</code>{data.escrow.confirmed_at && <span className="small"> · {t('bk_escrowed_at', { at: fmtDate(data.escrow.confirmed_at) })}</span>}</span></div>
        </div>
        <JobStatus job={backupJob} />
        <JobStatus job={verifyJob} />
      </Card>

      <Card title={t('bk_schedule')}>
        <div className="form-grid">
          <Field label={t('bk_frequency')}>
            <select className="input" value={cfg.frequency_hours} onChange={e => set('frequency_hours', +e.target.value)}>
              {data.limits.frequencies.map(f => <option key={f} value={f}>{t('bk_every_' + f)}</option>)}
            </select>
          </Field>
          {cfg.frequency_hours === 24 && <Field label={t('bk_daily_time')}><input className="input" type="time" dir="ltr" value={cfg.daily_time} onChange={e => set('daily_time', e.target.value)} /></Field>}
          <Field label={t('bk_logs_time')} hint={t('bk_logs_time_hint')}><input className="input" type="time" dir="ltr" value={cfg.logs_time} onChange={e => set('logs_time', e.target.value)} /></Field>
        </div>
        <h4 className="mt">{t('bk_verify_weekly')}</h4>
        <div className="form-grid">
          <label className="check"><input type="checkbox" checked={cfg.verify.enabled} onChange={e => set('verify.enabled', e.target.checked)} /> {t('bk_verify_enabled')}</label>
          <Field label={t('bk_verify_day')}><select className="input" value={cfg.verify.weekday} onChange={e => set('verify.weekday', +e.target.value)}>{[0, 1, 2, 3, 4, 5, 6].map(d => <option key={d} value={d}>{t('wd_' + d)}</option>)}</select></Field>
          <Field label={t('bk_verify_time')}><input className="input" type="time" dir="ltr" value={cfg.verify.time} onChange={e => set('verify.time', e.target.value)} /></Field>
        </div>
        <h4 className="mt">{t('bk_retention')}</h4>
        <div className="form-grid">
          <Field label={t('bk_keep_hourly')} hint={t('bk_range', { lo: data.limits.retention.hourly_hours[0], hi: data.limits.retention.hourly_hours[1] })}>{num('retention.hourly_hours', data.limits.retention.hourly_hours)}</Field>
          <Field label={t('bk_keep_daily')} hint={t('bk_range', { lo: data.limits.retention.daily_days[0], hi: data.limits.retention.daily_days[1] })}>{num('retention.daily_days', data.limits.retention.daily_days)}</Field>
          <Field label={t('bk_keep_weekly')} hint={t('bk_range', { lo: data.limits.retention.weekly_weeks[0], hi: data.limits.retention.weekly_weeks[1] })}>{num('retention.weekly_weeks', data.limits.retention.weekly_weeks)}</Field>
          <Field label={t('bk_keep_monthly')} hint={t('bk_range', { lo: data.limits.retention.monthly_months[0], hi: data.limits.retention.monthly_months[1] })}>{num('retention.monthly_months', data.limits.retention.monthly_months)}</Field>
        </div>
        <p className="field-hint">{t('bk_retention_hint')}</p>
      </Card>

      <Card title={t('bk_destinations')}>
        <p className="muted small">{t('bk_destinations_hint')}</p>
        {/* SSH */}
        <div className={'dest-box' + (cfg.ssh.enabled ? ' on' : '')}>
          <label className="check strong"><input type="checkbox" checked={cfg.ssh.enabled} onChange={e => set('ssh.enabled', e.target.checked)} /> {t('bk_dest_ssh')}</label>
          <div className="form-grid">
            <Field label={t('bk_ssh_target')} hint={t('bk_ssh_target_hint')}><input className="input" dir="ltr" placeholder="etsbackup@10.0.0.30:/srv/backups/ets" value={cfg.ssh.target} onChange={e => set('ssh.target', e.target.value.trim())} /></Field>
            <Field label={t('bk_port')}><input className="input" type="number" min={1} max={65535} dir="ltr" value={cfg.ssh.port} onChange={e => set('ssh.port', parseInt(e.target.value, 10) || 22)} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={cfg.ssh.prune} onChange={e => set('ssh.prune', e.target.checked)} /> {t('bk_prune')}</label>
          <div className="row gap wrap mt-s">
            <button className="btn btn-default btn-sm" onClick={() => setAsk({ kind: 'sshkey' })}><Icon name="plus" size={14} /> {t(st.ssh ? 'bk_ssh_key_rotate' : 'bk_ssh_key_create')}</button>
            <DestTest d="ssh" job={testJob.ssh} res={testRes.ssh} disabled={!data.config.ssh.enabled || dirty} onTest={() => startJob('test_destination', { dest: 'ssh' }, 'test_ssh')} />
          </div>
          {(keyResult || st.ssh) && (
            <div className="ssh-key mt-s">
              <div className="small">{t('bk_ssh_pub')} <code dir="ltr">{(keyResult || st.ssh).fingerprint}</code></div>
              <div className="small mt-s">{t('bk_ssh_line')}</div>
              <textarea className="input mono" dir="ltr" readOnly rows={3} value={(keyResult || st.ssh).authorized_keys_line} onFocus={e => e.target.select()} />
              <button className="btn btn-default btn-sm mt-s" onClick={() => { navigator.clipboard?.writeText((keyResult || st.ssh).authorized_keys_line); toast(t('bk_copied')); }}>{t('bk_copy')}</button>
              {st.ssh?.host_fingerprint && <div className="small mt-s">{t('bk_host_fp')} <code dir="ltr">{st.ssh.host_fingerprint}</code></div>}
            </div>
          )}
          <JobStatus job={keyJob} />
        </div>
        {/* NAS */}
        <div className={'dest-box' + (cfg.nas.enabled ? ' on' : '')}>
          <label className="check strong"><input type="checkbox" checked={cfg.nas.enabled} onChange={e => set('nas.enabled', e.target.checked)} /> {t('bk_dest_nas')}</label>
          <Field label={t('bk_nas_dir')} hint={t('bk_nas_dir_hint')}><input className="input" dir="ltr" placeholder="/mnt/ets-backup" value={cfg.nas.dir} onChange={e => set('nas.dir', e.target.value.trim())} /></Field>
          <label className="check"><input type="checkbox" checked={cfg.nas.prune} onChange={e => set('nas.prune', e.target.checked)} /> {t('bk_prune')}</label>
          <div className="mt-s"><DestTest d="nas" job={testJob.nas} res={testRes.nas} disabled={!data.config.nas.enabled || dirty} onTest={() => startJob('test_destination', { dest: 'nas' }, 'test_nas')} /></div>
        </div>
        {/* cloud */}
        <div className={'dest-box' + (cfg.cloud.enabled ? ' on' : '')}>
          <label className="check strong"><input type="checkbox" checked={cfg.cloud.enabled} onChange={e => set('cloud.enabled', e.target.checked)} /> {t('bk_dest_cloud')}</label>
          <div className="radio-list">
            {['s3', 'rclone'].map(m => <label key={m} className={'role-opt' + (cfg.cloud.mode === m ? ' on' : '')}><input type="radio" checked={cfg.cloud.mode === m} onChange={() => set('cloud.mode', m)} /> {t('bk_cloud_' + m)}</label>)}
          </div>
          {cfg.cloud.mode === 's3' ? (
            <div className="form-grid">
              <Field label={t('bk_provider')}><select className="input" value={cfg.cloud.provider} onChange={e => set('cloud.provider', e.target.value)}>{data.limits.providers.map(p => <option key={p}>{p}</option>)}</select></Field>
              <Field label={t('bk_endpoint')} hint={t('bk_endpoint_hint')}><input className="input" dir="ltr" placeholder="https://s3.example.com" value={cfg.cloud.endpoint} onChange={e => set('cloud.endpoint', e.target.value.trim())} /></Field>
              <Field label={t('bk_region')}><input className="input" dir="ltr" value={cfg.cloud.region} onChange={e => set('cloud.region', e.target.value.trim())} /></Field>
              <Field label={t('bk_bucket')}><input className="input" dir="ltr" value={cfg.cloud.bucket} onChange={e => set('cloud.bucket', e.target.value.trim())} /></Field>
              <Field label={t('bk_path')}><input className="input" dir="ltr" value={cfg.cloud.path} onChange={e => set('cloud.path', e.target.value.trim())} /></Field>
              {['cloud_access_key_id', 'cloud_secret_access_key'].map(k => (
                <Field key={k} label={t('bk_' + k)} hint={data.secrets[k] ? t('bk_secret_saved_hint') : t('bk_secret_required')}>
                  <input className="input" type="password" dir="ltr" autoComplete="new-password" placeholder={data.secrets[k] ? t('bk_secret_saved') : ''} value={secrets[k]} onChange={e => setSecrets(s => ({ ...s, [k]: e.target.value }))} />
                </Field>
              ))}
            </div>
          ) : (
            <Field label={t('bk_remote')} hint={t('bk_remote_hint')}><input className="input" dir="ltr" placeholder="wasabi:ets-backups/server1" value={cfg.cloud.remote} onChange={e => set('cloud.remote', e.target.value.trim())} /></Field>
          )}
          <label className="check"><input type="checkbox" checked={cfg.cloud.prune} onChange={e => set('cloud.prune', e.target.checked)} /> {t('bk_prune')}</label>
          <div className="mt-s"><DestTest d="cloud" job={testJob.cloud} res={testRes.cloud} disabled={!data.config.cloud.enabled || dirty} onTest={() => startJob('test_destination', { dest: 'cloud' }, 'test_cloud')} /></div>
        </div>
        <div className="row gap mt">
          <button className="btn btn-primary btn-sm" disabled={!dirty} onClick={trySave}>{t('bk_save')}</button>
          {dirty && <span className="muted small">{needReauth ? t('bk_save_reauth') : t('bk_unsaved')}</span>}
          {data.version > (data.applied_version ?? 0) && <Indicator color="orange">{t('bk_not_applied')}</Indicator>}
        </div>
      </Card>

      <Card title={t('bk_key_title')}>
        <p className="small">{t('bk_key_text', { key: data.escrow.key_id || st.key_id || '—' })}</p>
        <Alert kind="orange">{t('bk_key_old_warning')}</Alert>
        <div className="row gap wrap">
          <button className="btn btn-default btn-sm" onClick={() => setAsk({ kind: 'passphrase' })}>{t('bk_pp_change')}</button>
          <button className="btn btn-danger btn-sm" onClick={() => setAsk({ kind: 'revealkey' })}><Icon name="shield" size={14} /> {t('bk_key_reveal')}</button>
        </div>
        <p className="muted small mt-s">{t('bk_key_reveal_hint')}</p>
        <JobStatus job={ppJob} />
      </Card>

      <BackupFiles local={local} dests={st.destinations || {}} enabled={DESTS.filter(d => data.config[d].enabled)} />

      <Card title={t('bk_restore_title')}>
        <p className="small">{t('bk_restore_text')}</p>
        <ul className="small">
          <li>{t('bk_restore_factor_1')}</li><li>{t('bk_restore_factor_2')}</li><li>{t('bk_restore_factor_3')}</li>
        </ul>
        <button className="btn btn-danger btn-sm" onClick={() => setWizard(true)}><Icon name="restore" size={14} /> {t('bk_restore_open')}</button>
        <details className="mt small"><summary>{t('bk_restore_cli')}</summary>
          <pre dir="ltr" className="mono">sudo ets-restore /var/backups/ets/ets-YYYYmmdd-HHMMSS.dump.gpg{'\n'}sudo ets-restore --key /root/old-backup.key FILE{'\n'}sudo bash deploy/scripts/restore-server.sh --from /mnt/ets-backup --key /root/old-backup.key --dry-run</pre>
        </details>
      </Card>

      {wizard && <RestoreWizard data={data} onClose={() => { setWizard(false); reload(); restore.reload(); }} />}

      {ask?.kind === 'save' && <ReauthModal hint={t('bk_reauth_dest')} onClose={() => setAsk(null)} onConfirm={save} />}
      {ask?.kind === 'sshkey' && <ReauthModal hint={t(st.ssh ? 'bk_ssh_rotate_hint' : 'bk_ssh_create_hint')} onClose={() => setAsk(null)}
        onConfirm={auth => startJob('generate_ssh_key', { rotate: !!st.ssh, ...auth })} />}
      {ask?.kind === 'passphrase' && (
        <ReauthModal hint={t('bk_pp_hint')} onClose={() => { setAsk(null); setPp({ a: '', b: '' }); }} confirmLabel={t('bk_pp_set')}
          onConfirm={async auth => {
            if (pp.a !== pp.b) throw Object.assign(new Error('x'), { code: 'passphrase_mismatch' });
            const r = await api.post('/backups/passphrase', { passphrase: pp.a, ...auth });
            setJobs(j => ({ ...j, set_passphrase: r.job.id })); setAsk(null); setPp({ a: '', b: '' });
          }}>
          <Alert kind="orange">{t('bk_key_old_warning')}</Alert>
          <Field label={t('bk_pp_new')} hint={t('bk_pp_rule')}><input className="input" type="password" dir="ltr" autoComplete="new-password" value={pp.a} onChange={e => setPp(x => ({ ...x, a: e.target.value }))} /></Field>
          <Field label={t('bk_pp_repeat')}><input className="input" type="password" dir="ltr" autoComplete="new-password" value={pp.b} onChange={e => setPp(x => ({ ...x, b: e.target.value }))} /></Field>
        </ReauthModal>
      )}
      {ask?.kind === 'revealkey' && <KeyRevealModal keyId={data.escrow.key_id || st.key_id || null} onClose={() => setAsk(null)} />}
    </section>
  );
}

// Reveal / download the backup encryption key — the key that decrypts EVERY backup. A prominent red warning, fresh
// re-authentication (password + 2FA), then either a file download (backup.key) or a one-time on-screen reveal with a
// copy button. The key id is shown; the key is never retained by the page beyond this modal.
function KeyRevealModal({ keyId, onClose }) {
  const { t, errText } = useI18n();
  const { user } = useAuth();
  const [pw, setPw] = useState(''), [code, setCode] = useState(''), [err, setErr] = useState(null), [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(null);     // { key, key_id } once revealed on screen
  const needCode = !!user?.totp_enabled;
  const auth = () => {
    const second = !needCode ? {} : /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
    return { password: pw, ...second };
  };
  const run = async mode => {
    setBusy(true); setErr(null);
    try {
      if (mode === 'download') { await postDownloadFile('/backups/key/export', { mode: 'download', ...auth() }, 'backup.key'); toast(t('bk_key_downloaded')); onClose(); }
      else { setShown(await api.post('/backups/key/export', { mode: 'reveal', ...auth() })); }
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal title={t('bk_key_reveal_title')} onClose={onClose}
      footer={shown
        ? <button className="btn btn-default" onClick={onClose}>{t('close')}</button>
        : <><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
          <button className="btn btn-default" disabled={busy || !pw} onClick={() => run('reveal')}>{t('bk_key_show')}</button>
          <button className="btn btn-danger" disabled={busy || !pw} onClick={() => run('download')}><Icon name="download" size={14} /> {t('bk_key_download')}</button></>}>
      <Alert>{t('bk_key_reveal_warning')}</Alert>
      {err && <Alert>{errText(err)}</Alert>}
      {shown ? (
        <>
          <p className="small">{t('bk_key_shown_hint')}</p>
          <Field label={t('bk_key_label')}><textarea className="input mono" dir="ltr" readOnly rows={3} value={shown.key} onFocus={e => e.target.select()} /></Field>
          <button className="btn btn-default btn-sm" onClick={() => { navigator.clipboard?.writeText(shown.key); toast(t('bk_copied')); }}>{t('bk_copy')}</button>
          <p className="small mt-s">{t('bk_file_key')}: <code dir="ltr">{shown.key_id || keyId || '—'}</code></p>
        </>
      ) : (
        <>
          <p className="small mt-s">{t('bk_key_reveal_confirm', { key: keyId || '—' })}</p>
          <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
          {needCode && <Field label={t('code_or_recovery')}><input className="input otp" dir="ltr" autoComplete="one-time-code" value={code} placeholder="123456 / xxxx-xxxx-xxxx" onChange={e => setCode(e.target.value)} /></Field>}
        </>
      )}
    </Modal>
  );
}

function DestTest({ d, job, res, disabled, onTest }) {
  const { t } = useI18n();
  const j = job || res;
  const busy = job && !['ok', 'failed', 'cancelled'].includes(job.status);
  return (
    <span className="row gap wrap">
      <button className="btn btn-default btn-sm" disabled={disabled || busy} onClick={onTest} title={disabled ? t('bk_test_save_first') : ''}>{t('bk_test')}</button>
      {busy && <span className="muted small"><span className="spinner sm" /> {t('bk_testing')}</span>}
      {j && j.status === 'ok' && <Indicator color="green">{t('bk_test_ok', { n: j.result?.files ?? 0 })}</Indicator>}
      {j && j.status === 'ok' && d === 'ssh' && j.result?.host_fingerprint && <span className="small">{t('bk_host_fp')} <code dir="ltr">{j.result.host_fingerprint}</code></span>}
      {j && j.status === 'failed' && <span className="small text-red" dir="auto">{t('bk_test_failed')}: {j.result?.error}</span>}
    </span>
  );
}

function BackupFiles({ local, dests, enabled }) {
  const { t, fmtDate, lang, errText } = useI18n();
  const [kind, setKind] = useState('dump');
  const [dl, setDl] = useState(null);      // { file, base } waiting for re-auth
  const [busy, setBusy] = useState(null);  // the file name currently downloading
  const tokens = useRef({});               // base artifact name → { token, expires } (a fresh re-auth covers its siblings)
  const rows = local.filter(f => f.kind === kind);
  const on = d => new Set(dests[d] || []);
  const sets = Object.fromEntries(enabled.map(d => [d, on(d)]));
  // the files are encrypted (AES-256) and leave the server untouched — a valid token must match this user and artifact
  const validToken = base => { const e = tokens.current[base]; return e && e.expires > Date.now() ? e.token : null; };
  const stream = async (file, base, token) => {
    setBusy(file);
    try { await downloadFile(`/backups/download?file=${encodeURIComponent(file)}&token=${encodeURIComponent(token)}`, file); }
    catch (e) { toast(errText(e), 'red'); tokens.current[base] = null; }  // expired / invalid: force a new re-auth next time
    finally { setBusy(null); }
  };
  // ask for the artifact (base === f.name) or a sibling (file === base + '.sha256'); re-use a still-valid token
  const download = async (file, base) => { const tk = validToken(base); if (tk) await stream(file, base, tk); else setDl({ file, base }); };
  const authorize = async auth => {
    const r = await api.post('/backups/download/authorize', { file: dl.base, ...auth });
    tokens.current[dl.base] = { token: r.token, expires: Date.now() + (r.expires_in - 5) * 1000 };
    const { file, base } = dl; setDl(null);
    await stream(file, base, r.token);
  };
  return (
    <Card title={t('bk_files')} actions={<span className="seg">{KINDS.map(k => <button key={k} className={'btn btn-sm ' + (kind === k ? 'btn-primary' : 'btn-default')} onClick={() => setKind(k)}>{t('bk_kind_file_' + k)} ({local.filter(f => f.kind === k).length})</button>)}</span>}>
      {!rows.length ? <p className="muted">{t('bk_files_none')}</p> : (
        <>
          <div className="table-wrap">
            <table className="table small">
              <thead><tr><th>{t('bk_file_date')}</th><th>{t('bk_file_size')}</th><th>{t('bk_file_sha')}</th><th>{t('bk_file_key')}</th>
                <th>{t('bk_file_local')}</th>{enabled.map(d => <th key={d}>{t('bk_dest_short_' + d)}</th>)}<th>{t('bk_download')}</th></tr></thead>
              <tbody>
                {rows.slice(0, 60).map(f => (
                  <tr key={f.name}>
                    <td title={f.name}>{tsLabel(f.ts, fmtDate)}</td>
                    <td dir="ltr" className="num">{fmtBytes(f.size, lang)}</td>
                    <td><code dir="ltr" title={f.sha256 || ''}>{f.sha256 ? f.sha256.slice(0, 12) + '…' : '—'}</code>
                      {f.sha256 && <button className="btn btn-link btn-sm" disabled={!!busy} title={t('bk_download_sha')} onClick={() => download(f.name + '.sha256', f.name)}>SHA-256</button>}</td>
                    <td><code dir="ltr">{f.meta?.key_id || '—'}</code></td>
                    <td>✓</td>
                    {enabled.map(d => <td key={d}>{sets[d].has(f.name) ? '✓' : <span className="muted">—</span>}</td>)}
                    <td><button className="btn btn-default btn-sm" disabled={busy === f.name} title={t('bk_download_file')} onClick={() => download(f.name, f.name)}>
                      {busy === f.name ? <span className="spinner sm" /> : <Icon name="download" size={14} />} {t('bk_download')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small mt-s">{t('bk_download_encrypted_hint')}</p>
        </>
      )}
      {dl && <ReauthModal hint={t('bk_download_hint')} confirmLabel={t('bk_download')} onClose={() => setDl(null)} onConfirm={authorize} />}
    </Card>
  );
}
