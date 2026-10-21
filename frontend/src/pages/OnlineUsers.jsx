// «المستخدمون المتصلون الآن» / "Online users" (1.11.0): system administrators only (route guard 'usr' + the API's
// admin check). Who is on the system, on which screen, since when; reloads every 15 s while the tab is visible (the
// reload carries X-ETS-Live: 1, so leaving the page open never keeps the administrator's own session alive).
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Card, Empty, ErrorBox, Indicator, Loading, NumberCard, PageHeader, toast, useLoad } from '../components/ui.jsx';

const POLL_MS = 15_000;
const SCREENS = ['dashboard', 'status', 'weights', 'schedule', 'reports', 'reports_dept', 'search', 'department', 'application',
  'imports', 'import', 'approvals', 'notifications', 'profile', 'users', 'user', 'online_users', 'logs', 'settings', 'unknown'];

/** 75 → "1 د 15 ث" / "1m 15s" (largest two units). */
export function fmtDuration(sec, t) {
  const s = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const u = (n, k) => t('ou_dur_' + k, { n });
  if (d) return `${u(d, 'd')} ${u(h, 'h')}`;
  if (h) return `${u(h, 'h')} ${u(m, 'm')}`;
  if (m) return `${u(m, 'm')} ${u(x, 's')}`;
  return u(x, 's');
}

function ScreenCell({ s, t, nm }) {
  const label = t('ou_scr_' + s.key);
  const name = nm(s, 'name');
  const dept = nm(s, 'dept');
  const text = <>{label}{name && <> — <b>{name}</b></>}{dept && s.key === 'application' && <span className="muted small"> · {dept}</span>}</>;
  return s.link ? <Link to={s.link} className="ou-screen">{text}</Link> : <span className="ou-screen">{text}</span>;
}

export default function OnlineUsers() {
  const { t, nm, fmtDate, errText } = useI18n();
  const { data, error, loading, refresh } = useLoad(o => api.get('/presence', o), []);
  const meta = useLoad(() => api.get('/users/meta'), []);
  const [f, setF] = useState({ role: '', dept: '', screen: '' });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(null);

  // live: every 15 s while visible, once on return to the tab; the clock ticks every second for the durations
  useEffect(() => {
    const poll = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const vis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', vis);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', vis); };
  }, [refresh]);

  // durations are measured on the server's clock (offset taken when the list arrived)
  const skew = useMemo(() => (data ? new Date(data.server_now).getTime() - Date.now() : 0), [data]);
  const since = ts => (now + skew - new Date(ts).getTime()) / 1000;

  const rows = useMemo(() => (data?.rows || []).filter(r =>
    (!f.role || r.user.role === f.role) &&
    (!f.dept || r.scope.full || r.scope.departments.includes(f.dept)) &&
    (!f.screen || r.screen.key === f.screen)), [data, f]);

  const end = async r => {
    if (!window.confirm(t('ou_end_confirm', { name: r.user.full_name || r.user.username }))) return;
    setBusy(r.session_ref);
    try {
      await api.post(path`/users/${r.user.id}/revoke-sessions`, { session_ref: r.session_ref });
      toast(t('ou_ended'));
      refresh();
    } catch (e) { toast(errText(e), 'red'); } finally { setBusy(null); }
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorBox error={error} />;
  const c = data.counts;
  const status = r => <Indicator color={r.status === 'online' ? 'green' : 'orange'}>{t('ou_' + r.status)}</Indicator>;
  const who = r => (
    <div className="ou-who">
      <b>{r.user.full_name || r.user.username}</b>{r.is_me && <span className="muted small"> ({t('ou_you')})</span>}
      <div className="muted small"><span dir="ltr">{r.user.username}</span> · {nm(r.user, 'role_name')}</div>
    </div>
  );
  const client = r => <>{t('ou_client_' + r.client)}{r.device && <div className="muted small" dir="ltr">{r.device}</div>}</>;
  const action = r => (r.is_me ? null : (
    <button className="btn btn-default btn-sm" disabled={busy === r.session_ref} onClick={() => end(r)}>
      <Icon name="logout" size={14} /> {t('ou_end_session')}
    </button>
  ));

  return (
    <div>
      <PageHeader title={t('ou_title')} sub={t('ou_sub')} icon="pulse" />
      <div className="grid-cards">
        <NumberCard label={t('ou_online')} value={c.online} color="green" />
        <NumberCard label={t('ou_idle')} value={c.idle} color={c.idle ? 'orange' : ''} />
        <NumberCard label={t('ou_sessions')} value={c.sessions} sub={t('ou_users_n', { n: c.users })} />
      </div>
      <Card>
        <div className="filter-bar">
          <select className="input input-sm" value={f.role} onChange={e => setF({ ...f, role: e.target.value })} aria-label={t('role')}>
            <option value="">{t('role')}: {t('all')}</option>
            {(meta.data?.roles || []).map(r => <option key={r.id} value={r.id}>{nm(r)}</option>)}
          </select>
          <select className="input input-sm" value={f.dept} onChange={e => setF({ ...f, dept: e.target.value })} aria-label={t('ou_filter_dept')}>
            <option value="">{t('ou_filter_dept')}: {t('all')}</option>
            {(meta.data?.departments || []).map(d => <option key={d.id} value={d.id}>{nm(d)}</option>)}
          </select>
          <select className="input input-sm" value={f.screen} onChange={e => setF({ ...f, screen: e.target.value })} aria-label={t('ou_screen')}>
            <option value="">{t('ou_screen')}: {t('all')}</option>
            {SCREENS.map(k => <option key={k} value={k}>{t('ou_scr_' + k)}</option>)}
          </select>
          <span className="muted small push"><Icon name="pulse" size={13} /> {t('ou_live_note')}</span>
        </div>
        {!rows.length ? <Empty>{t('ou_none')}</Empty> : (
          <>
            <div className="table-wrap ou-table">
              <table className="table list-view">
                <thead>
                  <tr>
                    <th>{t('ou_user')}</th><th>{t('status')} · {t('ou_last_activity')}</th><th>{t('ou_screen')}</th>
                    <th>{t('ou_on_screen')}</th><th>{t('ou_session')}</th><th>{t('ou_active_today')}</th>
                    <th>{t('ou_client')} · {t('ip')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.session_ref} className={r.status === 'idle' ? 'ou-idle' : ''}>
                      <td>{who(r)}</td>
                      <td>{status(r)}<div className="muted small">{t('ou_ago', { d: fmtDuration(since(r.last_seen), t) })}</div></td>
                      <td className="ou-screen-cell"><ScreenCell s={r.screen} t={t} nm={nm} /></td>
                      <td className="nowrap">{fmtDuration(since(r.screen_since), t)}</td>
                      <td className="ou-wrap"><span>{fmtDuration(since(r.login_at), t)}</span>
                        <div className="muted small">{t('ou_login_at')}: {fmtDate(r.login_at)}</div></td>
                      <td className="nowrap">{fmtDuration(r.active_today_s, t)}</td>
                      <td>{client(r)}{r.ip && <div className="muted small code" dir="ltr">{r.ip}</div>}</td>
                      <td>{action(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ou-cards">
              {rows.map(r => (
                <div key={r.session_ref} className={'ou-card' + (r.status === 'idle' ? ' ou-idle' : '')}>
                  <div className="ou-card-head">{who(r)}{status(r)}</div>
                  <div className="ou-card-screen"><ScreenCell s={r.screen} t={t} nm={nm} /></div>
                  <dl className="ou-kv">
                    <dt>{t('ou_on_screen')}</dt><dd>{fmtDuration(since(r.screen_since), t)}</dd>
                    <dt>{t('ou_session')}</dt><dd><span>{fmtDuration(since(r.login_at), t)}</span> · <span className="muted small">{fmtDate(r.login_at)}</span></dd>
                    <dt>{t('ou_last_activity')}</dt><dd>{t('ou_ago', { d: fmtDuration(since(r.last_seen), t) })}</dd>
                    <dt>{t('ou_active_today')}</dt><dd>{fmtDuration(r.active_today_s, t)}</dd>
                    <dt>{t('ou_client')}</dt><dd>{client(r)}</dd>
                    <dt>{t('ip')}</dt><dd><span dir="ltr" className="code">{r.ip || ''}</span></dd>
                  </dl>
                  {action(r)}
                </div>
              ))}
            </div>
          </>
        )}
        <p className="muted small ou-note">{t('ou_privacy_note')}</p>
      </Card>
    </div>
  );
}
