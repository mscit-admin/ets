import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Icon } from './Icon.jsx';
import { useLoad } from './ui.jsx';

function Navbar({ onMenu }) {
  const { t, lang, setLang, nm } = useI18n();
  const { user, me, logout } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    const h = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const switchLang = async () => {
    const l = lang === 'ar' ? 'en' : 'ar';
    setLang(l);
    api.put('/auth/language', { language: l }).catch(() => {});
  };
  const initials = (user?.full_name || user?.username || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('');

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <button className="btn-icon only-mobile" onClick={onMenu} aria-label="menu"><Icon name="menu" size={18} /></button>
        <NavLink to="/" className="brand">
          <img src="/favicon.svg" alt="" width="26" height="26" />
          <span className="brand-name">{nm({ name_ar: me?.org_name_ar, name_en: me?.org_name_en }) || t('app_title')}</span>
        </NavLink>
        <form className="nav-search" onSubmit={e => { e.preventDefault(); if (q.trim().length >= 2) nav('/search?q=' + encodeURIComponent(q.trim())); }}>
          <Icon name="search" size={15} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder={t('search_placeholder')} aria-label={t('search_placeholder')} />
        </form>
        <div className="nav-right">
          <button className="btn btn-sm btn-ghost" onClick={switchLang} title={t('language')}>
            <Icon name="globe" size={15} /> <span className="hide-mobile">{t('lang_switch')}</span>
          </button>
          <div className="dropdown" ref={menuRef}>
            <button className="avatar" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open} title={user?.full_name}>
              {initials}
            </button>
            {open && (
              <div className="dropdown-menu" role="menu">
                <div className="dropdown-head">
                  <b>{user?.full_name}</b>
                  <span>{user?.username} · {nm(user, 'role_name')}</span>
                </div>
                <button role="menuitem" onClick={() => { setOpen(false); nav('/profile'); }}><Icon name="user" /> {t('nav_profile')}</button>
                <button role="menuitem" onClick={() => { setOpen(false); logout(); }}><Icon name="logout" /> {t('logout')}</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

function Sidebar({ open, onClose }) {
  const { t, nm } = useI18n();
  const { can, user } = useAuth();
  const { data } = useLoad(() => api.get('/tracker/summary'), []);
  const loc = useLocation();
  useEffect(() => { onClose(); }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (to, icon, label, end) => (
    <NavLink to={to} end={end} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
      <Icon name={icon} size={16} /><span>{label}</span>
    </NavLink>
  );
  const admin = can('usr') || can('log') || can('cfg');
  return (
    <>
      <div className={'side-overlay' + (open ? ' show' : '')} onClick={onClose} />
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="side-section">
          <div className="side-label">{t('nav_tracker')}</div>
          {link('/', 'home', t('nav_home'), true)}
          {link('/weights', 'scale', t('nav_weights'))}
          {link('/reports', 'report', t('nav_reports'))}
          {link('/schedule', 'curve', t('nav_schedule'))}
        </div>
        <div className="side-section">
          <div className="side-label">{t('departments')}</div>
          {(data?.departments || []).map(d => (
            <NavLink key={d.id} to={'/department/' + d.id} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')}>
              <Icon name={d.emblem} size={16} /><span>{nm(d, 'short')}</span>
              <span className="side-dot" style={{ background: d.color }} />
            </NavLink>
          ))}
        </div>
        {admin && (
          <div className="side-section">
            <div className="side-label">{t('nav_admin')}</div>
            {can('usr') && link('/users', 'users', t('nav_users'))}
            {can('log') && link('/logs', 'logs', t('nav_logs'))}
            {can('cfg') && user?.fullScope && link('/settings', 'settings', t('nav_settings'))}
          </div>
        )}
        <div className="side-section">
          {link('/profile', 'user', t('nav_profile'))}
        </div>
      </aside>
    </>
  );
}

export default function Layout() {
  const [open, setOpen] = useState(false);
  return (
    <div className="app-shell">
      <Navbar onMenu={() => setOpen(o => !o)} />
      <div className="app-body">
        <Sidebar open={open} onClose={() => setOpen(false)} />
        <main className="main"><Outlet /></main>
      </div>
    </div>
  );
}
