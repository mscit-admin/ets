import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Card, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';

function TfaBadge({ u }) {
  const { t } = useI18n();
  if (u.totp_exempt) return <Indicator color="gray">{t('tfa_exempt')}</Indicator>;
  return u.totp_enabled ? <Indicator color="green">{t('tfa_on')}</Indicator> : <Indicator color="orange">{t('tfa_off')}</Indicator>;
}

export function UserList() {
  const { t, nm, errText, fmtDate } = useI18n();
  const { data, error, loading, reload } = useLoad(() => api.get('/users'), []);
  const [sel, setSel] = useState(new Set());
  const nav = useNavigate();
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const toggle = id => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const bulk = async (exempt, all) => {
    if (!window.confirm(t('are_you_sure'))) return;
    try {
      const r = await api.post('/users/bulk-2fa', all ? { all: true, exempt } : { user_ids: [...sel], exempt });
      toast(t('done_n', { n: r.updated })); setSel(new Set()); reload();
    } catch (e) { toast(errText(e), 'red'); }
  };

  return (
    <div>
      <PageHeader title={t('users_title')} icon="users">
        <button className="btn btn-primary btn-sm" onClick={() => nav('/users/new')}><Icon name="plus" size={14} /> {t('new_user')}</button>
      </PageHeader>
      <Card title={t('two_fa')} actions={<span className="muted small">{t('mfa_mode')}: <b>{t('mfa_' + data.mfa_mode)}</b></span>}>
        <div className="row gap wrap">
          <button className="btn btn-default btn-sm" onClick={() => bulk(true, true)}>{t('bulk_2fa_off_all')}</button>
          <button className="btn btn-default btn-sm" onClick={() => bulk(false, true)}>{t('bulk_2fa_on_all')}</button>
          <span className="sep-v" />
          <button className="btn btn-default btn-sm" disabled={!sel.size} onClick={() => bulk(true, false)}>{t('bulk_2fa_off_sel')}</button>
          <button className="btn btn-default btn-sm" disabled={!sel.size} onClick={() => bulk(false, false)}>{t('bulk_2fa_on_sel')}</button>
          {sel.size > 0 && <span className="muted small">{t('selected_n', { n: sel.size })}</span>}
        </div>
      </Card>
      <Card>
        <div className="table-wrap">
          <table className="table list-view">
            <thead>
              <tr>
                <th className="w-check"><input type="checkbox" aria-label={t('all')} checked={sel.size === data.users.length && data.users.length > 0}
                  onChange={e => setSel(e.target.checked ? new Set(data.users.map(u => u.id)) : new Set())} /></th>
                <th>{t('full_name')}</th><th>{t('username')}</th><th>{t('role')}</th><th>{t('status')}</th>
                <th>{t('two_fa')}</th><th className="hide-mobile">{t('scope')}</th><th className="hide-mobile">{t('last_login')}</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map(u => (
                <tr key={u.id}>
                  <td className="w-check"><input type="checkbox" checked={sel.has(u.id)} onChange={() => toggle(u.id)} aria-label={u.username} /></td>
                  <td><Link to={'/users/' + u.id}><b>{u.full_name}</b></Link></td>
                  <td dir="ltr" className="code">{u.username}</td>
                  <td>{nm(u, 'role_name')}</td>
                  <td>
                    {u.is_active ? <Indicator color="green">{t('active')}</Indicator> : <Indicator color="gray">{t('inactive')}</Indicator>}
                    {u.locked_until && new Date(u.locked_until) > new Date() && <> <Indicator color="red">{t('locked')}</Indicator></>}
                  </td>
                  <td><TfaBadge u={u} /></td>
                  <td className="hide-mobile">{u.role_full_scope ? t('full_scope') : u.scope_count || <Indicator color="red">{t('no_scope')}</Indicator>}</td>
                  <td className="hide-mobile muted small">{fmtDate(u.last_login_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// Keyed by id so that going from /users/new to /users/6 after saving starts with fresh state
// (otherwise the empty "new user" data is briefly treated as an existing user and the page crashes).
export function UserForm() {
  const { id } = useParams();
  return <UserFormInner key={id} id={id} />;
}

function UserFormInner({ id }) {
  const isNew = id === 'new';
  const { t, nm, errText, fmtDate } = useI18n();
  const { user: me } = useAuth();
  const nav = useNavigate();
  const meta = useLoad(() => api.get('/users/meta'), []);
  const usr = useLoad(() => (isNew ? Promise.resolve({ user: null }) : api.get('/users/' + id)), [id]);
  const [f, setF] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pwModal, setPwModal] = useState(false);

  useEffect(() => {
    if (!usr.data) return;
    const u = usr.data.user;
    setF(u ? {
      username: u.username, full_name: u.full_name, email: u.email || '', role_id: u.role_id, language: u.language,
      is_active: u.is_active, must_change_password: u.must_change_password, totp_exempt: u.totp_exempt,
      scopes: u.scopes, overrides: u.overrides,
    } : { username: '', full_name: '', email: '', role_id: 'obs', language: '', is_active: true, must_change_password: true,
      totp_exempt: false, scopes: [], overrides: [], password: '' });
  }, [usr.data]);

  if ((meta.loading && !meta.data) || (usr.loading && !usr.data) || !f) return meta.error || usr.error ? <ErrorBox error={meta.error || usr.error} /> : <Loading />;
  const m = meta.data, u = usr.data.user;
  const role = m.roles.find(r => r.id === f.role_id);
  const self = !isNew && u.id === me.id;                       // nobody widens their own permissions or scope
  const isAdminRole = f.role_id === 'admin';                   // 'usr' (user management) belongs to administrators only
  const hasScope = (kind, ref) => f.scopes.some(s => s.kind === kind && s.ref_id === ref);
  const toggleScope = (kind, ref) => setF({ ...f, scopes: hasScope(kind, ref) ? f.scopes.filter(s => !(s.kind === kind && s.ref_id === ref)) : [...f.scopes, { kind, ref_id: ref }] });
  const ov = p => f.overrides.find(o => o.permission === p);
  const setOv = (p, v) => {
    const rest = f.overrides.filter(o => o.permission !== p);
    setF({ ...f, overrides: v === '' ? rest : [...rest, { permission: p, granted: v === 'grant' }] });
  };

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...f, email: f.email || '' };
      if (!isAdminRole) body.overrides = f.overrides.filter(o => !(o.permission === 'usr' && o.granted));
      if (!body.language) delete body.language;   // the server applies Settings → default language
      if (isNew) {
        const r = await api.post('/users', body);
        toast(t('saved')); nav('/users/' + r.user.id, { replace: true });
      } else {
        delete body.password;
        await api.patch('/users/' + id, body);
        toast(t('saved')); usr.reload();
      }
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  const action = async (path, confirm = true) => {
    if (confirm && !window.confirm(t('are_you_sure'))) return;
    try { await api.post(`/users/${id}/${path}`); toast(t('saved')); usr.reload(); } catch (e) { toast(errText(e), 'red'); }
  };

  return (
    <div>
      <div className="breadcrumb"><Link to="/users">{t('nav_users')}</Link><Icon name="chevron" size={12} className="flip" /><span>{isNew ? t('new_user') : u.full_name}</span></div>
      <PageHeader title={isNew ? t('new_user') : u.full_name} sub={!isNew && <span dir="ltr">{u.username}</span>} icon="user">
        {!isNew && <>
          <button className="btn btn-default btn-sm" onClick={() => setPwModal(true)}>{t('reset_password')}</button>
          {u.totp_enabled && <button className="btn btn-default btn-sm" onClick={() => action('reset-2fa')}>{t('reset_2fa')}</button>}
          {u.locked_until && new Date(u.locked_until) > new Date() && <button className="btn btn-default btn-sm" onClick={() => action('unlock', false)}>{t('unlock')}</button>}
          {u.sessions.length > 0 && <button className="btn btn-default btn-sm" onClick={() => action('revoke-sessions')}>{t('revoke_sessions')}</button>}
        </>}
        <button className="btn btn-primary btn-sm" onClick={save} disabled={busy}>{busy ? t('saving') : t('save')}</button>
      </PageHeader>
      {err && <Alert>{errText(err)}</Alert>}

      <Card title={t('details')}>
        <div className="form-grid">
          <Field label={t('full_name')}><input className="input" value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label={t('username')}><input className="input" dir="ltr" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} /></Field>
          <Field label={t('email')}><input className="input" dir="ltr" type="email" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('language')}>
            <select className="input" value={f.language} onChange={e => setF({ ...f, language: e.target.value })}>{isNew && <option value="">{t('default_language')}</option>}<option value="ar">العربية</option><option value="en">English</option></select>
          </Field>
          {isNew && <Field label={t('password')} hint={t('password_hint')}><input className="input" dir="ltr" type="password" autoComplete="new-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} /></Field>}
        </div>
        <div className="checks">
          <label className="check"><input type="checkbox" checked={f.is_active} disabled={!isNew && u.id === me.id} onChange={e => setF({ ...f, is_active: e.target.checked })} /> {t('active')}</label>
          <label className="check"><input type="checkbox" checked={f.must_change_password} onChange={e => setF({ ...f, must_change_password: e.target.checked })} /> {t('must_change_pw_next')}</label>
          <label className="check"><input type="checkbox" checked={f.totp_exempt} disabled={self && !f.totp_exempt} onChange={e => setF({ ...f, totp_exempt: e.target.checked })} /> {t('exempt_2fa')}</label>
        </div>
        {self && <p className="muted small">{t('own_permissions_hint')}</p>}
        {!isNew && (
          <div className="kv mt">
            <div><span>{t('two_fa')}</span><TfaBadge u={u} />{u.totp_enabled && <span className="muted small"> {t('tfa_enabled_since', { date: fmtDate(u.totp_enabled_at) })} · {t('codes_left', { n: u.recovery_codes_left })}</span>}</div>
            <div><span>{t('last_login')}</span><span>{fmtDate(u.last_login_at)} <span dir="ltr" className="muted">{u.last_login_ip || ''}</span></span></div>
            <div><span>{t('active_sessions')}</span><span className="num">{u.sessions.length}</span></div>
          </div>
        )}
      </Card>

      <Card title={t('role')}>
        <div className="role-grid">
          {m.roles.map(r => (
            <label key={r.id} className={'role-opt' + (f.role_id === r.id ? ' on' : '')}>
              <input type="radio" name="role" checked={f.role_id === r.id} disabled={!isNew && u.id === me.id} onChange={() => setF({ ...f, role_id: r.id })} />
              <b>{nm(r)}</b><span className="muted small">{nm(r, 'description')}</span>
            </label>
          ))}
        </div>
      </Card>

      <Card title={t('permissions')}>
        <table className="table">
          <thead><tr><th>{t('permissions')}</th><th>{t('perm_from_role')}</th><th>{t('status')}</th></tr></thead>
          <tbody>
            {m.permissions.map(p => {
              const fromRole = role?.permissions.includes(p);
              const o = ov(p);
              const adminOnly = p === 'usr' && !isAdminRole;
              const eff = adminOnly ? false : o ? o.granted : fromRole;
              return (
                <tr key={p}>
                  <td>{t('perm_' + p)}</td>
                  <td>{fromRole ? <Icon name="check" size={15} className="green-text" /> : <span className="muted">—</span>}</td>
                  <td>
                    <select className="input input-sm" value={o && !(adminOnly && o.granted) ? (o.granted ? 'grant' : 'revoke') : ''} disabled={adminOnly}
                      onChange={e => setOv(p, e.target.value)}>
                      <option value="">{t('perm_from_role')}</option>
                      <option value="grant" disabled={self && !eff}>{t('perm_grant')}</option><option value="revoke">{t('perm_revoke')}</option>
                    </select>
                    {' '}{eff ? <Indicator color="green">✓</Indicator> : <Indicator color="gray">✗</Indicator>}
                    {adminOnly && <span className="muted small"> {t('usr_admin_only_hint')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <Card title={t('scope')} actions={<span className="muted small">{role?.full_scope ? t('full_scope') : t('scope_hint')}</span>}>
        {!role?.full_scope && !f.scopes.length && <Alert kind="orange">{t('scope_empty_warning')}</Alert>}
        <div className="scope-grid">
          {m.departments.map(d => (
            <div key={d.id} className="scope-dept">
              <label className="check strong"><input type="checkbox" checked={hasScope('department', d.id)} disabled={role?.full_scope || self} onChange={() => toggleScope('department', d.id)} /> {nm(d)}</label>
              <div className="scope-apps">
                {m.applications.filter(a => a.department_id === d.id).map(a => (
                  <label key={a.id} className="check"><input type="checkbox" disabled={role?.full_scope || self || hasScope('department', d.id)}
                    checked={hasScope('department', d.id) || hasScope('application', a.id)} onChange={() => toggleScope('application', a.id)} /> {nm(a)}</label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {pwModal && <ResetPassword id={id} onClose={() => setPwModal(false)} onDone={() => { setPwModal(false); usr.reload(); }} />}
    </div>
  );
}

function ResetPassword({ id, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [pw, setPw] = useState('');
  const [must, setMust] = useState(true);
  const [err, setErr] = useState(null);
  const run = async () => {
    try { await api.post(`/users/${id}/reset-password`, { password: pw, must_change: must }); toast(t('saved')); onDone(); }
    catch (e) { setErr(e); }
  };
  return (
    <Modal title={t('reset_password')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button><button className="btn btn-primary" onClick={run}>{t('save')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('new_password')} hint={t('password_hint')}><input className="input" type="password" dir="ltr" autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={must} onChange={e => setMust(e.target.checked)} /> {t('must_change_pw_next')}</label>
    </Modal>
  );
}
