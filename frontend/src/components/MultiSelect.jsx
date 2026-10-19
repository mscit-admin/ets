import { useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from './Icon.jsx';

// Searchable multi-select (ARIA 1.2 combobox + multi-selectable listbox), in the style of components/ui.jsx.
//   value     selected options (objects with an `id`)
//   onChange  (options) => void
//   load      (query, all) => Promise<options[]> — called when the list opens, the text changes or `all` is switched
//   renderOption (option) => node;  chipLabel (option) => string
//   allLabel  label of the "search every application" switch (omit to hide it)
// Keyboard: ↓/↑ move (and open), Home/End, Enter picks / unpicks the highlighted option, Esc closes the list (a second
// Esc reaches the dialog), Backspace in an empty search box removes the last chip.
export function MultiSelect({ value, onChange, load, renderOption, chipLabel, label, placeholder, allLabel, invalid, describedBy }) {
  const { t } = useI18n();
  const uid = useId();
  const listId = uid + '-list', inputId = uid + '-input';
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef(null), listRef = useRef(null), boxRef = useRef(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const selected = new Set(value.map(v => v.id));

  // load the options for the current text (debounced) while the list is open
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    const h = setTimeout(() => {
      loadRef.current(q.trim(), all).then(list => { if (alive) { setOpts(list); setActive(list.length ? 0 : -1); } })
        .catch(() => { if (alive) setOpts([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [q, all, open]);

  // close when focus / clicks leave the control
  useEffect(() => {
    if (!open) return;
    const away = e => { if (!boxRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // keep the highlighted option visible
  useEffect(() => {
    if (active < 0) return;
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const toggle = o => {
    onChange(selected.has(o.id) ? value.filter(v => v.id !== o.id) : [...value, o]);
    inputRef.current?.focus();
  };
  const remove = o => { onChange(value.filter(v => v.id !== o.id)); inputRef.current?.focus(); };

  const onKeyDown = e => {
    const n = opts.length;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true); else if (n) setActive(i => (i + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true); else if (n) setActive(i => (i <= 0 ? n - 1 : i - 1));
        break;
      case 'Home': if (open && n) { e.preventDefault(); setActive(0); } break;
      case 'End': if (open && n) { e.preventDefault(); setActive(n - 1); } break;
      case 'Enter':
        e.preventDefault();               // never submits the dialog
        if (open && active >= 0 && opts[active]) toggle(opts[active]); else setOpen(true);
        break;
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }   // the dialog stays open
        break;
      case 'Backspace':
        if (!q && value.length) { e.preventDefault(); remove(value[value.length - 1]); }
        break;
      default:
    }
  };

  const activeId = open && active >= 0 && opts[active] ? `${uid}-opt-${opts[active].id}` : undefined;
  return (
    <div className={'ms' + (invalid ? ' ms-invalid' : '')} ref={boxRef}>
      <div className="ms-head">
        <label className="field-label" htmlFor={inputId}>{label}</label>
        {allLabel && (
          <label className="check small">
            <input type="checkbox" checked={all} onChange={e => { setAll(e.target.checked); setOpen(true); inputRef.current?.focus(); }} /> {allLabel}
          </label>
        )}
      </div>
      <div className="ms-anchor">
        <div className={'ms-box' + (open ? ' open' : '')} onMouseDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); setOpen(true); } }}>
          <ul className="ms-chips" aria-label={t('ms_selected', { n: value.length })}>
            {value.map(o => (
              <li key={o.id} className="ms-chip">
                <span>{chipLabel(o)}</span>
                <button type="button" className="ms-chip-x" onClick={() => remove(o)} aria-label={t('ms_remove', { item: chipLabel(o) })} tabIndex={-1}>
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
          <input id={inputId} ref={inputRef} className="ms-input" type="text" role="combobox" autoComplete="off" spellCheck={false}
            aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-activedescendant={activeId}
            aria-invalid={invalid || undefined} aria-describedby={describedBy}
            placeholder={value.length ? '' : placeholder} value={q}
            onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
            onBlur={e => { if (!boxRef.current?.contains(e.relatedTarget)) setOpen(false); }} />
        </div>
        {open && (
          <ul id={listId} ref={listRef} className="ms-list" role="listbox" aria-multiselectable="true" aria-label={label}>
            {busy && !opts.length && <li className="ms-empty" role="presentation">{t('loading')}…</li>}
            {!busy && !opts.length && <li className="ms-empty" role="presentation">{t('ms_no_options')}</li>}
            {opts.map((o, i) => (
              <li key={o.id} id={`${uid}-opt-${o.id}`} data-i={i} role="option" aria-selected={selected.has(o.id)}
                className={'ms-opt' + (i === active ? ' active' : '') + (selected.has(o.id) ? ' selected' : '')}
                onMouseDown={e => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => toggle(o)}>
                <span className="ms-tick" aria-hidden="true">{selected.has(o.id) && <Icon name="check" size={13} />}</span>
                <span className="ms-opt-body">{renderOption(o)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="sr-only" aria-live="polite">{open && !busy ? t('ms_results', { n: opts.length }) : ''}</span>
    </div>
  );
}
