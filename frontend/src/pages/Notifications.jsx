// /notifications — the user's alert history (1.9.0): filters (category, type, severity, unread), pages of 30,
// select several and mark them read, links to the preferences on the profile page.
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, qs } from '../lib/api.js';
import { useNotifStream } from '../lib/live.js';
import { Icon } from '../components/Icon.jsx';
import { Card, Empty, ErrorBox, Loading, PageHeader, toast } from '../components/ui.jsx';
import { NotifRow } from '../components/NotificationBell.jsx';
import { TABS } from '../lib/notifyTabs.js';

const TYPES = ['approval_pending', 'approval_overdue', 'request_decided', 'import_pending', 'import_result', 'import_overdue',
  'stuck', 'untested', 'failed_retest', 'pass_conflict', 'not_started', 'quality', 'excluded', 'moved_in',
  'dept_behind', 'dept_stalled', 'project_status', 'close_approaching',
  'account_locked', 'failed_logins', 'audit_integrity', 'email_index', 'access_denied', 'backup_missing', 'retention_reduced', 'server_errors',
  'backup_offsite', 'backup_verify', 'restore_event', 'rate_capped'];
const PAGE = 30;

export default function Notifications() {
  const { t, lang, errText } = useI18n();
  const nav = useNavigate();
  const [f, setF] = useState({ category: '', type: '', severity: '', unread: '' });
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(false);

  // "security" groups the security and system categories (as in the bell)
  const query = useCallback((before) => {
    const cat = f.category === 'all' ? '' : f.category;
    return api.get('/notifications' + qs({ limit: PAGE, lang, unread: f.unread, type: f.type, severity: f.severity,
      category: cat === 'security' ? '' : cat, before }), { live: true }).then(d => ({ ...d,
      items: cat === 'security' ? d.items.filter(n => n.category === 'security' || n.category === 'system') : d.items }));
  }, [f, lang]);
  const load = useCallback(() => {
    setErr(null);
    query().then(d => { setItems(d.items); setNext(d.next_before); setSel(new Set()); }).catch(e => { setErr(e); setItems([]); });
  }, [query]);
  useEffect(() => { setItems(null); load(); }, [load]);
  useNotifStream(() => load(), () => load());

  const more = async () => {
    setBusy(true);
    try { const d = await query(next); setItems(x => [...x, ...d.items]); setNext(d.next_before); } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };
  const toggle = async n => { try { await api.post(path`/notifications/${n.id}/${n.read ? 'unread' : 'read'}`); load(); } catch (e) { toast(errText(e), 'red'); } };
  const openItem = n => { if (!n.read) api.post(path`/notifications/${n.id}/read`).catch(() => {}); nav(n.link && n.link.startsWith('/') ? n.link : '/notifications'); };
  const markSel = async () => {
    try { const r = await api.post('/notifications/read-all', { ids: [...sel] }); toast(t('notif_marked', { n: r.marked })); load(); } catch (e) { toast(errText(e), 'red'); }
  };
  const markAll = async () => { try { await api.post('/notifications/read-all'); load(); } catch (e) { toast(errText(e), 'red'); } };
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const unreadShown = (items || []).filter(n => !n.read);

  return (
    <div className="notif-page">
      <PageHeader title={t('notifications')} sub={t('notif_page_sub')} icon="bell">
        <Link className="btn btn-default btn-sm" to="/profile#notifications"><Icon name="settings" size={14} /> {t('notif_prefs')}</Link>
        <button className="btn btn-default btn-sm" onClick={markAll}><Icon name="check" size={14} /> {t('mark_all_read')}</button>
      </PageHeader>
      <Card>
        <div className="notif-filters">
          <select className="input input-sm" value={f.category} onChange={e => set('category', e.target.value)} aria-label={t('notif_category')}>
            {TABS.map(k => <option key={k} value={k === 'all' ? '' : k}>{t('notif_category')}: {t('ncat_' + k)}</option>)}
          </select>
          <select className="input input-sm" value={f.type} onChange={e => set('type', e.target.value)} aria-label={t('notif_type')}>
            <option value="">{t('notif_type')}: {t('all')}</option>
            {TYPES.map(k => <option key={k} value={k}>{t('nt_' + k)}</option>)}
          </select>
          <select className="input input-sm" value={f.severity} onChange={e => set('severity', e.target.value)} aria-label={t('notif_severity')}>
            <option value="">{t('notif_severity')}: {t('all')}</option>
            {['critical', 'warning', 'info'].map(k => <option key={k} value={k}>{t('nsev_' + k)}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={f.unread === '1'} onChange={e => set('unread', e.target.checked ? '1' : '')} /> {t('notif_unread_only')}</label>
          <span className="push" />
          {unreadShown.length > 0 && (
            <label className="check"><input type="checkbox" checked={unreadShown.every(n => sel.has(n.id))}
              onChange={e => setSel(e.target.checked ? new Set(unreadShown.map(n => n.id)) : new Set())} /> {t('select_all')}</label>
          )}
          <button className="btn btn-primary btn-sm" disabled={!sel.size} onClick={markSel}>{t('mark_selected_read', { n: sel.size })}</button>
        </div>
        <ErrorBox error={err} />
        {items === null ? <Loading /> : !items.length ? <Empty>{t('notif_none')}</Empty> : (
          <ul className="notif-list">
            {items.map(n => (
              <NotifRow key={n.id} n={n} onOpen={openItem} onToggle={toggle} select={
                <input type="checkbox" className="notif-select" disabled={n.read} checked={sel.has(n.id)} aria-label={t('select') + ': ' + n.title}
                  onChange={e => setSel(s => { const x = new Set(s); e.target.checked ? x.add(n.id) : x.delete(n.id); return x; })} />} />
            ))}
          </ul>
        )}
        {next && <div className="row mt" style={{ justifyContent: 'center' }}><button className="btn btn-default btn-sm" disabled={busy} onClick={more}>{t('load_more')}</button></div>}
      </Card>
    </div>
  );
}
