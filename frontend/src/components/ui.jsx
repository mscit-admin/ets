import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from './Icon.jsx';
import { pc, pctColor } from '../lib/format.js';

// ERPNext-style coloured status pill
export function Indicator({ color = 'gray', children, title }) {
  return <span className={'indicator-pill ' + color} title={title}>{children}</span>;
}

export function ProgressBar({ value }) {
  const v = Math.max(0, Math.min(100, +value || 0));
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={'progress-bar ' + pctColor(v)} style={{ width: v + '%' }} />
    </div>
  );
}

export function Pct({ value }) {
  return <span className="num">{pc(value)}%</span>;
}

export function PageHeader({ title, sub, children, icon }) {
  return (
    <div className="page-head">
      <div className="page-title">
        {icon && <span className="page-icon"><Icon name={icon} size={20} /></span>}
        <div>
          <h1>{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={'card ' + className}>
      {(title || actions) && (
        <div className="card-head">
          <h3>{title}</h3>
          <div className="card-actions">{actions}</div>
        </div>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function NumberCard({ label, value, sub, color }) {
  return (
    <div className="number-card">
      <div className="nc-label">{label}</div>
      <div className={'nc-value ' + (color || '')}>{value}</div>
      {sub && <div className="nc-sub">{sub}</div>}
    </div>
  );
}

// blocking: a mandatory modal that cannot be dismissed — no X, no backdrop click, no Escape (the force-alert gate).
// onClose is then optional and never called by the chrome.
export function Modal({ title, onClose, children, footer, wide, blocking = false }) {
  const { t } = useI18n();
  const ref = useRef(null);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape' && !blocking) onClose?.(); };
    document.addEventListener('keydown', k);
    (ref.current?.querySelector('.modal-body textarea, .modal-body input, .modal-body select') || ref.current?.querySelector('button'))?.focus();
    return () => document.removeEventListener('keydown', k);
  }, [onClose, blocking]);
  return (
    <div className={'modal-backdrop' + (blocking ? ' blocking' : '')}
      onMouseDown={blocking ? undefined : e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h3>{title}</h3>
          {!blocking && <button className="btn-icon" onClick={onClose} aria-label={t('close')}><Icon name="x" /></button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ kind = 'red', children }) {
  if (!children) return null;
  return <div className={'alert ' + kind}>{children}</div>;
}

export function Loading() {
  const { t } = useI18n();
  return <div className="loading"><span className="spinner" />{t('loading')}</div>;
}

export function ErrorBox({ error }) {
  const { errText } = useI18n();
  if (!error) return null;
  return <Alert kind="red">{errText(error)}</Alert>;
}

export function Empty({ children }) {
  const { t } = useI18n();
  return <div className="empty">{children || t('no_data')}</div>;
}

// Field with label (ERPNext form control)
export function Field({ label, children, hint, className = '' }) {
  return (
    <label className={'field ' + className}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

// Brief notification at the bottom of the screen
let toastFn = () => {};
export const toast = (msg, kind = 'green') => toastFn(msg, kind);
export function ToastHost() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    toastFn = (msg, kind) => {
      const id = Math.random();
      setItems(x => [...x, { id, msg, kind }]);
      setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3200);
    };
  }, []);
  return <div className="toasts">{items.map(i => <div key={i.id} className={'toast ' + i.kind}>{i.msg}</div>)}</div>;
}

// Data loader hook: const { data, error, loading, reload, refresh } = useLoad(o => api.get(url, o), [deps])
//   reload()  — loads again (loading flag on, an error replaces the data);
//   refresh() — silent reload for live updates (lib/live.js): passes { live: true } to the loader, keeps the
//               data on screen while loading and when it fails; an answer older than a newer request is dropped.
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);
  useEffect(() => {
    let alive = true;
    const my = ++seq.current;
    setState(s => ({ ...s, loading: true }));
    fn({}).then(data => alive && my === seq.current && setState({ data, error: null, loading: false }))
      .catch(error => alive && my === seq.current && setState({ data: null, error, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const refresh = useCallback(() => {
    const my = ++seq.current;
    return fnRef.current({ live: true })
      .then(data => { if (my === seq.current) setState({ data, error: null, loading: false }); })
      .catch(() => { /* keep what is on screen; the next event or poll tries again */ });
  }, []);
  const reload = useCallback(() => setN(x => x + 1), []);
  return { ...state, reload, refresh };
}
