// Item type (1.8.0): each item of an application is a function («وظيفة», cog icon, navy) or a report («تقرير»,
// document-chart icon, teal). Report items count in the application's reports %, not in its functions % (backend
// services/calc.js). The colours stay away from the red → green progress scale and the pass / fail test colours.
//   <ItemTypeChip>   icon + label; for a user who may change it, a button that opens a small menu (keyboard: Enter /
//                    Space / ↓ open, ↑ ↓ Home End move, Enter / Space choose, Esc / Tab close)
//   <ItemTypeLegend> the legend of the functions page
import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from './Icon.jsx';
import { ITEM_TYPES } from '../lib/itemRules.js';

export const typeIcon = type => (type === 'report' ? 'item_report' : 'item_function');

export function TypeBadge({ type, compact = false }) {
  const { t } = useI18n();
  const tp = type === 'report' ? 'report' : 'function';
  return (
    <span className={'it-chip it-' + tp + (compact ? ' compact' : '')} title={t('it_hint_' + tp)}>
      <Icon name={typeIcon(tp)} size={13} /><span className={compact ? 'sr-only' : ''}>{t('it_' + tp)}</span>
    </span>
  );
}

export function ItemTypeChip({ type, code, editable, onChange }) {
  const { t } = useI18n();
  const tp = type === 'report' ? 'report' : 'function';
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(ITEM_TYPES.indexOf(tp));
  const btn = useRef(null), menu = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const away = e => { if (!menu.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => { if (open) menu.current?.querySelectorAll('[role=menuitemradio]')[active]?.focus(); }, [open, active]);

  if (!editable) {
    return (
      <span className={'it-chip it-' + tp} role="img" aria-label={t('it_static_aria', { type: t('it_' + tp) })} title={t('it_hint_' + tp)}>
        <Icon name={typeIcon(tp)} size={13} /><span aria-hidden="true">{t('it_' + tp)}</span>
      </span>
    );
  }
  const show = i => { setActive(i); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };
  const choose = v => { close(); if (v !== tp) onChange(v); };
  const onBtnKey = e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show(ITEM_TYPES.indexOf(tp)); }
  };
  const onMenuKey = e => {
    const n = ITEM_TYPES.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => (i + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => (i - 1 + n) % n); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
  };
  return (
    <span className="it-wrap">
      <button ref={btn} type="button" className={'it-chip it-btn it-' + tp} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} aria-label={t('it_button_aria', { code, type: t('it_' + tp) })} title={t('it_hint_' + tp)}
        onClick={() => (open ? close() : show(ITEM_TYPES.indexOf(tp)))} onKeyDown={onBtnKey}>
        <Icon name={typeIcon(tp)} size={13} /><span aria-hidden="true">{t('it_' + tp)}</span>
        <svg className="it-caret" width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 2.5 4 5.5 7 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      {open && (
        <span ref={menu} id={menuId} role="menu" className="it-menu" aria-label={t('it_menu_label', { code })} onKeyDown={onMenuKey}>
          {ITEM_TYPES.map((v, i) => (
            <button key={v} type="button" role="menuitemradio" aria-checked={v === tp} tabIndex={i === active ? 0 : -1}
              className={'it-opt it-' + v + (v === tp ? ' on' : '')} onClick={() => choose(v)} onMouseEnter={() => setActive(i)}>
              <span className="it-opt-icon"><Icon name={typeIcon(v)} size={15} /></span>
              <span className="it-opt-text"><b>{t('it_' + v)}</b><span>{t(v === 'report' ? 'it_legend_report_none' : 'it_legend_function')}</span></span>
              {v === tp && <Icon name="check" size={14} className="it-opt-tick" />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function ItemTypeLegend({ reportsShare }) {
  const { t } = useI18n();
  const rw = reportsShare > 0 ? Math.round(reportsShare * 1000) / 10 + '%' : null;
  return (
    <div className="it-legend" role="note" aria-label={t('it_legend')}>
      <span className="it-legend-title">{t('it_legend')}:</span>
      <span className="it-legend-item"><TypeBadge type="function" /> <span>{t('it_legend_function')}</span></span>
      <span className="it-legend-item"><TypeBadge type="report" /> <span>{rw ? t('it_legend_report', { rw: '⁦' + rw + '⁩' }) : t('it_legend_report_none')}</span></span>
    </div>
  );
}
