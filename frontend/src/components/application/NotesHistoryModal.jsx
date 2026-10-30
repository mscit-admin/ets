import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { Alert, Loading, Modal } from '../ui.jsx';
import { Icon } from '../Icon.jsx';

// The note history popup (migration 031): the item's full, append-only list of notes shown as a chronological
// thread. Each note carries its body, author, timestamp and status icons — done / not-done (the author's flag),
// the team lead's decision («معتمدة للعمل» / «مرفوضة» / pending) and its deletion state; a rejected note is linked
// to the note that replaced it (indented follow-up). Controls appear by role: the author toggles done on their own
// notes; the team lead approves / rejects and approves deletions; anyone may request a deletion (it only takes
// effect after the lead approves). A box at the bottom appends a new note.
export function NotesHistoryModal({ f, can, userId, fmtDate, onClose, onChanged }) {
  const { t, errText } = useI18n();
  const [notes, setNotes] = useState(null);     // null = loading
  const [lead, setLead] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const [replacing, setReplacing] = useState(null);   // the rejected note being followed up { id, body }

  const load = useCallback(async () => {
    try {
      const r = await api.get(path`/tracker/functions/${f.id}/notes`);
      setNotes(r.notes || []);
      setLead(!!r.can?.lead);
    } catch (e) { setErr(e); }
  }, [f.id]);
  useEffect(() => { load(); }, [load]);

  // which note (if any) replaced a given rejected note — to link a rejected note to its follow-up
  const replacedBy = useMemo(() => {
    const m = {};
    for (const n of notes || []) if (n.replaces) m[n.replaces] = n.id;
    return m;
  }, [notes]);

  const act = async (fn) => {
    setBusy(true); setErr(null);
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setErr(e); }
    finally { setBusy(false); }
  };
  const addNote = () => act(async () => {
    const text = body.trim();
    if (!text) return;
    await api.post(path`/tracker/functions/${f.id}/notes`, { body: text, ...(replacing ? { replaces: replacing.id } : {}) });
    setBody(''); setReplacing(null);
  });
  const patchNote = (noteId, b) => act(() => api.patch(path`/tracker/notes/${noteId}`, b));

  return (
    <Modal title={t('notes_history_title')} onClose={onClose} wide
      footer={<button className="btn btn-default" onClick={onClose}>{t('close')}</button>}>
      <p className="muted small"><span className="code">{f.code}</span> <span lang="ar" dir="rtl">{f.name_ar}</span></p>
      {err && <Alert kind="red">{errText(err)}</Alert>}
      {notes === null ? <Loading /> : (
        <div className="notes-thread">
          {notes.length === 0 && <div className="empty">{t('notes_none')}</div>}
          {notes.map(n => {
            const rejected = n.decision === 'rejected';
            const approved = n.decision === 'approved';
            const deleted = !!n.deleted_at;
            const deleteRequested = !!n.delete_requested_at && !deleted;
            const isAuthor = n.author_id === userId;
            return (
              <div key={n.id} className={'note-card' + (n.replaces ? ' note-reply' : '') + (deleted ? ' note-deleted' : '')}>
                <div className="note-head">
                  <span className="note-status" title={n.done ? t('note_done') : t('note_not_done')}>
                    <Icon name={n.done ? 'check' : 'circle'} size={15} className={n.done ? 'ok' : 'muted'} />
                  </span>
                  <span className={'note-decision ' + (approved ? 'green' : rejected ? 'red' : 'muted')}>
                    {approved ? t('note_approved') : rejected ? t('note_rejected') : t('note_pending')}
                  </span>
                  <span className="note-author"><Icon name="user" size={13} /> {n.author_name || t('note_author_unknown')}</span>
                  <span className="note-time muted small">{fmtDate(n.created_at)}</span>
                </div>
                {n.replaces && <div className="note-replaces small muted">{t('note_replaces', { id: n.replaces })}</div>}
                <div className="note-body" dir="auto">{n.body}</div>
                {deleted && <div className="note-del-badge small"><Icon name="trash" size={12} /> {t('note_deleted_by', { name: n.deleted_by_name || '—' })}</div>}
                {deleteRequested && <div className="note-del-badge small muted"><Icon name="trash" size={12} /> {t('note_delete_requested', { name: n.delete_requested_by_name || '—' })}</div>}
                {!deleted && (
                  <div className="note-actions">
                    {isAuthor && <button className="btn btn-sm btn-default" disabled={busy} onClick={() => patchNote(n.id, { done: !n.done })}>
                      {n.done ? t('note_mark_undone') : t('note_mark_done')}</button>}
                    {lead && !n.decision && <>
                      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => patchNote(n.id, { decision: 'approved' })}>
                        <Icon name="check" size={13} /> {t('note_approve')}</button>
                      <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => patchNote(n.id, { decision: 'rejected' })}>
                        <Icon name="x" size={13} /> {t('note_reject')}</button>
                    </>}
                    {rejected && !replacedBy[n.id] && can.tst && <button className="btn btn-sm btn-default" disabled={busy} onClick={() => setReplacing({ id: n.id, body: n.body })}>
                      <Icon name="edit" size={13} /> {t('note_follow_up')}</button>}
                    {lead && deleteRequested && <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => patchNote(n.id, { approve_delete: true })}>
                      <Icon name="trash" size={13} /> {t('note_approve_delete')}</button>}
                    {!deleteRequested && <button className="btn btn-sm btn-default" disabled={busy} onClick={() => patchNote(n.id, { request_delete: true })}>
                      <Icon name="trash" size={13} /> {t('note_request_delete')}</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {can.tst && (
        <div className="note-add">
          {replacing && <Alert kind="blue">{t('note_following_up')} <button className="btn-link" onClick={() => setReplacing(null)}>{t('cancel')}</button></Alert>}
          <textarea className="input" rows={3} maxLength={2000} value={body} placeholder={t('note_add_placeholder')}
            onChange={e => setBody(e.target.value)} />
          <button className="btn btn-primary" disabled={busy || !body.trim()} onClick={addNote}>
            <Icon name="plus" size={14} /> {t('note_add')}</button>
        </div>
      )}
    </Modal>
  );
}
