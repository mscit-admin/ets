// A kebab (⋮) three-dots dropdown of row actions (ETS Application rows). One button that opens a menu
// of the row's actions. It opens on click, closes on outside-click and on Escape, and is keyboard
// navigable (↑ / ↓ move between items, Escape closes and returns focus to the button). Only one menu
// is open at a time: opening any menu's button fires the document mousedown that closes the others.
//
// The menu list is rendered in a portal and positioned with fixed coordinates anchored to the button,
// so the functions table's horizontal scroll (.table-wrap { overflow-x: auto }) never clips it, and it
// aligns to the button's inline edge (flipping with the writing direction — logical, RTL / LTR).
//
// items: [{ key, icon?, label, onClick, danger? }]. With no items the whole menu renders nothing, so
// a row with no available action shows no ⋮ button.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon.jsx';

export function Menu({ label, items }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const place = () => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const rtl = getComputedStyle(b).direction === 'rtl';
    const estH = items.length * 40 + 12;                 // flip above the button when it would overflow the viewport
    const up = r.bottom + estH > window.innerHeight && r.top > estH;
    setPos({
      top: up ? undefined : Math.round(r.bottom + 6),
      bottom: up ? Math.round(window.innerHeight - r.top + 6) : undefined,
      // align the menu's inline edge to the button, in logical terms (inline-end in LTR, inline-start mirrors in RTL)
      left: rtl ? Math.round(r.left) : undefined,
      right: rtl ? undefined : Math.round(window.innerWidth - r.right),
    });
  };

  useLayoutEffect(() => { if (open) place(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const onDown = e => {
      if (btnRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onLeave = () => setOpen(false);               // a scroll or resize would strand the fixed menu — close it
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onLeave);
    window.addEventListener('scroll', onLeave, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('scroll', onLeave, true);
    };
  }, [open]);

  // move focus into the menu when it opens (keyboard users land on the first item)
  useEffect(() => { if (open && pos) menuRef.current?.querySelector('[data-menu-item]')?.focus(); }, [open, pos]);

  const close = () => { setOpen(false); btnRef.current?.focus(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = [...(menuRef.current?.querySelectorAll('[data-menu-item]') || [])];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  };

  if (!items.length) return null;
  return (
    <div className="dropdown row-menu" onKeyDown={onKey}>
      <button ref={btnRef} type="button" className="btn-icon row-menu-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label={label} title={label} onClick={() => setOpen(o => !o)}>
        <Icon name="dots" size={18} />
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="dropdown-menu row-menu-list" role="menu" aria-label={label} onKeyDown={onKey}
          style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right }}>
          {items.map(it => (
            <button key={it.key} type="button" role="menuitem" data-menu-item
              className={'row-menu-item' + (it.danger ? ' danger' : '')}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon ? <Icon name={it.icon} size={15} /> : <span className="row-menu-noicon" aria-hidden="true" />}
              <span>{it.label}</span>
            </button>
          ))}
        </div>, document.body)}
    </div>
  );
}
