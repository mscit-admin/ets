// Dashboard «نظرة عامة على المستخدمين» / Users overview. Shown only to system administrators — the caller
// (pages/Dashboard.jsx) renders it solely when the viewer holds 'usr', and the endpoint it reads
// (GET /api/dashboard/users-overview) is itself gated by 'usr' + the admin role, so a reader without it never
// sees the section nor the data.
//
// One combined «المستخدمون» / Users KPI card (headline figures: total, active, online, disabled, deleted) and a
// single donut whose dimension is chosen from a dropdown — users by department / by role, account status,
// presence, two-factor auth — all built from the screen's own palette (the ERP-wheel navy and the indicator-pill
// colours, styles/app.css). Every slice carries an SVG <title> tooltip (label · count · %), and the figures /
// slices that map to a view are links (KPI online → /users?tab=online, deleted → /users?tab=deleted; role /
// status → /users, a department slice → /department/{id}). The selected dimension is kept in component state and
// mirrored to the URL (?uo=<dim>) so a reload / shared link reopens the same breakdown.
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { useLiveUpdates } from '../lib/live.js';
import { Card, ErrorBox, Loading, useLoad } from './ui.jsx';
import { Donut } from './Donut.jsx';

// One headline figure inside the combined «المستخدمون» / Users KPI card: big number + short label, reusing the
// NumberCard typography (.nc-value / .nc-label) and its colour accents. When a figure maps to a Users view it is
// a link (same navigate-on-plain-click behaviour as the donut slices), otherwise it is display-only.
function Stat({ label, value, color, href }) {
  const navigate = useNavigate();
  const inner = (
    <>
      <div className={'nc-value ' + (color || '')}>{value}</div>
      <div className="nc-label">{label}</div>
    </>
  );
  return href
    ? <a className="uo-stat uo-stat-link" href={href}
         onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); navigate(href); }}>{inner}</a>
    : <div className="uo-stat">{inner}</div>;
}

// Distinct, readable fills drawn from the existing screen palette (ERP-wheel navy + indicator-pill tones). The
// same multi-colour set serves both the per-role and the per-department breakdowns.
const ROLE_FILLS = ['#24508a', '#2a78d6', '#30a66d', '#f0883a', '#6e46c6', '#0f7c8c', '#e24c4c', '#a07b07', '#7c7c7c'];

export function UsersOverview() {
  const { t, nm } = useI18n();
  const ov = useLoad(o => api.get('/dashboard/users-overview', o), []);
  useLiveUpdates(() => ov.refresh());
  const [params, setParams] = useSearchParams();
  const [dim, setDim] = useState(() => params.get('uo') || 'dept');
  const { data, error, loading } = ov;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  // Every breakdown reuses its existing slice definition (colours / labels / links). Departments were a bar chart
  // before; they become a donut here, coloured from the same multi-colour palette as the roles and linking to the
  // department page (/department/{id}, the route the dashboard's ERP-wheel rows already use).
  const dims = [
    {
      key: 'dept', title: t('users_by_dept'),
      segments: data.departments.map((d, i) => ({
        key: d.id, label: nm(d), value: d.count,
        color: ROLE_FILLS[i % ROLE_FILLS.length], href: '/department/' + encodeURIComponent(d.id),
      })),
    },
    {
      key: 'role', title: t('users_by_role'),
      segments: data.roles.map((r, i) => ({
        key: r.id, label: nm(r), value: r.count, color: ROLE_FILLS[i % ROLE_FILLS.length], href: '/users',
      })),
    },
    {
      key: 'status', title: t('users_by_status'),
      segments: [
        { key: 'active', label: t('active'), value: data.active, color: '#30a66d', href: '/users' },
        { key: 'inactive', label: t('inactive'), value: data.inactive, color: '#f0883a', href: '/users' },
        { key: 'deleted', label: t('uo_deleted'), value: data.deleted, color: '#7c7c7c', href: '/users?tab=deleted' },
      ],
    },
    {
      key: 'presence', title: t('users_presence_title'),
      segments: [
        { key: 'online', label: t('uo_online'), value: data.online, color: '#30a66d', href: '/users?tab=online' },
        { key: 'offline', label: t('uo_offline'), value: data.offline, color: '#c7c7c7' },
      ],
    },
    {
      // Two-factor authentication: no 2FA filter on the Users screen, so these slices are display-only (no href).
      key: 'tfa', title: t('two_fa'),
      segments: [
        { key: 'on', label: t('tfa_on'), value: data.tfa.enabled, color: '#30a66d' },
        { key: 'exempt', label: t('tfa_exempt'), value: data.tfa.exempt, color: '#f0883a' },
        { key: 'off', label: t('tfa_off'), value: data.tfa.off, color: '#7c7c7c' },
      ],
    },
  ];
  const current = dims.find(d => d.key === dim) || dims[0];
  const onPick = v => {
    setDim(v);
    setParams(p => { p.set('uo', v); return p; }, { replace: true });
  };

  return (
    <section className="users-overview" aria-label={t('users_overview')}>
      <h2 className="section-title">{t('users_overview')}</h2>
      <Card title={t('uo_summary')} className="uo-summary">
        <div className="uo-stats">
          <Stat label={t('total_users')} value={data.total} />
          <Stat label={t('active_users')} value={data.active} color="green" />
          <Stat label={t('nav_online')} value={data.online} color="blue" href="/users?tab=online" />
          <Stat label={t('inactive')} value={data.inactive} color="orange" />
          <Stat label={t('uo_deleted')} value={data.deleted} color="red" href="/users?tab=deleted" />
        </div>
      </Card>
      <Card className="uo-dim-card">
        <div className="uo-dim-head">
          <label className="uo-dim-label" htmlFor="uo-dim">{t('uo_breakdown')}</label>
          <select id="uo-dim" className="input input-sm uo-dim-select" value={current.key}
                  onChange={e => onPick(e.target.value)}>
            {dims.map(d => <option key={d.key} value={d.key}>{d.title}</option>)}
          </select>
        </div>
        <Donut key={current.key} title={current.title} segments={current.segments} />
      </Card>
    </section>
  );
}
