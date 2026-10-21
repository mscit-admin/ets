// Profile page (1.9.0): «التنبيهات» — the types this user may receive, muted in-app / on the phone (mandatory types
// locked), daily summaries on/off; «أجهزتي» — phones paired with the account: pairing QR (after the password, and a
// 2FA / recovery code when 2FA is on), list, revoke.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, path } from '../lib/api.js';
import { Alert, Card, Field, Indicator, Loading, Modal, toast, useLoad } from './ui.jsx';
import { Icon } from './Icon.jsx';
import { QrCode } from './QrCode.jsx';
import { PREF_CATS as CATS, prefFlip, prefLockKey, prefLocked, prefOn, prefPhoneShown } from '../lib/notifyTabs.js';


export function NotifyPrefsCard() {
  const { t, errText } = useI18n();
  const { data, error, reload } = useLoad(() => api.get('/notifications/prefs'), []);
  const [busy, setBusy] = useState(false);
  const scrolled = useRef(false);
  useEffect(() => {
    if (data && !scrolled.current && window.location.hash === '#notifications') { scrolled.current = true; document.getElementById('notifications')?.scrollIntoView(); }
  }, [data]);
  if (error) return <Card title={t('notifications')}><Alert>{errText(error)}</Alert></Card>;
  if (!data) return <Card title={t('notifications')}><Loading /></Card>;
  const save = async body => {
    setBusy(true);
    try { await api.put('/notifications/prefs', body); toast(t('saved')); reload(); } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };
  const flip = (k, type, on) => save(prefFlip(data.types, k, type, on));
  return (
    <section id="notifications">
      <Card title={t('notifications')} actions={<span className="muted small">{t('notif_prefs_hint')}</span>}>
        <label className="check strong"><input type="checkbox" checked={data.digest} disabled={busy} onChange={e => save({ digest: e.target.checked })} /> {t('notif_digest')}</label>
        <div className="field-hint mt-s">{t('notif_digest_hint')}</div>
        {!data.types.length ? <p className="muted">{t('notif_no_types')}</p> : (
          <div className="matrix-wrap mt">
            <table className="matrix pref-table">
              <thead><tr><th>{t('notif_type')}</th><th>{t('notif_in_app')}</th><th>{t('notif_phone')}</th></tr></thead>
              <tbody>
                {CATS.filter(c => data.types.some(x => x.category === c)).map(c => [
                  <tr key={c} className="cat"><td colSpan={3}>{t('ncat_' + c)}</td></tr>,
                  ...data.types.filter(x => x.category === c).map(x => {
                    const lockedWhy = prefLockKey(x) && t(prefLockKey(x));
                    return (
                      <tr key={x.type}>
                        <td>{t('nt_' + x.type)}{x.mandatory && <> <Indicator color="gray" title={t('notif_mandatory_role')}><Icon name="lock" size={11} /> {t('notif_mandatory')}</Indicator></>}
                          {x.digest && <span className="muted small"> · {t('notif_summary')}</span>}</td>
                        <td><input type="checkbox" aria-label={t('notif_in_app') + ': ' + t('nt_' + x.type)} title={lockedWhy || ''}
                          checked={prefOn(x, 'muted')} disabled={busy || prefLocked(x, 'muted')} onChange={e => flip('muted', x.type, e.target.checked)} /></td>
                        <td>{!prefPhoneShown(x) ? <span className="na" title={t('notif_phone_off_policy')}>—</span> : (
                          <input type="checkbox" aria-label={t('notif_phone') + ': ' + t('nt_' + x.type)} checked={prefOn(x, 'mobile_muted')}
                            disabled={busy || prefLocked(x, 'mobile_muted')} onChange={e => flip('mobile_muted', x.type, e.target.checked)} />)}</td>
                      </tr>
                    );
                  }),
                ])}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </section>
  );
}

export function DevicesCard() {
  const { t, errText, fmtDate } = useI18n();
  const { user } = useAuth();
  const { data, reload } = useLoad(() => api.get('/devices'), []);
  const [ask, setAsk] = useState(false);
  const [pw, setPw] = useState(''), [code, setCode] = useState(''), [err, setErr] = useState(null);
  const [pair, setPair] = useState(null);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!pair) return undefined;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(pair.expires_at) - Date.now()) / 1000)));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, [pair]);
  const needCode = user.totp_enabled;
  const closeAsk = () => { setAsk(false); setPw(''); setCode(''); setErr(null); };
  const start = async () => {
    setErr(null);
    const second = !needCode ? {} : /^\d{6}$/.test(code.trim()) ? { code: code.trim() } : { recovery_code: code.trim() };
    try { setPair(await api.post('/devices/pair-code', { password: pw, ...second })); closeAsk(); } catch (e) { setErr(e); }
  };
  const closePair = () => { setPair(null); reload(); };
  const revoke = async d => {
    if (!window.confirm(t('device_revoke_confirm', { name: d.name }))) return;
    try { await api.del(path`/devices/${d.id}`); toast(t('saved')); reload(); } catch (e) { toast(errText(e), 'red'); }
  };
  const devices = data?.devices || [];
  return (
    <Card title={t('my_devices')} actions={<button className="btn btn-primary btn-sm" onClick={() => setAsk(true)}><Icon name="plus" size={14} /> {t('device_pair')}</button>}>
      <p className="muted small">{t('devices_hint')}</p>
      {!data ? <Loading /> : !devices.length ? <p className="muted">{t('devices_none')}</p> : (
        <ul className="device-list">
          {devices.map(d => (
            <li key={d.id} className={'device-item' + (d.revoked_at ? ' revoked' : '')}>
              <Icon name="mobile" size={20} />
              <span className="grow">
                <b>{d.name}</b>
                <span className="muted small">{t('device_paired_at', { at: fmtDate(d.created_at) })} · {d.last_seen_at ? t('device_seen_at', { at: fmtDate(d.last_seen_at) }) : t('device_never_seen')}
                  {d.app_version ? <> · <span dir="ltr">v{d.app_version}</span></> : null}</span>
              </span>
              {d.revoked_at ? <Indicator color="gray">{t('device_revoked')} · {t('rr_' + d.revoke_reason)}</Indicator>
                : <button className="btn btn-default btn-sm" onClick={() => revoke(d)}>{t('device_revoke')}</button>}
            </li>
          ))}
        </ul>
      )}
      {ask && (
        <Modal title={t(needCode ? 'confirm_with_password_code' : 'confirm_with_password')} onClose={closeAsk}
          footer={<><button className="btn btn-default" onClick={closeAsk}>{t('cancel')}</button><button className="btn btn-primary" onClick={start}>{t('confirm')}</button></>}>
          {err && <Alert>{errText(err)}</Alert>}
          <p className="muted small">{t('device_pair_reauth')}</p>
          <Field label={t('password')}><input className="input" type="password" dir="ltr" autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} /></Field>
          {needCode && <Field label={t('code_or_recovery')}><input className="input otp" dir="ltr" autoComplete="one-time-code" value={code} placeholder="123456 / xxxx-xxxx-xxxx" onChange={e => setCode(e.target.value)} /></Field>}
        </Modal>
      )}
      {pair && (
        <Modal title={t('device_pair')} onClose={closePair}
          footer={<button className="btn btn-primary" onClick={closePair}>{t('done')}</button>}>
          <div className="qr-box">
            {left > 0 ? <QrCode value={pair.payload} label={t('device_qr_label')} /> : <Alert kind="orange">{t('device_code_expired')}</Alert>}
            <div className="muted small">{t('device_code_manual')}</div>
            <div className="pair-code">{pair.code}</div>
            <div className="small" role="timer" aria-live="off">{left > 0 ? t('device_code_left', { m: Math.floor(left / 60), s: String(left % 60).padStart(2, '0') }) : ''}</div>
            <ol className="small" style={{ textAlign: 'start', margin: 0 }}>
              <li>{t('device_step1')}</li><li>{t('device_step2')}</li><li>{t('device_step3')}</li>
            </ol>
          </div>
        </Modal>
      )}
    </Card>
  );
}
