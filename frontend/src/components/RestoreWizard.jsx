// «استرجاع من نسخة» (1.12.0) — the restore wizard of Settings → «النسخ الاحتياطي». Steps:
//   1 the backup point: source (this server, SSH, NAS, cloud, or an uploaded encrypted file), the database backup, the
//     configuration bundle in force at that time (or another one), the day of the logs
//   2 what to restore: «تحديد الكل» (tri-state) and each item with its description, date and source file; unavailable
//     items are disabled with the reason; the dependency warnings of the server are shown inline
//   3 the three factors: the administrator's password, the 2FA code (when enabled) and the backup key / passphrase
//   4 inspection by the backup agent (nothing is changed): decryption, checksums, test restore, versions, counts
//   5 confirmation: what is replaced, everybody is signed out, a safety backup is taken; the server name or «استرجاع»
//   6 progress from /api/restore-status.json (served by nginx while the API is stopped), then done / rolled back
import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Alert, Field, Indicator, Modal } from './ui.jsx';
import { ProgressPanel, fmtBytes, useJob } from './ProgressPanel.jsx';

const ITEMS = ['db', 'env', 'tls', 'install_conf', 'db_ca', 'logs'];
const STEPS = ['point', 'items', 'auth', 'inspect', 'confirm', 'progress'];
const kindOf = n => (/^ets-config-/.test(n) ? 'config' : /^ets-logs-/.test(n) ? 'logs' : /^ets-\d{8}-\d{6}\.dump/.test(n) ? 'dump' : null);
const tsOf = n => (n.match(/(\d{8})-(\d{6})/) || n.match(/(\d{8})()/) || []).slice(1).join('-');
const isoOf = ts => (ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11) || '23'}:${ts.slice(11, 13) || '59'}:${ts.slice(13, 15) || '59'}` : null);

// the status file: nginx serves it while the API is down (needs X-ETS-Status: 1); the API route as a fallback
async function restoreStatus() {
  try {
    const r = await fetch('/api/restore-status.json', { headers: { 'X-ETS-Status': '1' }, cache: 'no-store', credentials: 'same-origin' });
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) return await r.json();
  } catch { /* fall back */ }
  try { return (await api.get('/backups/restore/status', { live: true })).status; } catch { return null; }
}

// ---------------------------------------------------------------- the restore monitor (step 6)
// Shown by App.jsx instead of every other page while sessionStorage holds 'ets.restore.watch': the sessions end during
// a database restore and the API may be stopped, so this view only reads the progress file (no session needed) and
// leaves when the administrator clicks the final button (then signs in again and sees the summary in Settings).
const WATCH = 'ets.restore.watch';
export function readWatch() { try { return JSON.parse(sessionStorage.getItem(WATCH) || 'null'); } catch { return null; } }
function startWatch(items, job) {
  try { sessionStorage.setItem(WATCH, JSON.stringify({ items, job, at: Date.now() })); } catch { /* storage off: the wizard keeps polling */ }
  window.dispatchEvent(new Event('ets-restore-watch'));
}
export function RestoreMonitor({ watch }) {
  const { t } = useI18n();
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let stop = false, timer;
    // only the status of this restore (the file still shows the previous one until the agent starts)
    const tick = async () => { const s = await restoreStatus(); if (!stop && s && (!watch?.job || String(s.id) === String(watch.job))) setStatus(s); if (!stop) timer = setTimeout(tick, 1000); };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [watch?.job]);
  const items = watch?.items || status?.items || [];
  const signOut = items.includes('db') || items.includes('env');
  const final = status && ['done', 'failed', 'rolled_back', 'rollback_failed'].includes(status.state);
  const leave = () => { try { sessionStorage.removeItem(WATCH); } catch { /* ignore */ } window.location.replace('/settings?restored=1#backups'); };
  return (
    <div className="restore-monitor">
      <div className="card">
        <div className="card-head"><h3>{t('bk_restore_open')}</h3></div>
        <div className="card-body">
          <ol className="wizard-steps">{STEPS.map((s, i) => <li key={s} className={i < 5 ? 'done' : 'current'}><span className="num">{i + 1}</span> {t('bk_step_' + s)}</li>)}</ol>
          <p className="small">{t('bk_monitor_items', { items: items.map(i => t('bk_item_' + i)).join('، ') })}</p>
          {!status && <p className="muted"><span className="spinner sm" /> {t('bk_job_waiting_agent')}</p>}
          {status && <ProgressPanel snap={status} />}
          {status?.state === 'done' && <Alert kind="green">{t(signOut ? 'bk_done_signout' : 'bk_done')}</Alert>}
          {status?.state === 'rolled_back' && <Alert kind="orange">{t('bk_rolled_back')}</Alert>}
          {status?.state === 'rollback_failed' && <Alert>{t('bk_rollback_failed')}</Alert>}
          {status?.state === 'failed' && <Alert>{t('bk_restore_failed_nothing')}</Alert>}
          {final && <button className="btn btn-primary mt" onClick={leave}>{t(signOut && status.state === 'done' ? 'bk_sign_in_again' : 'bk_monitor_back')}</button>}
          {!final && <p className="muted small mt">{t('bk_monitor_wait')}</p>}
        </div>
      </div>
    </div>
  );
}

export function RestoreWizard({ data, onClose, initialStep }) {
  const { t, fmtDate, lang, errText } = useI18n();
  const { user } = useAuth();
  const [step, setStep] = useState(initialStep || 'point');
  const [source, setSource] = useState('local');
  const [point, setPoint] = useState({ dump: null, config: undefined, logs: null });
  const [uploads, setUploads] = useState({});      // name → upload id
  const [upProgress, setUpProgress] = useState(null);
  const [plan, setPlan] = useState(null);
  const [items, setItems] = useState([]);
  const [auth, setAuth] = useState({ password: '', code: '', key: '' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inspectId, setInspectId] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [status, setStatus] = useState(null);
  const st = data.status || {};
  const destOn = ['ssh', 'nas', 'cloud'].filter(d => data.config[d].enabled && st.destinations?.[d]);
  // the files of the chosen source
  const names = useMemo(() => {
    if (source === 'local') return (st.local || []).map(f => f.name);
    if (source === 'upload') return Object.keys(uploads);
    return (st.destinations?.[source] || []).filter(n => kindOf(n));
  }, [source, uploads, st]);
  const sizeOf = n => (st.local || []).find(f => f.name === n)?.size;
  const list = k => names.filter(n => kindOf(n) === k).sort().reverse();
  useEffect(() => { setPoint({ dump: list('dump')[0] || null, config: undefined, logs: null }); setItems([]); }, [source, names.length]);

  // the plan (availability + warnings) for the point and the selection
  useEffect(() => {
    if (step !== 'point' && step !== 'items') return undefined;
    let stop = false;
    const body = { source, dump: point.dump, logs: point.logs, items, ...(point.config !== undefined ? { config: point.config } : {}), ...(source === 'upload' ? { uploads } : {}) };
    api.post('/backups/restore/plan', body).then(p => { if (!stop) { setPlan(p); setErr(null); } }).catch(e => { if (!stop) setErr(e); });
    return () => { stop = true; };
  }, [source, point, items, uploads, step]);
  const avail = plan?.available || {};
  const usable = ITEMS.filter(i => avail[i]?.available);
  const all = usable.length > 0 && usable.every(i => items.includes(i));
  const some = items.length > 0 && !all;
  const allRef = useRef(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = some; }, [some, step]);
  const toggle = i => setItems(x => (x.includes(i) ? x.filter(y => y !== i) : [...x, i]));

  const inspectJob = useJob(inspectId);
  const ir = inspectJob?.result;
  useEffect(() => {
    if (step !== 'progress') return undefined;
    let stop = false, timer;
    const tick = async () => { const s = await restoreStatus(); if (!stop && s) setStatus(s); if (!stop) timer = setTimeout(tick, 1000); };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [step]);

  const upload = async (file, idHint) => {
    const name = file.name;
    if (!/^ets-.*\.gpg(\.(sha256|meta))?$/.test(name)) { setErr({ code: 'invalid_file_name' }); return null; }
    return new Promise(resolve => {
      const x = new XMLHttpRequest();
      x.open('POST', `/api/backups/upload?name=${encodeURIComponent(name)}${idHint ? '&upload_id=' + idHint : ''}`);
      x.setRequestHeader('X-Requested-With', 'ets'); x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = e => setUpProgress({ name, done: e.loaded, total: e.total });
      x.onload = () => { setUpProgress(null); try { const r = JSON.parse(x.responseText); if (x.status === 200) resolve(r); else { setErr({ code: r.error }); resolve(null); } } catch { resolve(null); } };
      x.onerror = () => { setUpProgress(null); setErr({ code: 'network' }); resolve(null); };
      x.send(file);
    });
  };
  const onFiles = async files => {
    let id = Object.values(uploads)[0] || '';
    const got = {};
    for (const f of [...files].sort((a, b) => a.name.length - b.name.length)) {
      const r = await upload(f, id);
      if (r) { id = r.upload_id; if (kindOf(r.name) && !/\.(sha256|meta)$/.test(r.name)) got[r.name] = r.upload_id; }
    }
    setUploads(u => ({ ...u, ...got }));
  };

  const inspect = async () => {
    setBusy(true); setErr(null);
    const second = !user?.totp_enabled ? {} : /^\d{6}$/.test(auth.code.trim()) ? { code: auth.code.trim() } : { recovery_code: auth.code.trim() };
    try {
      const r = await api.post('/backups/restore/inspect', { source, dump: point.dump, logs: point.logs, ...(point.config !== undefined ? { config: point.config } : {}),
        items, uploads: source === 'upload' ? uploads : undefined, password: auth.password, key: auth.key, ...second });
      setInspectId(r.job.id); setAuth({ password: '', code: '', key: '' }); setStep('inspect');
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/backups/restore/run', { inspect_id: inspectId, items, confirm: phrase });
      // from here the restore monitor takes over the page: it does not depend on the session, which the restore ends
      startWatch(items, r.job.id);
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const desc = i => {
    const a = avail[i] || {};
    const from = a.from ? fmtDate(isoOf(tsOf(a.from))) : null;
    return (
      <label key={i} className={'restore-item' + (a.available ? '' : ' off') + (items.includes(i) ? ' on' : '')}>
        <input type="checkbox" disabled={!a.available} checked={items.includes(i)} onChange={() => toggle(i)} />
        <span className="grow">
          <b>{t('bk_item_' + i)}</b>
          <span className="small muted">{t('bk_item_' + i + '_desc')}</span>
          {a.available ? <span className="small">{t('bk_item_from', { date: from || '—', file: a.from })}</span>
            : <span className="small text-red">{t('bk_unavail_' + (a.reason || 'no_dump'))}</span>}
          {(plan?.warnings || []).filter(w => w.item === i).map(w => <span key={w.code} className={'alert ' + (w.blocking ? 'red' : 'orange') + ' small'}>{t('bk_warn_' + w.code, { san: w.san || '', version: w.version || '' })}</span>)}
        </span>
      </label>
    );
  };
  const idx = STEPS.indexOf(step);
  const final = status && ['done', 'failed', 'rolled_back', 'rollback_failed'].includes(status.state);
  const signOut = items.includes('db') || items.includes('env');
  const footer = (
    <>
      {step !== 'progress' && <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>}
      {step === 'point' && <button className="btn btn-primary" disabled={!names.length} onClick={() => setStep('items')}>{t('next')}</button>}
      {step === 'items' && <><button className="btn btn-default" onClick={() => setStep('point')}>{t('back')}</button>
        <button className="btn btn-primary" disabled={!items.length || plan?.problem || (plan?.warnings || []).some(w => w.blocking)} onClick={() => setStep('auth')}>{t('next')}</button></>}
      {step === 'auth' && <><button className="btn btn-default" onClick={() => setStep('items')}>{t('back')}</button>
        <button className="btn btn-primary" disabled={busy || !auth.password || !auth.key} onClick={inspect}>{t('bk_inspect')}</button></>}
      {step === 'inspect' && inspectJob?.status === 'ok' && !(ir?.blocking?.length && items.includes('db')) && <button className="btn btn-primary" onClick={() => setStep('confirm')}>{t('next')}</button>}
      {step === 'inspect' && inspectJob?.status === 'failed' && <button className="btn btn-default" onClick={() => { setInspectId(null); setStep('auth'); }}>{t('back')}</button>}
      {step === 'confirm' && <><button className="btn btn-default" onClick={() => setStep('inspect')}>{t('back')}</button>
        <button className="btn btn-danger" disabled={busy || !phrase.trim()} onClick={run}>{t('bk_restore_start')}</button></>}
      {step === 'progress' && final && (signOut && status.state === 'done'
        ? <button className="btn btn-primary" onClick={() => window.location.reload()}>{t('bk_sign_in_again')}</button>
        : <button className="btn btn-primary" onClick={onClose}>{t('close')}</button>)}
    </>
  );
  return (
    <Modal title={t('bk_restore_open')} onClose={step === 'progress' && !final ? () => {} : onClose} footer={footer} wide>
      <ol className="wizard-steps" aria-label={t('bk_restore_open')}>
        {STEPS.map((s, i) => <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''}><span className="num">{i + 1}</span> {t('bk_step_' + s)}</li>)}
      </ol>
      {err && <Alert>{errText(err)}</Alert>}

      {step === 'point' && (
        <div>
          <Field label={t('bk_source')}>
            <div className="radio-list">
              {['local', ...destOn, 'upload'].map(s => <label key={s} className={'role-opt' + (source === s ? ' on' : '')}><input type="radio" checked={source === s} onChange={() => setSource(s)} /> {t('bk_src_' + s)}</label>)}
            </div>
          </Field>
          {source === 'upload' && (
            <div className="dest-box on">
              <p className="small">{t('bk_upload_hint', { max: fmtBytes(data.limits.upload_max_bytes, lang) })}</p>
              <input type="file" multiple accept=".gpg,.sha256,.meta" onChange={e => onFiles(e.target.files)} />
              {upProgress && <div className="small mt-s">{upProgress.name}: {fmtBytes(upProgress.done, lang)} / {fmtBytes(upProgress.total, lang)}</div>}
              {Object.keys(uploads).length > 0 && <ul className="small mt-s">{Object.keys(uploads).map(n => <li key={n} dir="ltr">{n}</li>)}</ul>}
            </div>
          )}
          <div className="form-grid mt">
            <Field label={t('bk_point_dump')}>
              <select className="input" value={point.dump || ''} onChange={e => setPoint(p => ({ ...p, dump: e.target.value || null, config: undefined }))}>
                <option value="">{t('bk_point_none')}</option>
                {list('dump').map(n => <option key={n} value={n}>{fmtDate(isoOf(tsOf(n)))}{sizeOf(n) ? ` — ${fmtBytes(sizeOf(n), lang)}` : ''}</option>)}
              </select>
            </Field>
            <Field label={t('bk_point_config')} hint={plan?.point?.config ? t('bk_point_config_auto', { date: fmtDate(isoOf(tsOf(plan.point.config))) }) : t('bk_unavail_no_config')}>
              <select className="input" value={point.config === undefined ? '' : point.config || '-'} onChange={e => setPoint(p => ({ ...p, config: e.target.value === '' ? undefined : e.target.value === '-' ? null : e.target.value }))}>
                <option value="">{t('bk_point_config_nearest')}</option>
                <option value="-">{t('bk_point_none')}</option>
                {list('config').map(n => <option key={n} value={n}>{fmtDate(isoOf(tsOf(n)))}</option>)}
              </select>
            </Field>
            <Field label={t('bk_point_logs')} hint={t('bk_point_logs_hint')}>
              <select className="input" value={point.logs || ''} onChange={e => setPoint(p => ({ ...p, logs: e.target.value || null }))}>
                <option value="">{t('bk_point_none')}</option>
                {list('logs').map(n => <option key={n} value={n}>{fmtDate(isoOf(tsOf(n))).split(/[,،]/)[0]}</option>)}
              </select>
            </Field>
          </div>
          {!names.length && <p className="muted">{t('bk_files_none')}</p>}
        </div>
      )}

      {step === 'items' && (
        <div>
          <label className="restore-item all">
            <input ref={allRef} type="checkbox" checked={all} disabled={!usable.length} onChange={() => setItems(all ? [] : usable)} aria-checked={some ? 'mixed' : all} />
            <b>{t('bk_select_all')}</b> <span className="muted small">({items.length}/{usable.length})</span>
          </label>
          {ITEMS.map(desc)}
          {(plan?.warnings || []).filter(w => !ITEMS.includes(w.item)).map(w => <Alert key={w.code} kind="orange">{t('bk_warn_' + w.code)}</Alert>)}
        </div>
      )}

      {step === 'auth' && (
        <div>
          <p className="small">{t('bk_auth_text')}</p>
          <ul className="small">{items.map(i => <li key={i}>{t('bk_item_' + i)}</li>)}</ul>
          <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={auth.password} onChange={e => setAuth(a => ({ ...a, password: e.target.value }))} /></Field>
          {user?.totp_enabled && <Field label={t('code_or_recovery')}><input className="input otp" dir="ltr" autoComplete="one-time-code" placeholder="123456 / xxxx-xxxx-xxxx" value={auth.code} onChange={e => setAuth(a => ({ ...a, code: e.target.value }))} /></Field>}
          <Field label={t('bk_restore_key')} hint={t('bk_restore_key_hint', { key: (plan?.metas?.[point.dump] || plan?.metas?.[plan?.point?.config])?.key_id || '—' })}>
            <input className="input mono" type="password" dir="ltr" autoComplete="off" spellCheck={false} value={auth.key} onChange={e => setAuth(a => ({ ...a, key: e.target.value }))} />
          </Field>
        </div>
      )}

      {step === 'inspect' && (
        <div>
          {inspectJob && inspectJob.status !== 'ok' && inspectJob.status !== 'failed' && (inspectJob.progress
            ? <ProgressPanel snap={inspectJob.progress} title={t('bk_inspecting')} /> : <p className="muted"><span className="spinner sm" /> {t('bk_job_waiting_agent')}</p>)}
          {inspectJob?.status === 'failed' && <Alert>{t('bk_inspect_err_' + (['wrong_key', 'checksum_mismatch', 'item_not_in_bundle'].includes(ir?.error) ? ir.error : 'other'), { error: ir?.error || '' })}</Alert>}
          {inspectJob?.status === 'ok' && ir && <InspectSummary ir={ir} items={items} current={data.current} />}
        </div>
      )}

      {step === 'confirm' && ir && (
        <div>
          <Alert>{t('bk_confirm_warning')}</Alert>
          <ul>
            {items.map(i => <li key={i}><b>{t('bk_item_' + i)}</b> — {t('bk_confirm_replace_' + i)}</li>)}
          </ul>
          <ul className="small">
            {(items.includes('db') || items.includes('install_conf') || items.includes('env') || items.includes('tls') || items.includes('db_ca')) && <li>{t('bk_confirm_safety')}</li>}
            {signOut && <li><b>{t('bk_confirm_signout')}</b></li>}
            {signOut ? <li>{t('bk_confirm_downtime')}</li> : <li>{t('bk_confirm_no_downtime')}</li>}
          </ul>
          {(ir.warnings || []).map(w => <Alert key={w.code} kind="orange">{t('bk_warn_' + w.code, { san: w.san || '', version: w.version || '' })}</Alert>)}
          <Field label={t('bk_confirm_phrase', { host: data.current.hostname })}>
            <input className="input" value={phrase} onChange={e => setPhrase(e.target.value)} placeholder={t('bk_confirm_phrase_ph')} />
          </Field>
        </div>
      )}

      {step === 'progress' && (
        <div>
          {!status && <p className="muted"><span className="spinner sm" /> {t('bk_job_waiting_agent')}</p>}
          {status && <ProgressPanel snap={status} />}
          {status?.state === 'done' && <Alert kind="green">{t(signOut ? 'bk_done_signout' : 'bk_done')}</Alert>}
          {status?.state === 'rolled_back' && <Alert kind="orange">{t('bk_rolled_back')}</Alert>}
          {status?.state === 'rollback_failed' && <Alert>{t('bk_rollback_failed')}</Alert>}
        </div>
      )}
    </Modal>
  );
}

function InspectSummary({ ir, items, current }) {
  const { t, fmtDate, lang } = useI18n();
  const d = ir.dump, c = ir.config;
  const counts = d?.counts || {};
  return (
    <div>
      <Alert kind="green">{t('bk_inspect_ok')}</Alert>
      <div className="kv">
        {d && <div><span>{t('bk_ins_db_date')}</span><span>{d.created ? fmtDate(d.created) : '—'} · <span dir="ltr">{fmtBytes(ir.files?.dump?.size, lang)}</span> · {t('bk_ins_db_size', { size: fmtBytes(d.db_size, lang) })}</span></div>}
        {c && <div><span>{t('bk_ins_cfg_date')}</span><span>{fmtDate(c.created)}</span></div>}
        <div><span>{t('bk_ins_version')}</span><span>{t('bk_ins_version_v', { from: (d?.app_version || c?.app_version || '—') + (c?.git_commit ? ` (${c.git_commit.slice(0, 8)})` : ''), to: current.app_version })}</span></div>
        {d && <div><span>{t('bk_ins_migrations')}</span><span dir="ltr">{d.migrations?.last || '—'}{d.migrations?.pending ? ` → ${d.migrations.pending}` : ''}</span></div>}
        {c && <div><span>{t('bk_ins_host')}</span><span dir="ltr">{c.hostname} · {(c.ips || []).join(', ')} · {c.address}</span></div>}
        {d && <div><span>{t('bk_ins_audit')}</span><span>{d.audit_ok ? <Indicator color="green">{t('bk_verify_ok')}</Indicator> : <Indicator color="red">{t('bk_verify_failed')}</Indicator>}</span></div>}
        {ir.logs && <div><span>{t('bk_item_logs')}</span><span>{t('bk_ins_logs', { n: ir.logs.files })}</span></div>}
      </div>
      {d && (
        <table className="table small mt">
          <thead><tr><th>{t('bk_ins_table')}</th><th>{t('bk_ins_in_backup')}</th><th>{t('bk_ins_now')}</th></tr></thead>
          <tbody>{Object.entries(counts).map(([k, v]) => <tr key={k}><td dir="ltr">{k}</td><td className="num">{v.restored}</td><td className="num">{v.live ?? '—'}</td></tr>)}</tbody>
        </table>
      )}
      {(ir.blocking || []).map(b => <Alert key={b.code}>{t('bk_block_' + b.code, { version: b.version || '', unknown: b.unknown || '' })}</Alert>)}
      {d?.migrations?.pending && <Alert kind="orange">{t('bk_ins_older')}</Alert>}
      {(ir.warnings || []).map(w => <Alert key={w.code} kind="orange">{t('bk_warn_' + w.code, { san: w.san || '', version: w.version || '' })}</Alert>)}
      <p className="small muted">{t('bk_ins_items', { items: items.map(i => t('bk_item_' + i)).join('، ') })}</p>
    </div>
  );
}
