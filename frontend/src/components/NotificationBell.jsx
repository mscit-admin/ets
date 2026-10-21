// The bell in the top bar (1.9.0): unread count (red when a critical alert is unread, «99+» above 99), and a
// dropdown with the latest 20 alerts — category tabs, read / unread, mark all read, click to open the alert's page.
// The count follows the live stream ("notif_changed", lib/live.js); every list comes from the API, which applies
// the scope and policy rules (backend/src/services/notify.js). Keyboard: Escape closes, ↑ / ↓ move between alerts.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { useNotifStream } from '../lib/live.js';
import { Icon } from './Icon.jsx';

import { SEV_COLOR, SEV_ICON, TABS, inTab } from '../lib/notifyTabs.js';

export function useTimeAgo() {
  const { lang } = useI18n();
  return d => {
    const s = Math.round((new Date(d).getTime() - Date.now()) / 1000);
    const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar-LY-u-nu-latn' : 'en-GB', { numeric: 'auto', style: 'short' });
    const a = Math.abs(s);
    if (a < 60) return rtf.format(0, 'second');
    if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  };
}

// One alert row: severity icon, title, body, time, unread dot; onOpen when chosen, onToggle for read / unread;
// select: an optional checkbox in front (history page).
export function NotifRow({ n, onOpen, onToggle, compact, select = null }) {
  const { t } = useI18n();
  const ago = useTimeAgo();
  return (
    <li className={'notif-row' + (n.read ? '' : ' unread')}>
      {select}
      <button type="button" className="notif-main" onClick={() => onOpen(n)} data-notif-item>
        <span className={'notif-sev ' + SEV_COLOR[n.severity]} aria-hidden="true"><Icon name={SEV_ICON[n.severity]} size={14} /></span>
        <span className="notif-text">
          <span className="notif-title">{n.title}</span>
          {n.body && !compact && <span className="notif-body">{n.body}</span>}
          {n.body && compact && <span className="notif-body clamp">{n.body}</span>}
          <span className="notif-meta">{t('nt_' + n.type)} · <time dateTime={n.updated_at || n.created_at}>{ago(n.updated_at || n.created_at)}</time>
            {n.count > 1 && !compact ? <> · <span className="num">{n.count}</span></> : null}</span>
        </span>
        <span className="sr-only">{n.read ? t('notif_read') : t('notif_unread')}</span>
      </button>
      <button type="button" className={'notif-dot' + (n.read ? '' : ' on')} onClick={() => onToggle(n)}
        title={n.read ? t('mark_unread') : t('mark_read')} aria-label={n.read ? t('mark_unread') : t('mark_read')} />
    </li>
  );
}

export function NotificationBell() {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const [count, setCount] = useState({ unread: 0, top_severity: null });
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [tab, setTab] = useState('all');
  const ref = useRef(null), btn = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;

  const loadCount = useCallback(() => api.get('/notifications/count', { live: true }).then(setCount).catch(() => {}), []);
  const loadList = useCallback(() => api.get(`/notifications?limit=20&lang=${lang}`, { live: true }).then(d => setItems(d.items)).catch(() => setItems([])), [lang]);
  useEffect(() => { loadCount(); }, [loadCount]);
  useNotifStream(d => { setCount(d); if (openRef.current) loadList(); }, () => { loadCount(); if (openRef.current) loadList(); });
  useEffect(() => { if (open) loadList(); }, [open, loadList]);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const close = () => { setOpen(false); btn.current?.focus(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = [...(ref.current?.querySelectorAll('[data-notif-item]') || [])];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  };
  const toggle = async n => {
    try { await api.post(path`/notifications/${n.id}/${n.read ? 'unread' : 'read'}`); } catch { /* the list reloads */ }
    loadList(); loadCount();
  };
  const openItem = async n => {
    if (!n.read) api.post(path`/notifications/${n.id}/read`).then(loadCount).catch(() => {});
    setOpen(false);
    nav(n.link && n.link.startsWith('/') ? n.link : '/notifications');
  };
  const readAll = async () => { try { await api.post('/notifications/read-all'); } catch { /* reload anyway */ } loadList(); loadCount(); };

  const shown = (items || []).filter(n => inTab(tab, n));
  const badge = count.unread > 99 ? '99+' : String(count.unread);
  return (
    <div className="dropdown notif-bell" ref={ref} onKeyDown={onKey}>
      <button ref={btn} type="button" className="btn-icon bell-btn" onClick={() => setOpen(o => !o)} aria-haspopup="dialog" aria-expanded={open}
        aria-label={count.unread ? t('notif_bell_n', { n: badge }) : t('notifications')} title={t('notifications')}>
        <Icon name="bell" size={18} />
        {count.unread > 0 && <span className={'bell-badge' + (count.top_severity === 'critical' ? ' critical' : '')} aria-hidden="true">{badge}</span>}
      </button>
      {open && (
        <div className="dropdown-menu notif-menu" role="dialog" aria-label={t('notifications')}>
          <div className="notif-head">
            <b>{t('notifications')}</b>
            <button type="button" className="btn btn-xs btn-ghost" onClick={readAll} disabled={!count.unread}><Icon name="check" size={13} /> {t('mark_all_read')}</button>
          </div>
          <div className="notif-tabs" role="tablist" aria-label={t('notif_filter')}>
            {TABS.map(k => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={'notif-tab' + (tab === k ? ' on' : '')} onClick={() => setTab(k)}>
                {t('ncat_' + k)}
              </button>
            ))}
          </div>
          {items === null ? <div className="notif-empty">{t('loading')}</div> : !shown.length ? <div className="notif-empty">{t('notif_none')}</div> : (
            <ul className="notif-list">{shown.map(n => <NotifRow key={n.id} n={n} onOpen={openItem} onToggle={toggle} compact />)}</ul>
          )}
          <Link className="notif-all" to="/notifications" onClick={() => setOpen(false)}>{t('notif_view_all')} <Icon name="chevron" size={12} className="flip" /></Link>
        </div>
      )}
    </div>
  );
}
