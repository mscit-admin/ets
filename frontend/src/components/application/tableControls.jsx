import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { TEST_COLORS, NOTIF_COLORS, REVIEW_COLORS } from '../../lib/format.js';
import { Icon } from '../Icon.jsx';
import { toast } from '../ui.jsx';

// Functions table pagination: rows per page (remembered per browser, default 10).
export const PAGE_SIZES = [5, 10, 15, 20, 25];
const PAGE_SIZE_KEY = 'ets.fnPageSize';
export const readPageSize = () => {
  try { const n = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10); return PAGE_SIZES.includes(n) ? n : 10; } catch { return 10; }
};
export const savePageSize = n => { try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* storage unavailable */ } };

// The progress header stays visible (CSS position: sticky) only on screens wide and tall enough —
// keep in sync with the @media rule of .app-sticky in app.css.
export const STICKY_MQ = '(min-width: 900px) and (min-height: 500px)';
export const navbarHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-h')) || 52;

// Is the sticky header currently stuck under the top bar? (→ compact look + shadow)
// It only switches to the compact look when the page is long enough to stay scrolled after shrinking,
// so the header never flickers between the two sizes at the end of a short page.
export function useStuck(sentinelRef, boxRef, layoutKey) {
  const [stuck, setStuck] = useState(false);
  const check = useCallback(() => {
    const s = sentinelRef.current, box = boxRef.current;
    if (!s || !box || !window.matchMedia(STICKY_MQ).matches) { setStuck(false); return; }
    const top = s.getBoundingClientRect().top - navbarHeight();     // < 0 once the header has reached the top bar
    if (top >= 0) { setStuck(false); return; }
    setStuck(was => {
      if (was) return true;
      const room = document.documentElement.scrollHeight - window.innerHeight - (window.scrollY + top);
      return room > box.offsetHeight;
    });
  }, [sentinelRef, boxRef]);
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(check); };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [check]);
  useLayoutEffect(() => { check(); }, [check, layoutKey]);   // re-check when the rows below change
  return stuck;
}

export function Pager({ page, pages, total, size, onPage, onSize }) {
  const { t, dir } = useI18n();
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  // icons picked by direction (not mirrored with CSS): in Arabic "next" points left, "previous" points right
  const rtl = dir === 'rtl';
  const arrow = (icon, label, target, disabled) => (
    <button type="button" className="btn btn-default btn-sm pager-arrow" disabled={disabled} onClick={() => onPage(target)}
      aria-label={label} title={label}><Icon name={icon} size={15} /></button>
  );
  const [before, after] = t('showing_range', { n: total }).split('{range}');
  return (
    <nav className="fn-pager" aria-label={t('page_of', { page, pages })}>
      <label className="fn-pager-size">
        <span>{t('rows_per_page')}</span>
        <select className="input input-sm" value={size} onChange={e => onSize(parseInt(e.target.value, 10))}>
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="fn-pager-range muted small">{before}<bdi dir="ltr">{from}–{to}</bdi>{after}</span>
      <div className="fn-pager-nav">
        {arrow(rtl ? 'chevrons' : 'chevrons_back', t('first_page'), 1, page <= 1)}
        {arrow(rtl ? 'chevron' : 'chevron_back', t('previous_page'), page - 1, page <= 1)}
        <span className="fn-pager-page small" aria-live="polite">{t('page_of', { page, pages })}</span>
        {arrow(rtl ? 'chevron_back' : 'chevron', t('next_page'), page + 1, page >= pages)}
        {arrow(rtl ? 'chevrons_back' : 'chevrons', t('last_page'), pages, page >= pages)}
      </div>
    </nav>
  );
}

// Number input that only commits on blur / Enter (one request per edit, not per keystroke).
// A new value from the server (save, or a live update by another user) replaces the shown one, except while the
// user is typing in this cell: the typed value is kept until it is committed or abandoned (blur).
// check(n): a message when the value cannot be saved (shown as an alert; the cell goes back to its value).
export function NumCell({ value, min, max, step = 1, disabled, onCommit, label, check }) {
  const [v, setV] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setV(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    const n = Math.min(max, Math.max(min, parseFloat(v)));
    if (!Number.isFinite(n)) { setV(String(value)); return; }
    if (n === +value) { setV(String(value)); return; }
    const problem = check?.(n);
    if (problem) { toast(problem, 'red'); setV(String(value)); return; }
    onCommit(n);
  };
  return (
    <input className="input input-sm num-input" type="number" min={min} max={max} step={step} value={v} disabled={disabled}
      aria-label={label} onChange={e => { editing.current = true; setV(e.target.value); }} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

// test_status has eight states (1.12.x), review_status six (1.12.17); notification has four.
// Colour follows the value's MEANING per field (not the raw ordinal, which would clash across fields — UX-2):
// each field has its own semantic map, applied as a colour-named class (.select-status.<colour>).
const STATUS_COLORS = { ts_: TEST_COLORS, ns_: NOTIF_COLORS, rv_: REVIEW_COLORS };
export function StatusSelect({ value, prefix, disabled, onChange, label, states = 4 }) {
  const { t } = useI18n();
  const color = (STATUS_COLORS[prefix] || [])[value] || 'gray';
  return (
    <select className={'input input-sm select-status ' + color} value={value} disabled={disabled} aria-label={label}
      onChange={e => onChange(parseInt(e.target.value, 10))}>
      {Array.from({ length: states }, (_, i) => <option key={i} value={i}>{t(prefix + i)}</option>)}
    </select>
  );
}
