// Progress of a long backup job (1.12.0): restore, rollback, inspection / test restore, «نسخ احتياطي الآن».
// Shows what the backup agent measured (backend/src/backup/progress.js): an animated bar (moving stripe while running,
// colour per state), the percentage with one decimal moving smoothly between updates, the time left (from the
// measured throughput; «تقديري» before the first measurement) and elapsed, data / table / row counters and the step
// checklist. The same bar is drawn by public/maintenance.html while the API is stopped.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';

const nf = new Intl.NumberFormat('en-US');
export function fmtBytes(n, lang = 'ar') {
  const v = Math.max(0, +n || 0);
  const u = lang === 'ar' ? ['بايت', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${i ? x.toFixed(x < 10 ? 1 : 0) : Math.round(x)} ${u[i]}`;
}
export function fmtDuration(s, lang = 'ar') {
  s = Math.max(0, Math.round(+s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const [H, M, S] = lang === 'ar' ? ['س', 'د', 'ث'] : ['h', 'min', 's'];
  if (h) return `${h} ${H} ${m} ${M}`;
  if (m) return `${m} ${M} ${r} ${S}`;
  return `${r} ${S}`;
}
const STATE_CLASS = { running: 'run', done: 'ok', failed: 'bad', rolling_back: 'warn', rolled_back: 'warn', rollback_failed: 'bad' };

// Percentage drawn on screen: eases from the shown value to the new one (no jumps, never backwards).
function useSmooth(target) {
  const [v, setV] = useState(target || 0);
  const ref = useRef(v);
  useEffect(() => {
    const from = ref.current, to = Math.max(from, +target || 0);
    if (to === from) return undefined;
    const t0 = performance.now(), dur = 900;
    let raf;
    const step = now => {
      const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      ref.current = from + (to - from) * e;
      setV(ref.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

export function ProgressBar2({ percent, state }) {
  const v = useSmooth(percent);
  return (
    <div className={'pbar ' + (STATE_CLASS[state] || 'run')} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className="pbar-fill" style={{ width: Math.min(100, v) + '%' }} />
    </div>
  );
}

export function ProgressPanel({ snap, title, compact = false }) {
  const { t, lang } = useI18n();
  const shown = useSmooth(snap?.percent || 0);
  if (!snap) return null;
  const state = snap.state || 'running';
  const c = snap.counters || {};
  const active = state === 'running' || state === 'rolling_back';
  const left = c.bytes ? Math.max(0, c.bytes.total - c.bytes.done) : 0;
  return (
    <div className={'progress-panel ' + (STATE_CLASS[state] || 'run') + (compact ? ' compact' : '')} aria-live="polite">
      <div className="pp-head">
        <b>{title || t('bp_title_' + (snap.kind || 'restore'))}</b>
        <span className="pp-state">{t('bp_state_' + state)}</span>
        <span className="pp-pct num" dir="ltr">{shown.toFixed(1)}%</span>
      </div>
      <ProgressBar2 percent={snap.percent} state={state} />
      <div className="pp-times">
        {active && <span>{t('bp_eta', { t: fmtDuration(snap.eta_s, lang) })}{snap.eta_estimated && <em className="muted"> · {t('bp_estimated')}</em>}</span>}
        <span>{t('bp_elapsed', { t: fmtDuration(snap.elapsed_s, lang) })}</span>
      </div>
      {(c.bytes || c.tables || c.rows) && (
        <div className="pp-counters">
          {c.bytes && c.bytes.total > 0 && <span>{t('bp_bytes', { done: fmtBytes(c.bytes.done, lang), total: fmtBytes(c.bytes.total, lang), left: fmtBytes(left, lang) })}</span>}
          {c.tables && c.tables.total > 0 && <span>{t('bp_tables', { done: nf.format(c.tables.done), total: nf.format(c.tables.total) })}</span>}
          {c.rows && c.rows.total > 0 && <span>{t('bp_rows', { done: nf.format(c.rows.done), total: nf.format(c.rows.total), left: nf.format(Math.max(0, c.rows.total - c.rows.done)) })}</span>}
        </div>
      )}
      {!compact && (
        <ol className="pp-steps">
          {(snap.phases || []).filter(p => p.state !== 'skipped').map(p => (
            <li key={p.key} className={'st-' + p.state}>
              <span className="st-icon" aria-hidden="true">{p.state === 'done' ? '✓' : p.state === 'failed' ? '✕' : p.state === 'running' ? <span className="spinner sm" /> : '○'}</span>
              <span>{t('bp_' + p.key)}</span>
              {p.state === 'running' && p.percent > 0 && <span className="muted num" dir="ltr">{p.percent.toFixed(0)}%</span>}
            </li>
          ))}
        </ol>
      )}
      {snap.error && <div className="alert red mt-s">{snap.error}</div>}
      {snap.rollback && (
        <div className="mt">
          <ProgressPanel snap={{ ...snap.rollback, kind: 'rollback', state: snap.rollback.state === 'done' ? 'rolled_back' : snap.rollback.state === 'failed' ? 'rollback_failed' : 'rolling_back' }} compact={compact} />
        </div>
      )}
    </div>
  );
}

// Polls a job until it ends; → the job
export function useJob(id, onEnd) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    if (!id) { setJob(null); return undefined; }
    let stop = false, timer;
    const tick = async () => {
      try {
        const j = (await api.get(path`/backups/jobs/${id}`, { live: true })).job;
        if (stop) return;
        setJob(j);
        if (['ok', 'failed', 'cancelled'].includes(j.status)) { onEnd?.(j); return; }
      } catch { /* keep polling */ }
      timer = setTimeout(tick, 1000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [id]);
  return job;
}

