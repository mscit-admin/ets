// Dashboard «نظرة عامة على المستخدمين» / Users overview (1.12.9). Shown only to system administrators — the
// caller (pages/Dashboard.jsx) renders it solely when the viewer holds 'usr', and the endpoint it reads
// (GET /api/dashboard/users-overview) is itself gated by 'usr' + the admin role, so a reader without it never
// sees the section nor the data. Replaces the old bottom departments grid, whose purpose the top ERP wheel
// already serves.
//
// One combined «المستخدمون» / Users KPI card (headline figures: total, active, online, disabled, deleted), a bar
// chart (scoped users per department) and four donuts (by role, account status, presence, two-factor auth), all
// built from the screen's own palette — the ERP-wheel navy and the indicator-pill colours (styles/app.css). Every
// slice / bar carries an SVG <title> tooltip (label · count · %), and the figures / slices that map to a Users
// view are links (KPI online → /users?tab=online, deleted → /users?tab=deleted; role / status → /users).
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { useLiveUpdates } from '../lib/live.js';
import { pc } from '../lib/format.js';
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

// Distinct, readable fills drawn from the existing screen palette (ERP-wheel navy + indicator-pill tones).
const ROLE_FILLS = ['#24508a', '#2a78d6', '#30a66d', '#f0883a', '#6e46c6', '#0f7c8c', '#e24c4c', '#a07b07', '#7c7c7c'];
const DEPT_FILL = '#24508a';   // ERP-wheel navy (lib/wheelGeometry.js FILLS)

// Horizontal bars in the ProgressBar style: width relative to the largest count; tooltip on hover.
function DeptBars({ departments }) {
  const { t, nm } = useI18n();
  const max = Math.max(1, ...departments.map(d => d.count));
  const totalScoped = departments.reduce((a, d) => a + d.count, 0);
  if (!departments.length) return <p className="muted small">{t('uo_empty')}</p>;
  return (
    <ul className="ubar-list">
      {departments.map(d => {
        const tip = `${nm(d)}: ${d.count} (${pc(totalScoped ? (d.count / totalScoped) * 100 : 0)}%)`;
        return (
          <li key={d.id} className="ubar-row" title={tip}>
            <span className="ubar-name">{nm(d)}</span>
            <span className="ubar-track" aria-hidden="true">
              <i className="ubar-fill" style={{ width: (d.count / max) * 100 + '%', background: DEPT_FILL }} />
            </span>
            <b className="num ubar-val">{d.count}</b>
          </li>
        );
      })}
    </ul>
  );
}

export function UsersOverview() {
  const { t, nm } = useI18n();
  const ov = useLoad(o => api.get('/dashboard/users-overview', o), []);
  useLiveUpdates(() => ov.refresh());
  const { data, error, loading } = ov;
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const roleSegs = data.roles.map((r, i) => ({ key: r.id, label: nm(r), value: r.count, color: ROLE_FILLS[i % ROLE_FILLS.length], href: '/users' }));
  const statusSegs = [
    { key: 'active', label: t('active'), value: data.active, color: '#30a66d', href: '/users' },
    { key: 'inactive', label: t('inactive'), value: data.inactive, color: '#f0883a', href: '/users' },
    { key: 'deleted', label: t('uo_deleted'), value: data.deleted, color: '#7c7c7c', href: '/users?tab=deleted' },
  ];
  const presenceSegs = [
    { key: 'online', label: t('uo_online'), value: data.online, color: '#30a66d', href: '/users?tab=online' },
    { key: 'offline', label: t('uo_offline'), value: data.offline, color: '#c7c7c7' },
  ];
  // Two-factor authentication: no 2FA filter on the Users screen, so these slices are display-only (no href).
  const tfaSegs = [
    { key: 'on', label: t('tfa_on'), value: data.tfa.enabled, color: '#30a66d' },
    { key: 'exempt', label: t('tfa_exempt'), value: data.tfa.exempt, color: '#f0883a' },
    { key: 'off', label: t('tfa_off'), value: data.tfa.off, color: '#7c7c7c' },
  ];

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
      <div className="uo-grid">
        <Card className="uo-bars">
          <h4 className="donut-title">{t('users_by_dept')}</h4>
          <DeptBars departments={data.departments} />
        </Card>
        <Card><Donut title={t('users_by_role')} segments={roleSegs} /></Card>
        <Card><Donut title={t('users_by_status')} segments={statusSegs} /></Card>
        <Card><Donut title={t('users_presence_title')} segments={presenceSegs} /></Card>
        <Card><Donut title={t('two_fa')} segments={tfaSegs} /></Card>
      </div>
    </section>
  );
}
