// /messages — in-app messaging (1.12.26) + ALERTS (1.12.29). Everyone has an Inbox of private conversations; a user
// with the 'msg' permission also composes a «رسالة» (message) or a «تنبيه» (alert) and gets a «المُرسَلة» view and
// the sender side of the «التنبيهات» tab. An alert pops up as a mandatory blocking modal (AlertGate) in front of the
// recipient and needs a response (ack | working). A conversation is strictly 1:1 between the sender and one
// recipient; a message sent to many becomes one private thread each, and a recipient never sees another's thread.
// Messages and alerts are shown as a branching TREE (root → replies / per-recipient branches). RTL correct.
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

// ---- the response status badge (alerts): ack / working / pending
function StatusBadge({ status }) {
  const { t } = useI18n();
  const k = status || 'pending';
  return <span className={'alert-badge ' + k}>{t('alert_status_' + k)}</span>;
}

// ---- the posts of a thread as a threaded TREE: the first post is the root, every reply a branch beneath it.
function PostTree({ posts }) {
  const { t, fmtDate } = useI18n();
  const ago = useTimeAgo();
  return (
    <ul className="msg-tree">
      {posts.map((p, i) => (
        <li key={p.id} className={'msg-node' + (i === 0 ? ' root' : ' branch') + (p.mine ? ' mine' : '')}>
          <div className="msg-node-dot" aria-hidden="true" />
          <div className="msg-post">
            <div className="msg-post-meta">
              <span>{p.mine ? t('msg_you') : p.author_name}</span>
              <time dateTime={p.created_at} title={fmtDate(p.created_at)}>{ago(p.created_at)}</time>
            </div>
            <div className="msg-post-body">{p.body}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

// ---- Compose (msg only): a «رسالة / تنبيه» type choice, then individuals + everyone + by department + by role.
function Compose({ onClose, onSent }) {
  const { t, nm, errText } = useI18n();
  const [kind, setKind] = useState('message');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [people, setPeople] = useState([]);
  const [all, setAll] = useState(false);
  const [depts, setDepts] = useState(new Set());
  const [roles, setRoles] = useState(new Set());
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data: meta } = useLoad(() => api.get('/messages/compose-meta'), []);

  const audience = useCallback(() => ({
    all, users: people.map(p => p.id), depts: [...depts], roles: [...roles],
  }), [all, people, depts, roles]);

  const seq = useRef(0);
  useEffect(() => {
    const aud = audience();
    if (!aud.all && !aud.users.length && !aud.depts.length && !aud.roles.length) { setCount(0); return; }
    const my = ++seq.current;
    api.post('/messages/resolve', { audience: aud }).then(d => { if (my === seq.current) setCount(d.count); }).catch(() => {});
  }, [audience]);

  const loadPeople = (q) => api.get('/messages/recipients' + (q ? '?q=' + encodeURIComponent(q) : '')).then(d => d.recipients);
  const toggle = (set, setSet, id) => setSet(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const isAlert = kind === 'alert';

  const send = async () => {
    if (!body.trim() || !count) return;
    setBusy(true);
    try {
      const r = await api.post('/messages', { kind, subject: subject.trim() || undefined, body: body.trim(), audience: audience() });
      toast(t(isAlert ? 'alert_sent_ok' : 'msg_sent_ok', { n: r.sent }));
      onSent();
    } catch (e) { toast(errText(e), 'red'); setBusy(false); }
  };

  return (
    <Modal title={t(isAlert ? 'alert_new_title' : 'msg_new_title')} onClose={onClose} wide footer={
      <>
        <span className="msg-count">{count ? t('msg_resolved_count', { n: count }) : t('msg_resolved_zero')}</span>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>{t('cancel')}</button>
        <button className={'btn btn-sm ' + (isAlert ? 'btn-warn' : 'btn-primary')} onClick={send} disabled={busy || !body.trim() || !count}>
          <Icon name={isAlert ? 'bell' : 'out'} size={14} /> {busy ? t('msg_sending') : t(isAlert ? 'alert_send' : 'msg_send')}
        </button>
      </>
    }>
      <div className="msg-seg" role="tablist" aria-label={t('msg_type')}>
        <button role="tab" aria-selected={!isAlert} className={'msg-seg-btn' + (!isAlert ? ' on' : '')} onClick={() => setKind('message')}>
          <Icon name="inbox" size={14} /> {t('msg_type_message')}
        </button>
        <button role="tab" aria-selected={isAlert} className={'msg-seg-btn' + (isAlert ? ' on' : '')} onClick={() => setKind('alert')}>
          <Icon name="bell" size={14} /> {t('msg_type_alert')}
        </button>
      </div>
      {isAlert && <p className="muted small alert-note-hint">{t('alert_compose_hint')}</p>}
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
      <Field label={t(isAlert ? 'alert_body' : 'msg_body')} className="msg-field">
        <textarea className="input" rows={6} value={body} maxLength={BODY_MAX} onChange={e => setBody(e.target.value)} placeholder={t('msg_body_ph')} />
      </Field>
    </Modal>
  );
}

// ---- Thread view: the full conversation shown as a tree (root + branched replies), with a reply box. For an alert
// thread it also shows the response status; the recipient responds through the mandatory popup (AlertGate), not here.
function Thread({ id, onBack, onChanged }) {
  const { t, fmtDate, errText } = useI18n();
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
  const isAlert = thread.kind === 'alert';
  return (
    <Card className="msg-thread">
      <div className="msg-thread-head">
        <button className="btn btn-ghost btn-sm" onClick={onBack} aria-label={t('msg_back')}><Icon name="chevron" size={16} /></button>
        <div>
          <b>{isAlert && <Icon name="bell" size={14} />} {thread.subject || t(isAlert ? 'alert_one' : 'msg_conversation')}</b>
          <div className="muted small">{t('msg_from')}: {other.full_name} · {other.username}</div>
        </div>
      </div>
      {isAlert && (
        <div className="alert-response-bar">
          <span>{t('alert_response_label')}:</span> <StatusBadge status={thread.response_status} />
          {thread.responded_at && <time className="muted small"> · {fmtDate(thread.responded_at)}</time>}
          {!thread.response_status && thread.side === 'recipient' && <span className="muted small"> · {t('alert_awaiting_you')}</span>}
        </div>
      )}
      <PostTree posts={posts} />
      <div ref={endRef} />
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

function ThreadRow({ title, sub, time, unread, badge, onOpen }) {
  const ago = useTimeAgo();
  return (
    <li className={'msg-row' + (unread ? ' unread' : '')}>
      <button className="msg-row-main" onClick={onOpen}>
        <span className="msg-row-text">
          <span className="msg-row-title">{title} {badge} {unread && <span className="msg-dot" aria-hidden="true" />}</span>
          {sub && <span className="msg-row-sub">{sub}</span>}
        </span>
        <time className="msg-row-time">{ago(time)}</time>
      </button>
    </li>
  );
}

// ---- Sent (messages): broadcasts → drill into per-recipient threads shown as a tree (root → recipient branches).
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
          <ul className="msg-tree sender">
            <li className="msg-node root"><div className="msg-node-dot" aria-hidden="true" />
              <div className="msg-branch-head"><b>{d.broadcast.subject || t('msg_conversation')}</b>
                <div className="msg-row-sub">{d.broadcast.preview}</div></div>
            </li>
            {d.threads.map(th => (
              <li key={th.id} className={'msg-node branch' + (th.unread ? ' unread' : '')}>
                <div className="msg-node-dot" aria-hidden="true" />
                <button className="msg-branch-head as-button" onClick={() => onOpenThread(th.id)}>
                  <span className="msg-row-title">{th.recipient_name} {th.unread && <span className="msg-dot" aria-hidden="true" />}</span>
                  <span className="msg-row-sub">{th.preview} · {t('msg_post_count', { n: th.post_count })}</span>
                </button>
              </li>
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

// ---- the sender's ALERT tree: root alert → each recipient branch with status badge + note + nested posts.
function AlertSentTree({ bid, onBack }) {
  const { t, fmtDate } = useI18n();
  const ago = useTimeAgo();
  const { data, loading, error } = useLoad(() => api.get(path`/messages/alerts/sent/${bid}`), [bid]);
  const [open, setOpen] = useState(new Set());
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const d = data;
  const toggle = id => setOpen(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <Card>
      <div className="msg-thread-head">
        <button className="btn btn-ghost btn-sm" onClick={onBack}><Icon name="chevron" size={16} /></button>
        <div><b><Icon name="bell" size={14} /> {d.broadcast.subject || t('alert_one')}</b>
          <div className="muted small">{t('msg_recipient_count', { n: d.broadcast.recipient_count })}</div></div>
      </div>
      <div className="alert-counts">
        <span className="alert-badge ack">{t('alert_count_ack', { n: d.counts.ack })}</span>
        <span className="alert-badge working">{t('alert_count_working', { n: d.counts.working })}</span>
        <span className="alert-badge pending">{t('alert_count_pending', { n: d.counts.pending })}</span>
      </div>
      <ul className="msg-tree sender">
        <li className="msg-node root"><div className="msg-node-dot" aria-hidden="true" />
          <div className="msg-branch-head"><b>{d.broadcast.subject || t('alert_one')}</b>
            <div className="msg-post-body">{d.broadcast.body}</div></div>
        </li>
        {d.threads.map(th => {
          const isOpen = open.has(th.id);
          return (
            <li key={th.id} className="msg-node branch">
              <div className="msg-node-dot" aria-hidden="true" />
              <button className="msg-branch-head as-button" onClick={() => toggle(th.id)} aria-expanded={isOpen}>
                <span className="msg-row-title">
                  <Icon name='chevron' size={13} /> {th.recipient_name} <StatusBadge status={th.response_status} />
                </span>
                {th.responded_at && <span className="msg-row-sub">{t('alert_responded_at')}: {fmtDate(th.responded_at)}</span>}
              </button>
              {isOpen && (
                <div className="msg-subtree">
                  {th.response_note && <div className="alert-note">{t('alert_note_label')}: {th.response_note}</div>}
                  {th.posts.length > 1 ? <PostTree posts={th.posts} />
                    : <div className="muted small">{t('alert_no_reply')} · {ago(th.created_at)}</div>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---- «التنبيهات» tab. Recipient side: my alerts + my response. Sender side (msg): each alert as a tree with counts.
function Alerts({ onOpenThread, canSend }) {
  const { t } = useI18n();
  const ago = useTimeAgo();
  const [view, setView] = useState(canSend ? 'sent' : 'received');
  const [bid, setBid] = useState(null);
  const mine = useLoad(() => (view === 'received' ? api.get('/messages/alerts/mine') : Promise.resolve(null)), [view]);
  const sent = useLoad(() => (view === 'sent' ? api.get('/messages/alerts/sent') : Promise.resolve(null)), [view]);

  const tabs = canSend && (
    <div className="msg-seg" role="tablist" style={{ marginBottom: 12 }}>
      <button role="tab" aria-selected={view === 'received'} className={'msg-seg-btn' + (view === 'received' ? ' on' : '')} onClick={() => { setView('received'); setBid(null); }}>{t('alert_received')}</button>
      <button role="tab" aria-selected={view === 'sent'} className={'msg-seg-btn' + (view === 'sent' ? ' on' : '')} onClick={() => { setView('sent'); setBid(null); }}>{t('alert_sent')}</button>
    </div>
  );

  if (view === 'sent') {
    if (bid) return <>{tabs}<AlertSentTree bid={bid} onBack={() => setBid(null)} /></>;
    if (sent.loading) return <>{tabs}<Loading /></>;
    if (sent.error) return <>{tabs}<ErrorBox error={sent.error} /></>;
    if (!sent.data?.alerts?.length) return <>{tabs}<Card><Empty>{t('alert_no_sent')}</Empty></Card></>;
    return <>{tabs}<Card><ul className="msg-list">
      {sent.data.alerts.map(a => (
        <ThreadRow key={a.id} title={<><Icon name="bell" size={13} /> {a.subject || a.preview}</>} time={a.created_at}
          sub={`${t('alert_count_ack', { n: a.counts.ack })} · ${t('alert_count_working', { n: a.counts.working })} · ${t('alert_count_pending', { n: a.counts.pending })}`}
          onOpen={() => setBid(a.id)} />
      ))}
    </ul></Card></>;
  }
  // received
  if (mine.loading) return <>{tabs}<Loading /></>;
  if (mine.error) return <>{tabs}<ErrorBox error={mine.error} /></>;
  if (!mine.data?.alerts?.length) return <>{tabs}<Card><Empty>{t('alert_no_received')}</Empty></Card></>;
  return <>{tabs}<Card><ul className="msg-list">
    {mine.data.alerts.map(a => (
      <li key={a.id} className="msg-row">
        <button className="msg-row-main" onClick={() => onOpenThread(a.id)}>
          <span className="msg-row-text">
            <span className="msg-row-title"><Icon name="bell" size={13} /> {a.from_name}{a.subject ? ' · ' + a.subject : ''} <StatusBadge status={a.response_status} /></span>
            <span className="msg-row-sub">{a.preview}{a.response_note ? ' · ' + t('alert_note_label') + ': ' + a.response_note : ''}</span>
          </span>
          <time className="msg-row-time">{ago(a.created_at)}</time>
        </button>
      </li>
    ))}
  </ul></Card></>;
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
  const [rev, setRev] = useState(0);
  // Stable identity: Thread's load() calls onChanged on every fetch, which setRev-bumps us and re-renders. If bump
  // were a fresh function each render, that new onChanged would change Thread's load → its effect would blank the
  // data (Loading) and re-fetch → calling onChanged again → an endless reload loop (the thread view "flicker").
  const bump = useCallback(() => setRev(r => r + 1), []);

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
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'inbox'} className={'tab' + (tab === 'inbox' ? ' active' : '')} onClick={() => setTab('inbox')}>
          <Icon name="inbox" size={15} /> {t('msg_inbox')}
        </button>
        {msg && (
          <button role="tab" aria-selected={tab === 'sent'} className={'tab' + (tab === 'sent' ? ' active' : '')} onClick={() => setTab('sent')}>
            <Icon name="out" size={15} /> {t('msg_sent')}
          </button>
        )}
        <button role="tab" aria-selected={tab === 'alerts'} className={'tab' + (tab === 'alerts' ? ' active' : '')} onClick={() => setTab('alerts')}>
          <Icon name="bell" size={15} /> {t('alerts_tab')}
        </button>
      </div>
      {tab === 'alerts'
        ? <Alerts key={'a' + rev} onOpenThread={setThread} canSend={msg} />
        : tab === 'sent' && msg
          ? <Sent key={'s' + rev} onOpenThread={setThread} />
          : <Inbox key={'i' + rev} onOpenThread={setThread} />}
      {compose && <Compose onClose={() => setCompose(false)} onSent={() => { setCompose(false); bump(); }} />}
    </div>
  );
}
