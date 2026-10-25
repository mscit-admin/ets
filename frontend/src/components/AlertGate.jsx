// Mandatory-alert gate (1.12.29): a global, app-level block. When the signed-in user has an ALERT («تنبيه») they
// have not yet responded to, a BLOCKING modal appears in front of the whole app — no X, no backdrop dismiss, no
// Escape. The user MUST choose a response status (and may add a note) to continue. Pending alerts are shown one at a
// time; after responding we fetch the next until none remain.
//
// Delivery: checked on load (mount) AND live — it reacts to the notification SSE stream (a new `alert_received`
// fires a `notif_changed` event via the same mechanism the bell uses), and polls as a backup. Robust against network
// errors: a failed check or submit never lets the user bypass a truly-pending alert (the modal stays, with a retry);
// it only ever blocks when the server positively returned a pending alert.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { useNotifStream } from '../lib/live.js';
import { Icon } from './Icon.jsx';
import { Modal, toast } from './ui.jsx';

const POLL_MS = 45000;

export default function AlertGate() {
  const { t, errText, fmtDate } = useI18n();
  const [alert, setAlert] = useState(null);     // the pending alert, or null
  const [status, setStatus] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const seq = useRef(0);

  // Ask the server for the next pending alert. Ignores stale answers. A network error while nothing is shown leaves
  // the app unblocked (we only block on a positive answer); while an alert IS shown it is surfaced as a retry.
  const check = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await api.get('/messages/pending-alert');
      if (my !== seq.current) return;
      setErr(null);
      setAlert(prev => {
        const next = d.alert || null;
        if (!next || !prev || prev.thread_id !== next.thread_id) { setStatus(''); setNote(''); }
        return next;
      });
    } catch (e) {
      if (my !== seq.current) return;
      setErr(e);     // if an alert is already shown this becomes a retry; otherwise harmless
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  // live: any notification change may be a new alert → re-check. Both the per-event count and the resync callback.
  useNotifStream(() => check(), () => check());
  // backup poll in case a live signal was missed
  useEffect(() => {
    const id = setInterval(() => { check(); }, POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  if (!alert) return null;

  const submit = async () => {
    if (!status || busy) return;
    setBusy(true);
    try {
      await api.post(path`/messages/threads/${alert.thread_id}/respond`, { status, note: note.trim() || undefined });
      setErr(null);
      await check();     // loop to the next pending alert, or clear the gate
    } catch (e) {
      setErr(e);
      toast(errText(e), 'red');
    }
    setBusy(false);
  };

  return (
    <Modal title={t('alert_popup_title')} blocking footer={
      <>
        <span className="msg-count">{t('alert_popup_hint')}</span>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={!status || busy}>
          <Icon name="check" size={14} /> {busy ? t('alert_submitting') : t('alert_submit')}
        </button>
      </>
    }>
      <div className="alert-gate">
        <div className="alert-gate-from">
          <Icon name="bell" size={16} /> {t('alert_from')}: <b>{alert.from_name}</b>
          {alert.created_at && <time className="muted small"> · {fmtDate(alert.created_at)}</time>}
        </div>
        {alert.subject && <h4 className="alert-gate-subject">{alert.subject}</h4>}
        <div className="alert-gate-body">{alert.body}</div>
        {err && <div className="alert red" style={{ marginTop: 12 }}>{errText(err)} <button className="btn btn-ghost btn-sm" onClick={check}>{t('alert_retry')}</button></div>}
        <label className="field-label" style={{ marginTop: 14 }}>{t('alert_response_label')}</label>
        <select className="input" value={status} onChange={e => setStatus(e.target.value)} aria-label={t('alert_response_label')}>
          <option value="" disabled>{t('alert_response_choose')}</option>
          <option value="ack">{t('alert_status_ack')}</option>
          <option value="working">{t('alert_status_working')}</option>
        </select>
        <label className="field-label" style={{ marginTop: 12 }}>{t('alert_note_label')}</label>
        <textarea className="input" rows={3} value={note} maxLength={4000} placeholder={t('alert_note_ph')}
          onChange={e => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
