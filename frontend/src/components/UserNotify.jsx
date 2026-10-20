// Users → a user's page (1.9.0): restrictions on this user's alerts (block only: every channel or the phone; a type
// mandatory in code for the user's role cannot be blocked on every channel; never on one's own account), and the
// user's phones, which an administrator can revoke.
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { Alert, Card, Indicator, toast, useLoad } from './ui.jsx';
import { Icon } from './Icon.jsx';

const CATS = ['approvals', 'tracking', 'plan', 'security', 'system'];

export function UserNotifyCard({ u, self, onChanged }) {
  const { t, errText, fmtDate } = useI18n();
  const meta = useLoad(() => api.get('/notifications/policy-meta'), []);
  const [blocks, setBlocks] = useState(u.notify_blocks || []);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBlocks(u.notify_blocks || []); }, [u.notify_blocks]);
  const has = (type, ch) => blocks.some(b => b.type === type && b.channel === ch);
  const flip = (type, ch, on) => setBlocks(on ? [...blocks, { type, channel: ch }] : blocks.filter(b => !(b.type === type && b.channel === ch)));
  const save = async () => {
    setBusy(true);
    try { await api.put(path`/users/${u.id}/notify-blocks`, { blocks }); toast(t('saved')); onChanged(); } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };
  const revoke = async d => {
    if (!window.confirm(t('device_revoke_confirm', { name: d.name }))) return;
    try { await api.del(path`/users/${u.id}/devices/${d.id}`); toast(t('saved')); onChanged(); } catch (e) { toast(errText(e), 'red'); }
  };
  const types = (meta.data?.types || []).filter(x => x.eligible.includes(u.role_id));
  const changed = JSON.stringify([...blocks].sort((a, b) => (a.type + a.channel).localeCompare(b.type + b.channel))) !== JSON.stringify(u.notify_blocks || []);
  return (
    <>
      <Card title={t('user_notify_blocks')} actions={!self && <button className="btn btn-primary btn-sm" disabled={busy || !changed} onClick={save}>{t('save')}</button>}>
        <p className="muted small">{t('user_notify_blocks_hint')}</p>
        {self ? <Alert kind="gray">{t('user_notify_blocks_self')}</Alert> : meta.error ? <Alert>{errText(meta.error)}</Alert> : (
          <div className="matrix-wrap">
            <table className="matrix pref-table">
              <thead><tr><th>{t('notif_type')}</th><th>{t('block_all')}</th><th>{t('block_phone')}</th></tr></thead>
              <tbody>
                <tr><th scope="row"><b>{t('block_every_type')}</b></th>
                  <td><input type="checkbox" checked={has('*', 'all')} onChange={e => flip('*', 'all', e.target.checked)} aria-label={t('block_every_type') + ' — ' + t('block_all')} /></td>
                  <td><input type="checkbox" checked={has('*', 'mobile')} onChange={e => flip('*', 'mobile', e.target.checked)} aria-label={t('block_every_type') + ' — ' + t('block_phone')} /></td></tr>
                {CATS.filter(c => types.some(x => x.category === c)).map(c => [
                  <tr key={c} className="cat"><td colSpan={3}>{t('ncat_' + c)}</td></tr>,
                  ...types.filter(x => x.category === c).map(x => {
                    const locked = x.locked.includes(u.role_id);
                    return (
                      <tr key={x.type}>
                        <th scope="row"><span className="code">{x.code}</span>{t('nt_' + x.type)}</th>
                        <td>{locked ? <span className="lock" title={t('notify_cell_locked')}><Icon name="lock" size={14} /></span>
                          : <input type="checkbox" checked={has(x.type, 'all')} onChange={e => flip(x.type, 'all', e.target.checked)} aria-label={t('nt_' + x.type) + ' — ' + t('block_all')} />}</td>
                        <td><input type="checkbox" checked={has(x.type, 'mobile')} onChange={e => flip(x.type, 'mobile', e.target.checked)} aria-label={t('nt_' + x.type) + ' — ' + t('block_phone')} /></td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title={t('user_devices')}>
        {!(u.devices || []).length ? <p className="muted">{t('devices_none')}</p> : (
          <ul className="device-list">
            {u.devices.map(d => (
              <li key={d.id} className={'device-item' + (d.revoked_at ? ' revoked' : '')}>
                <Icon name="mobile" size={20} />
                <span className="grow"><b>{d.name}</b>
                  <span className="muted small">{t('device_paired_at', { at: fmtDate(d.created_at) })} · {d.last_seen_at ? t('device_seen_at', { at: fmtDate(d.last_seen_at) }) : t('device_never_seen')}
                    {d.last_ip ? <> · <span dir="ltr">{d.last_ip}</span></> : null}</span></span>
                {d.revoked_at ? <Indicator color="gray">{t('device_revoked')} · {t('rr_' + d.revoke_reason)}</Indicator>
                  : <button className="btn btn-default btn-sm" onClick={() => revoke(d)}>{t('device_revoke')}</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
