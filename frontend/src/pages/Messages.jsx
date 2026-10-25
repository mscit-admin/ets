// /messages — in-app messaging (1.12.26). Everyone has an Inbox of private conversations; a user with the 'msg'
// permission also gets a «رسالة جديدة» compose button and a «المُرسَلة» view. A conversation is strictly 1:1
// between the sender and one recipient — a message sent to many people becomes a separate private thread each, and a
// recipient never sees another recipient's thread. The server enforces all of this; the UI mirrors it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { MultiSelect } from '../components/MultiSelect.jsx';
import { useTimeAgo } from '../components/NotificationBell.jsx';
import { Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { useAuth } from '../lib/auth.jsx';

const BODY_MAX = 4000;

// ---- Compose (msg only): individuals + everyone + by department + by role (combinable), with a live resolved count.
function Compose({ onClose, onSent }) {
  const { t, nm, errText } = useI18n();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [people, setPeople] = useState([]);           // selected individuals [{id, full_name, username}]
  const [all, setAll] = useState(false);
  const [depts, setDepts] = useState(new Set());
  const [roles, setRoles] = useState(new Set());
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: meta } = useLoad(() => api.get('/messages/compose-meta'), []);

  const audience = useCallback(() => ({
    all, users: people.map(p => p.id), depts: [...depts], roles: [...roles],
  }), [all, people, depts, roles]);

  // resolved recipient count, refreshed when the selection changes (ignores stale answers)
  const seq = useRef(0);
  useEffect(() => {
    const aud = audience();
    if (!aud.all && !aud.users.length && !aud.depts.length && !aud.roles.length) { setCount(0); return; }
    const my = ++seq.current;
    api.post('/messages/resolve', { audience: aud }).then(d => { if (my === seq.current) setCount(d.count); }).catch(() => {});
  }, [audience]);

  const loadPeople = (q) => api.get('/messages/recipients' + (q ? '?q=' + encodeURIComponent(q) : '')).then(d => d.recipients);
  const toggle = (set, setSet, id) => setSet(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const send = async () => {
    if (!body.trim() || !count) return;
    setBusy(true);
    try {
      const r = await api.post('/messages', { subject: subject.trim() || undefined, body: body.trim(), audience: audience() });
      toast(t('msg_sent_ok', { n: r.sent }));
      onSent();
    } catch (e) { toast(errText(e), 'red'); setBusy(false); }
  };

  return (
    <Modal title={t('msg_new_title')} onClose={onClose} wide footer={
      <>
        <span className="msg-count">{count ? t('msg_resolved_count', { n: count }) : t('msg_resolved_zero')}</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy || !body.trim() || !count}>
          <Icon name="out" size={14} /> {busy ? t('msg_sending') : t('msg_send')}
        </button>
      </>
    }>
      <p className="muted small">{t('msg_select_hint')}</p>
      <MultiSelect
        value={people} onChange={setPeople} load={loadPeople}
        label={t('msg_to_people')} placeholder={t('msg_search_people')}
        renderOption={o => <><b>{o.full_name}</b> <span className="muted">{o.username}</span></>}
        chipLabel={o => o.full_name || o.username}
      />
      <label className="check" style={{ marginTop: 10 }}>
        <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> {t('msg_everyone')}
      </label>
      {meta?.departments?.length > 0 && (
        <Field label={t('msg_by_dept')} className="msg-field">
          <div className="msg-chips">
            {meta.departments.map(d => (
              <label key={d.id} className={'msg-pick' + (depts.has(d.id) ? ' on' : '')}>
                <input type="checkbox" checked={depts.has(d.id)} onChange={() => toggle(depts, setDepts, d.id)} />
                {nm(d, 'short') || nm(d)}
              </label>
            ))}
          </div>
        </Field>
      )}
      {meta?.roles?.length > 0 && (
        <Field label={t('msg_by_role')} className="msg-field">
          <div className="msg-chips">
            {meta.roles.map(rr => (
              <label key={rr.id} className={'msg-pick' + (roles.has(rr.id) ? ' on' : '')}>
                <input type="checkbox" checked={roles.has(rr.id)} onChange={() => toggle(roles, setRoles, rr.id)} />
                {nm(rr)}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label={t('msg_subject')} className="msg-field">
        <input className="input" value={subject} maxLength={200} onChange={e => setSubject(e.target.value)} placeholder={t('msg_subject_ph')} />
      </Field>
      <Field label={t('msg_body')} className="msg-field">
        <textarea className="input" rows={6} value={body} maxLength={BODY_MAX} onChange={e => setBody(e.target.value)} placeholder={t('msg_body_ph')} />
      </Field>
    </Modal>
  );
}

// ---- Thread view: the full conversation (chat style, RTL correct) with a reply box.
function Thread({ id, onBack, onChanged }) {
  const { t, fmtDate, errText } = useI18n();
  const ago = useTimeAgo();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const load = useCallback(() => {
    setErr(null);
    api.get(path`/messages/threads/${id}`, { live: true }).then(d => { setData(d); onChanged?.(); }).catch(e => { setErr(e); setData(null); });
  }, [id, onChanged]);
  useEffect(() => { setData(null); load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [data]);

  const send = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try { await api.post(path`/messages/threads/${id}/reply`, { body: reply.trim() }); setReply(''); load(); }
    catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };

  if (err) return <Card><button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="chevron" size={14} /> {t('msg_back')}</button><ErrorBox error={err} /></Card>;
  if (!data) return <Loading />;
  const { thread, posts } = data;
  const other = thread.side === 'author' ? thread.recipient : thread.author;
  return (
    <Card className="msg-thread">
      <div className="msg-thread-head">
        <button className="btn btn-ghost btn-sm" onClick={onBack} aria-label={t('msg_back')}><Icon name="chevron" size={16} /></button>
        <div>
          <b>{thread.subject || t('msg_conversation')}</b>
          <div className="muted small">{t('msg_from')}: {other.full_name} · {other.username}</div>
        </div>
      </div>
      <ul className="msg-posts">
        {posts.map(p => (
          <li key={p.id} className={'msg-post' + (p.mine ? ' mine' : '')}>
            <div className="msg-post-meta">
              <span>{p.mine ? t('msg_you') : p.author_name}</span>
              <time dateTime={p.created_at} title={fmtDate(p.created_at)}>{ago(p.created_at)}</time>
            </div>
            <div className="msg-post-body">{p.body}</div>
          </li>
        ))}
        <li ref={endRef} />
      </ul>
      <div className="msg-reply">
        <textarea className="input" rows={2} value={reply} maxLength={BODY_MAX} placeholder={t('msg_reply_ph')}
          onChange={e => setReply(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <button className="btn btn-primary btn-sm" onClick={send} disabled={busy || !reply.trim()}>
          <Icon name="in" size={14} /> {busy ? t('msg_replying') : t('msg_send_reply')}
        </button>
      </div>
    </Card>
  );
}

function ThreadRow({ title, sub, time, unread, onOpen }) {
  const ago = useTimeAgo();
  return (
    <li className={'msg-row' + (unread ? ' unread' : '')}>
      <button className="msg-row-main" onClick={onOpen}>
        <span className="msg-row-text">
          <span className="msg-row-title">{title} {unread && <span className="msg-dot" aria-hidden="true" />}</span>
          {sub && <span className="msg-row-sub">{sub}</span>}
        </span>
        <time className="msg-row-time">{ago(time)}</time>
      </button>
    </li>
  );
}

// ---- Sent: broadcasts → drill into per-recipient threads.
function Sent({ onOpenThread }) {
  const { t } = useI18n();
  const [bid, setBid] = useState(null);
  const { data, loading, error } = useLoad(() => api.get('/messages/sent'), []);
  const drill = useLoad(() => (bid ? api.get(path`/messages/sent/${bid}`) : Promise.resolve(null)), [bid]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (bid) {
    if (drill.loading) return <Loading />;
    const d = drill.data;
    return (
      <Card>
        <div className="msg-thread-head">
          <button className="btn btn-ghost btn-sm" onClick={() => setBid(null)}><Icon name="chevron" size={16} /></button>
          <div><b>{d?.broadcast?.subject || d?.broadcast?.preview}</b>
            <div className="muted small">{t('msg_recipient_count', { n: d?.broadcast?.recipient_count || 0 })}</div></div>
        </div>
        {!d?.threads?.length ? <Empty>{t('msg_no_threads')}</Empty> : (
          <ul className="msg-list">
            {d.threads.map(th => (
              <ThreadRow key={th.id} title={th.recipient_name} sub={th.preview} time={th.last_post_at} unread={th.unread}
                onOpen={() => onOpenThread(th.id)} />
            ))}
          </ul>
        )}
      </Card>
    );
  }
  if (!data?.broadcasts?.length) return <Card><Empty>{t('msg_no_sent')}</Empty></Card>;
  return (
    <Card>
      <ul className="msg-list">
        {data.broadcasts.map(b => (
          <ThreadRow key={b.id} title={b.subject || b.preview} unread={b.unread_replies > 0} time={b.created_at}
            sub={`${t('msg_recipient_count', { n: b.recipient_count })} · ${t('msg_reply_count', { n: b.reply_count })}${b.unread_replies ? ' · ' + t('msg_unread_replies') : ''}`}
            onOpen={() => setBid(b.id)} />
        ))}
      </ul>
    </Card>
  );
}

function Inbox({ onOpenThread }) {
  const { t } = useI18n();
  const { data, loading, error } = useLoad(() => api.get('/messages/inbox'), []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data?.threads?.length) return <Card><Empty>{t('msg_no_inbox')}</Empty></Card>;
  return (
    <Card>
      <ul className="msg-list">
        {data.threads.map(th => (
          <ThreadRow key={th.id} title={`${th.from_name}${th.subject ? ' · ' + th.subject : ''}`} sub={th.preview}
            time={th.last_post_at} unread={th.unread} onOpen={() => onOpenThread(th.id)} />
        ))}
      </ul>
    </Card>
  );
}

export default function Messages() {
  const { t } = useI18n();
  const { can } = useAuth();
  const msg = can('msg');
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('inbox');
  const [compose, setCompose] = useState(false);
  const openThread = params.get('thread');
  const setThread = id => setParams(prev => { const n = new URLSearchParams(prev); id ? n.set('thread', id) : n.delete('thread'); return n; }, { replace: true });
  // a fresh key forces the lists to reload after sending / navigating back
  const [rev, setRev] = useState(0);
  const bump = () => setRev(r => r + 1);

  if (openThread) {
    return (
      <div className="msg-page">
        <PageHeader title={t('messages_title')} sub={t('messages_sub')} icon="inbox" />
        <Thread id={openThread} onBack={() => { setThread(null); bump(); }} onChanged={bump} />
      </div>
    );
  }
  return (
    <div className="msg-page">
      <PageHeader title={t('messages_title')} sub={t('messages_sub')} icon="inbox">
        {msg && <button className="btn btn-primary btn-sm" onClick={() => setCompose(true)}><Icon name="plus" size={14} /> {t('msg_compose')}</button>}
      </PageHeader>
      {msg && (
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'inbox'} className={'tab' + (tab === 'inbox' ? ' active' : '')} onClick={() => setTab('inbox')}>
            <Icon name="inbox" size={15} /> {t('msg_inbox')}
          </button>
          <button role="tab" aria-selected={tab === 'sent'} className={'tab' + (tab === 'sent' ? ' active' : '')} onClick={() => setTab('sent')}>
            <Icon name="out" size={15} /> {t('msg_sent')}
          </button>
        </div>
      )}
      {tab === 'sent' && msg
        ? <Sent key={'s' + rev} onOpenThread={setThread} />
        : <Inbox key={'i' + rev} onOpenThread={setThread} />}
      {compose && <Compose onClose={() => setCompose(false)} onSent={() => { setCompose(false); bump(); }} />}
    </div>
  );
}
