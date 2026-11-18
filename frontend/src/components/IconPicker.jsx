import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';

// A broad set of icons for departments (emblems) and applications, drawn from lib/iconPaths.js — software /
// infrastructure / delivery first, then general business icons. Shared by the structure screen's dialogs.
export const CATALOG_ICONS = [
  'server', 'database', 'cloud', 'network', 'cpu', 'code', 'terminal', 'monitor', 'mobile', 'wifi', 'plug', 'link',
  'shield', 'lock', 'key', 'layers', 'folder', 'deploy', 'rocket', 'wrench', 'sliders', 'factory', 'people', 'person',
  'coins', 'tag', 'crm', 'megaphone', 'briefcase', 'book', 'clipboard', 'chart', 'report', 'planning', 'target',
  'flag', 'check', 'pulse', 'curve', 'scale', 'note', 'filter', 'box', 'item_function', 'item_report', 'home', 'clock',
  'search', 'edit', 'circle'];

// A compact icon picker: a button showing the current icon that opens a small grid to choose from. The grid is
// rendered in a portal with fixed positioning (anchored to the button, flipping up near the bottom) so it is never
// clipped by a dialog or a table's overflow — the same approach as the row-actions menu.
export function IconPicker({ value, onChange, label, icons = CATALOG_ICONS }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const place = () => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const rtl = getComputedStyle(b).direction === 'rtl';
    const estH = 330;
    const up = r.bottom + estH > window.innerHeight && r.top > estH;
    setPos({
      top: up ? undefined : Math.round(r.bottom + 4),
      bottom: up ? Math.round(window.innerHeight - r.top + 4) : undefined,
      left: rtl ? undefined : Math.round(r.left),
      right: rtl ? Math.round(window.innerWidth - r.right) : undefined,
    });
  };
  useLayoutEffect(() => { if (open) place(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = e => { if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return; setOpen(false); };
    const onLeave = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onLeave);
    window.addEventListener('scroll', onLeave, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', onLeave); window.removeEventListener('scroll', onLeave, true); };
  }, [open]);
  return (
    <span className="icon-picker">
      <button ref={btnRef} type="button" className="btn-icon" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} aria-label={label}>
        <Icon name={value || 'circle'} size={18} />
      </button>
      {open && pos && createPortal(
        <div ref={popRef} className="icon-picker-pop" role="menu"
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right }}>
          {icons.map(n => (
            <button type="button" key={n} role="menuitemradio" aria-checked={n === value} aria-label={n}
              className={'icon-opt' + (n === value ? ' on' : '')} onClick={() => { onChange(n); setOpen(false); }}>
              <Icon name={n} size={18} />
            </button>
          ))}
        </div>, document.body)}
    </span>
  );
}
