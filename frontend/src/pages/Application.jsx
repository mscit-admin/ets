import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { api, path, notFoundError } from '../lib/api.js';
import { pc, VENDOR_COLORS } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { PctEquation } from '../components/PctEquation.jsx';
import { Alert, Card, ErrorBox, Indicator, Loading, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { useLiveUpdates } from '../lib/live.js';
import { DisabledReason } from '../components/DisableReason.jsx';
import { ItemTypeChip, ItemTypeLegend } from '../components/ItemType.jsx';
import { RenameDialog } from '../components/RenameDialog.jsx';
import { MoveDialog, AppMoveDialog } from '../components/MoveDialog.jsx';
import { Menu } from '../components/Menu.jsx';
import { NumCell, Pager, StatusSelect, STICKY_MQ, navbarHeight, readPageSize, savePageSize, useStuck } from '../components/application/tableControls.jsx';
import { NoteModal } from '../components/application/NoteModal.jsx';
import { NotesHistoryModal } from '../components/application/NotesHistoryModal.jsx';
import { PassFillModal } from '../components/application/PassFillModal.jsx';
import { CloseModal } from '../components/application/CloseModal.jsx';
import { ReopenModal } from '../components/application/ReopenModal.jsx';
import { BulkModal } from '../components/application/BulkModal.jsx';
import { AddModal } from '../components/application/AddModal.jsx';
import { ConfirmModal } from '../components/application/ConfirmModal.jsx';
import { MovedBadge, MoveHistory } from '../components/application/MoveHistory.jsx';
import {
  DISABLE_REASONS, ITEM_TYPES, PASS, SOURCES, SRC_COLOR,
  needsNote, passAutoFill, passConflict, pendingByFunction, pendingDetails, pendingLifecycle,
  pendingSummary, progressPassProblem, typeOf,
} from '../lib/itemRules.js';

// The rules of an edit — required notes, «نجح» = 100 % (1.8.1, auto-filled since 1.12.21: choosing «نجح» brings the
// progress up to 100 % after a confirmation, the server sets both together), reasons, pending values — are in
// lib/itemRules.js, shared with the mobile app.

// "reason" filter values: the reasons a user picks, 'import', and 'none' (excluded before 1.5.0, no reason recorded)
const REASON_FILTER = [...DISABLE_REASONS, 'import', 'none'];
const DEFAULT_FILTER = { q: '', source: '', test: '', reason: '', type: '', showOff: false, showRemoved: false };

export default function Application() {
  const { id } = useParams();
  const { t, nm, errText, fmtDate, lang } = useI18n();
  const { user } = useAuth();
  const location = useLocation();
  const { data, error, loading, reload, refresh } = useLoad(o => api.get(path`/tracker/applications/${id}`, o)
    .then(d => (d?.application && Array.isArray(d.functions) ? d : Promise.reject(notFoundError()))), [id]);
  const [fns, setFns] = useState([]);
  // changes to this application by other users (or project-wide ones) reload the table without losing edits
  useLiveUpdates(refresh, { filter: m => (m.app_id ? m.app_id === id : !m.dept_id || m.dept_id === data?.department?.id) });
  // rows saved by this user whose answer has not come back yet: a reload must not put the old value back
  const inflight = useRef(new Map());
  const [filter, setFilterState] = useState(DEFAULT_FILTER);
  const conflicts = useMemo(() => fns.filter(f => !f.removed_at && passConflict(f)).length, [fns]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(readPageSize);
  // any filter change starts again at page 1 (saving a cell reloads the data but keeps the page)
  const setFilter = f => { setFilterState(f); setPage(1); };
  useEffect(() => { setPage(1); }, [id]);
  const sentinelRef = useRef(null), stickyRef = useRef(null), tableRef = useRef(null);
  const [noteFor, setNoteFor] = useState(null);     // quick note entry for a "with notes" status change (status + note together)
  const [notesFor, setNotesFor] = useState(null);   // the note history popup of an item (migration 031)
  const [bulk, setBulk] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);   // {f, mode: 'remove' | 'restore' | 'toggle', enabled?}
  const [renaming, setRenaming] = useState(null);  // the item being renamed (1.9.1)
  const [moving, setMoving] = useState(null);      // the item being moved to another application (1.10.0)
  const [movingApp, setMovingApp] = useState(false); // moving the whole application to another department (1.12.16)
  const [history, setHistory] = useState(null);    // the item whose move history is open
  const [passFill, setPassFill] = useState(null);  // confirm «نجح» auto-fill to 100 % (1.12.21): { f }
  const [closing, setClosing] = useState(null);    // confirm closing / locking a finished function (migration 033): the item
  const [reopening, setReopening] = useState(null); // reopen dialog (document + reason) for a closed item

  useEffect(() => {
    if (!data) return;
    setFns(cur => data.functions.map(f => (inflight.current.has(f.id) ? cur.find(x => x.id === f.id) || f : f)));
  }, [data]);

  const shown = useMemo(() => fns.filter(f =>
    (f.removed_at ? filter.showRemoved : (filter.showOff || !!filter.reason || f.enabled || f.source !== 'experience')) &&
    (!filter.reason || (!f.enabled && !f.removed_at && (f.disabled_reason || 'none') === filter.reason)) &&
    (!filter.source || f.source === filter.source) &&
    (!filter.type || typeOf(f) === filter.type) &&
    (filter.test === '' || (filter.test === 'conflict' ? !f.removed_at && passConflict(f) : f.test_status === +filter.test)) &&
    (!filter.q || (f.name_ar + ' ' + (f.reference || '') + ' ' + f.note).toLowerCase().includes(filter.q.toLowerCase()))
  ), [fns, filter]);

  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const cur = Math.min(page, pages);      // the list may have shrunk after a reload or a removal
  const stuck = useStuck(sentinelRef, stickyRef, [cur, pageSize, shown.length, !!data].join());

  // Page change from the pager at the bottom: bring the top of the table back just under the sticky header.
  const goPage = n => {
    setPage(Math.min(Math.max(1, n), pages));
    const card = tableRef.current, box = stickyRef.current, sentinel = sentinelRef.current;
    if (!card || !box || !sentinel) return;
    const sticky = window.matchMedia(STICKY_MQ).matches;
    const under = sticky ? box.getBoundingClientRect().bottom : navbarHeight() + 8;
    const top = card.getBoundingClientRect().top;
    if (top >= under) return;
    let y = window.scrollY + top - under;
    // stay (just) past the point where the header sticks, so it keeps its compact size
    if (sticky) y = Math.max(y, window.scrollY + sentinel.getBoundingClientRect().top - navbarHeight() + 1);
    window.scrollTo(0, y);
  };
  // A link to one function (#fn-<id>, e.g. the chips of a duplicate): show it — filters reset when they hide it —,
  // open its page of the table, scroll to it and highlight it for a moment.
  const [focusId, setFocusId] = useState(null);
  const hashId = /^#fn-(\d+)$/.exec(location.hash)?.[1];
  // Latest table state, read through a ref inside the hash-focus effect: the effect runs only when the link
  // changes (not on every reload), so it must look at current fns/shown/pageSize, never a stale render snapshot.
  const hashState = useRef();
  hashState.current = { fns, shown, pageSize, hasData: !!data };
  useEffect(() => {
    const { fns, shown, pageSize, hasData } = hashState.current;
    if (!hashId || !hasData) return;
    const id = +hashId, f = fns.find(x => x.id === id);
    if (!f) return;
    let list = shown;
    if (!shown.some(x => x.id === id)) {
      const next = { ...DEFAULT_FILTER, showOff: true, showRemoved: !!f.removed_at };
      setFilterState(next);
      list = fns.filter(x => (x.removed_at ? next.showRemoved : true));
    }
    const i = list.findIndex(x => x.id === id);
    setPage(Math.floor(Math.max(0, i) / pageSize) + 1);
    setFocusId(id);
  }, [hashId, location.key, !!data]);     // only when the link is followed, not on every reload of the table
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById('fn-' + focusId);
    el?.scrollIntoView({ block: 'center' });
    el?.querySelector('input, button, a')?.focus({ preventScroll: true });
    const h = setTimeout(() => setFocusId(null), 2400);
    return () => clearTimeout(h);
  }, [focusId, cur]);

  // keep the first visible row on screen when the page size changes
  const setPageSize = n => { setPage(Math.floor(((cur - 1) * pageSize) / n) + 1); setPageSizeState(n); savePageSize(n); };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const { application: a, department: d, can, settings } = data;
  // values waiting for the team lead, per function: { [function_id]: [{field, new_value, requested_by_name}] }
  // (add/remove/restore requests are listed in the lifecycle box above the table instead)
  const pendingByFn = pendingByFunction(data.pending);
  const calc = a.calc;
  // share of an item in its part of the application %: a function among the functions, a report among the reports
  // (the reports track counts as one more item of weight 1) — same as the Excel export
  const partW = f => (typeOf(f) === 'report' ? calc.reportWeight || 0 : calc.typeWeight?.function || 0);

  // body is sent to the server; optimistic holds extra fields shown on the row at once but NOT sent — used for the
  // «نجح» auto-fill (1.12.21): the server sets progress=100 itself (its single source of truth, and so a tester with
  // only the test-status permission is not blocked on the progress field), the reload then confirms it.
  const patch = async (f, body, optimistic) => {
    const n = (inflight.current.get(f.id) || 0) + 1;
    inflight.current.set(f.id, n);
    setFns(list => list.map(x => (x.id === f.id ? { ...x, ...body, ...optimistic } : x)));
    const done = () => { const k = inflight.current.get(f.id) - 1; if (k > 0) inflight.current.set(f.id, k); else inflight.current.delete(f.id); };
    try {
      const r = await api.patch(path`/tracker/functions/${f.id}`, body);
      if (r?.pending) toast(t('sent_for_approval'), 'blue');
      done();
      reload();
    } catch (e) {
      done();
      toast(errText(e), 'red');
      setFns(list => list.map(x => (x.id === f.id ? f : x)));
    }
  };

  const ph = { t, nm, lang, pc, appId: id };

  // A "with notes" status on an item without a note opens the note window first;
  // status and note are then saved together (cancel = no change).
  const setStatus = (f, field, v) => {
    // Choosing «نجح» below 100 %: confirm first, then auto-set the progress to 100 % with the status (1.12.21). On
    // cancel nothing is saved — the select is controlled by f.test_status, so it goes back to its value on its own.
    // «نجح» (2) needs no note (only «نجح مع ملاحظة» (1) does), so this path never opens the note window.
    if (passAutoFill(f, field, v)) { setPassFill({ f }); return; }
    const after = { ...f, [field]: v };
    if (needsNote(after) && !(f.note || '').trim()) setNoteFor({ f, pending: { [field]: v } });
    else patch(f, { [field]: v });
  };

  const removedCount = fns.filter(f => f.removed_at).length;
  const pendingLife = pendingLifecycle(data.pending);

  return (
    <div>
      <div className="breadcrumb">
        <Link to="/">{t('nav_home')}</Link><Icon name="chevron" size={12} className="flip" />
        <Link to={'/department/' + d.id}>{nm(d, 'short')}</Link><Icon name="chevron" size={12} className="flip" />
        <span>{nm(a)}</span>
      </div>
      {data.needs_approval && <Alert kind="blue">{t('edits_need_lead_notice')}</Alert>}
      <PageHeader title={nm(a)} sub={a.sub_ar} icon={a.icon}>
        {(can.pct || can.tst || can.tog || can.mov) && <button className="btn btn-default btn-sm" onClick={() => setBulk(true)}>{t('bulk_set')}</button>}
        {can.mov && <button className="btn btn-default btn-sm" onClick={() => setMovingApp(true)}><Icon name="move" size={14} /> {t('amv_button')}</button>}
        {can.tog && <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}><Icon name="plus" size={14} /> {t('add_function')}</button>}
        <ExportButton report="functions" params={{ id: a.id, q: filter.q, source: filter.source, test: filter.test, reason: filter.reason,
          item_type: filter.type, show_off: filter.showOff ? 1 : '', show_removed: filter.showRemoved ? 1 : '' }} />
      </PageHeader>

      {a.moved_from && (
        <div className="row-tags mb-s">
          <span className="moved-chip" title={t('amv_badge_tip', { date: fmtDate(a.moved_from.moved_at), name: a.moved_from.moved_by_name || '—', reason: a.moved_from.reason })}>
            <Icon name="move" size={12} /> {t('amv_badge', { dept: nm(a.moved_from, 'from_dept_name') || t('amv_badge_other') })}
          </span>
        </div>
      )}

      <div ref={sentinelRef} className="sticky-sentinel" aria-hidden="true" />
      <div ref={stickyRef} className={'app-sticky' + (stuck ? ' stuck' : '')}>
        <PctEquation calc={calc} settings={settings} />
      </div>

      {(a.note_ar || a.addendum || a.scope_cut || a.extra_module) && (
        <Alert kind={a.scope_cut ? 'orange' : 'blue'}>
          <div className="row-tags mb-s">
            {a.addendum && <Indicator color="blue">{t('addendum')} {a.addendum}</Indicator>}
            {a.scope_cut && <Indicator color="orange">{t('scope_cut')}</Indicator>}
            {a.extra_module && <Indicator color="purple">{t('extra_module')}</Indicator>}
          </div>
          {a.note_ar && <div lang="ar" dir="rtl">{a.note_ar}</div>}
        </Alert>
      )}

      {pendingLife.length > 0 && (
        <Alert kind="blue">
          <b>{t('lifecycle_pending')}</b>
          <ul className="plain-list">
            {pendingLife.map(p => (
              <li key={`${p.request_id}:${p.function_id ?? ''}:${p.field}`}>{p.field === 'create' ? `＋ ${t('fn_add')}: ${p.new_value?.name_ar}` : p.new_value?.removed
                ? `－ ${t('fn_remove')}: ${fns.find(f => f.id === p.function_id)?.name_ar || ''} (${p.new_value.reason})`
                : `↺ ${t('fn_restore')}: ${fns.find(f => f.id === p.function_id)?.name_ar || ''}`} — <span className="muted">{p.requested_by_name}</span></li>
            ))}
          </ul>
        </Alert>
      )}

      <div ref={tableRef} className="fn-table-card">
      <Card>
        <div className="filter-bar">
          <input className="input input-sm" placeholder={t('filter') + '…'} value={filter.q} onChange={e => setFilter({ ...filter, q: e.target.value })} />
          <select className="input input-sm" value={filter.source} onChange={e => setFilter({ ...filter, source: e.target.value })} aria-label={t('source')}>
            <option value="">{t('source')}: {t('all')}</option>
            {SOURCES.map(s => <option key={s} value={s}>{t('src_' + s)}</option>)}
          </select>
          <select className={'input input-sm it-filter' + (filter.type ? ' it-filter-' + filter.type : '')} value={filter.type}
            onChange={e => setFilter({ ...filter, type: e.target.value })} aria-label={t('item_type')}>
            <option value="">{t('it_filter_all')}</option>
            {ITEM_TYPES.map(v => <option key={v} value={v}>{t('it_' + v + 's')}</option>)}
          </select>
          <select className="input input-sm" value={filter.test} onChange={e => setFilter({ ...filter, test: e.target.value })} aria-label={t('test_status')}>
            <option value="">{t('test_status')}: {t('all')}</option>
            {[0, 1, 2, 3, 4, 5, 6, 7].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}
            {(conflicts > 0 || filter.test === 'conflict') && <option value="conflict">⚠ {t('pass_conflict')} ({conflicts})</option>}
          </select>
          {conflicts > 0 && (
            <button type="button" className={'pass-conflict-chip' + (filter.test === 'conflict' ? ' on' : '')} aria-pressed={filter.test === 'conflict'}
              title={t('pass_conflict_hint')} onClick={() => setFilter({ ...filter, test: filter.test === 'conflict' ? '' : 'conflict' })}>
              <Icon name="alert" size={14} /> {t('pass_conflict_n', { n: conflicts })}
            </button>
          )}
          <select className="input input-sm" value={filter.reason} onChange={e => setFilter({ ...filter, reason: e.target.value })} aria-label={t('dr_filter')}>
            <option value="">{t('dr_filter')}: {t('all')}</option>
            {REASON_FILTER.map(r => <option key={r} value={r}>{t('dr_' + r)}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={filter.showOff} onChange={e => setFilter({ ...filter, showOff: e.target.checked })} /> {t('show_disabled')}</label>
          {removedCount > 0 && <label className="check"><input type="checkbox" checked={filter.showRemoved} onChange={e => setFilter({ ...filter, showRemoved: e.target.checked })} /> {t('show_removed', { n: removedCount })}</label>}
          <span className="muted small push">{shown.length} / {fns.length}</span>
        </div>
        <ItemTypeLegend reportsShare={settings.reports_share} />

        <div className="table-wrap">
          <table className="table fn-table">
            <thead>
              <tr>
                <th className="w-check" title={t('enabled')}>✓</th>
                <th>{t('functions')}</th>
                <th className="num-col">{t('weight')}</th>
                <th className="num-col">{t('progress')} %</th>
                <th>{t('test_status')}</th>
                <th>{t('notif_status')}</th>
                <th>{t('review_status')}</th>
                <th className="w-check">{t('note')}</th>
                <th className="w-check" aria-label={t('row_actions')} title={t('row_actions')} />
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={9} className="empty">{t('fn_no_matches')}</td></tr>}
              {shown.slice((cur - 1) * pageSize, cur * pageSize).map(f => {
                const locked = !!f.closed_at;            // closed = locked from editing (migration 033)
                // the row's actions, consolidated into the ⋮ menu — each keeps its own visibility condition
                const rowActions = [];
                if (can.ren && !f.removed_at && !locked) rowActions.push({ key: 'rename', icon: 'edit', label: t('rn_button'), onClick: () => setRenaming(f) });
                if (can.cls && !f.removed_at && !locked && f.enabled) rowActions.push({ key: 'close', icon: 'lock', label: t('close_button'), onClick: () => setClosing(f) });
                if (can.cls && locked) rowActions.push({ key: 'reopen', icon: 'restore', label: t('reopen_button'), onClick: () => setReopening(f) });
                if (can.tog && !f.removed_at && !locked) rowActions.push({ key: 'remove', label: t('fn_remove'), onClick: () => setConfirm({ f, mode: 'remove' }), danger: true });
                if (can.tog && f.removed_at) rowActions.push({ key: 'restore', label: t('fn_restore'), onClick: () => setConfirm({ f, mode: 'restore' }) });
                if (can.mov && !f.removed_at && !locked) rowActions.push({ key: 'move', icon: 'move', label: t('mv_button'), onClick: () => setMoving(f) });
                return (
                <tr key={f.id} id={'fn-' + f.id} className={(f.removed_at ? 'row-off row-removed' : f.enabled ? '' : 'row-off') + (focusId === f.id ? ' row-focus' : '')
                  + (typeOf(f) === 'report' ? ' row-report' : '') + (locked ? ' row-closed' : '')}>
                  <td className="w-check">
                    <input type="checkbox" checked={f.enabled} disabled={!can.tog || !!f.removed_at || locked} aria-label={t('enabled')}
                      title={locked ? t('closed_locked_hint') : f.enabled ? t('exclude_hint') : t('include_hint')}
                      onChange={e => setConfirm({ f, mode: 'toggle', enabled: e.target.checked })} />
                  </td>
                  <td className="fn-name">
                    <div className="fn-title">
                      <ItemTypeChip type={typeOf(f)} code={f.code} editable={can.tog && !f.removed_at && !locked} onChange={v => patch(f, { item_type: v })} />
                      <div className="fn-title-text" lang="ar" dir="rtl">{f.name_ar}</div>
                    </div>
                    <div className="fn-meta">
                      <span className="code">{f.code}</span>
                      <Indicator color={SRC_COLOR[f.source]}>{t('src_' + f.source)}</Indicator>
                      {f.vendor_status > 0 && <Indicator color={VENDOR_COLORS[f.vendor_status]} title={t('vendor_status')}>{t('vs_' + f.vendor_status)}</Indicator>}
                      {f.reference && <span className="muted" lang="ar">{f.reference}</span>}
                      {f.enabled && partW(f) > 0 && <span className="muted">{t('share')} <span className="num">{pc((f.weight / partW(f)) * 100)}%</span></span>}
                      {f.updated_by_name && <span className="muted" title={fmtDate(f.updated_at)}>{t('last_updated_by', { name: f.updated_by_name })}</span>}
                      {pendingByFn[f.id] && (
                        <Link to={'/approvals?app=' + encodeURIComponent(id)} className="pending-chip" title={pendingDetails(ph, pendingByFn[f.id]).join('\n')}>
                          ⏳ {t('awaiting_approval')}: {pendingSummary(ph, pendingByFn[f.id])}
                        </Link>
                      )}
                      {f.moved_from && <MovedBadge m={f.moved_from} onOpen={() => setHistory(f)} />}
                      {!f.enabled && !f.removed_at && <DisabledReason f={f} appId={a.id} />}
                      {f.removed_at && <Indicator color="red" title={f.removed_reason}>{t('removed_by_on', { name: f.removed_by_name || '—', date: fmtDate(f.removed_at) })}</Indicator>}
                      {f.removed_at && <span className="muted">{t('reason')}: {f.removed_reason}</span>}
                      {locked && (
                        <Indicator color="cyan" title={t('closed_by_on', { name: f.closed_by_name || '—', date: fmtDate(f.closed_at) })}>
                          <Icon name="lock" size={12} /> {t('closed_badge')}
                        </Indicator>
                      )}
                      {f.last_reopening && (
                        <span className="muted small" title={t('reopened_by_on', { name: f.last_reopening.reopened_by_name || '—', date: fmtDate(f.last_reopening.reopened_at) })}>
                          {t('reopen_last')}: <a href={path`/api/tracker/functions/${f.id}/reopenings/${f.last_reopening.id}/document`} target="_blank" rel="noopener noreferrer">
                            <Icon name="download" size={12} /> {t('reopen_view_doc')}</a> — {f.last_reopening.reason}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="num-col"><NumCell value={f.weight} min={0} max={1000} step={0.5} disabled={!can.wgt || !f.enabled || locked} label={t('weight')} onCommit={v => patch(f, { weight: v })} /></td>
                  <td className="num-col">
                    <NumCell value={locked ? 100 : f.progress} min={0} max={100} step={5} disabled={!can.pct || !f.enabled || locked} label={t('progress')} onCommit={v => patch(f, { progress: v })}
                      check={v => { const p = progressPassProblem(f, v); return p ? t(p.key, p.vars) : null; }} />
                    <div className="mini-progress"><i style={{ width: (locked ? 100 : f.progress) + '%' }} /></div>
                  </td>
                  <td>
                    <div className="ts-cell">
                      <StatusSelect value={f.test_status} prefix="ts_" states={8} disabled={!can.tst || !f.enabled || locked} label={t('test_status')} onChange={v => setStatus(f, 'test_status', v)} />
                      {!f.removed_at && passConflict(f) && (
                        <span className="pass-conflict" role="img" aria-label={t('pass_conflict_hint')} title={t('pass_conflict_hint') + ' — ' + t('pass_conflict_fix')}>
                          <Icon name="alert" size={15} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td><StatusSelect value={f.notif_status} prefix="ns_" disabled={!can.pct || !f.enabled || locked} label={t('notif_status')} onChange={v => setStatus(f, 'notif_status', v)} /></td>
                  <td><StatusSelect value={f.review_status} prefix="rv_" states={6} disabled={!can.tst || !f.enabled || locked} label={t('review_status')} onChange={v => setStatus(f, 'review_status', v)} /></td>
                  <td className="w-check">
                    <button className={'btn-icon' + (f.note ? ' has-note' : needsNote(f) ? ' note-missing' : '')} onClick={() => setNotesFor(f)}
                      title={f.note || (needsNote(f) ? t('note_required_hint') : t('notes_history_title'))} aria-label={t('notes_history_title')}>
                      <Icon name="note" size={16} />
                    </button>
                  </td>
                  <td className="w-check fn-actions-cell">
                    <Menu label={t('row_actions')} items={rowActions} />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {shown.length > 0 && <Pager page={cur} pages={pages} total={shown.length} size={pageSize} onPage={goPage} onSize={setPageSize} />}
      </Card>
      </div>

      {noteFor && <NoteModal f={noteFor.f} pending={noteFor.pending} canEdit={(can.tst && !noteFor.f.closed_at) || !!noteFor.pending}
        onClose={() => setNoteFor(null)} onSave={async note => { await patch(noteFor.f, { ...(noteFor.pending || {}), note }); setNoteFor(null); }} />}
      {notesFor && <NotesHistoryModal f={notesFor} can={can} userId={user?.id} fmtDate={fmtDate}
        onClose={() => setNotesFor(null)} onChanged={reload} />}
      {bulk && <BulkModal app={a} can={can} onClose={() => setBulk(false)} onDone={() => { setBulk(false); reload(); }} />}
      {adding && <AddModal app={a} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {renaming && <RenameDialog f={renaming} others={fns} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); reload(); }} />}
      {moving && <MoveDialog app={a} f={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />}
      {movingApp && <AppMoveDialog app={a} onClose={() => setMovingApp(false)} onDone={() => { setMovingApp(false); reload(); }} />}
      {history && <MoveHistory f={history} onClose={() => setHistory(null)} />}
      {passFill && <PassFillModal f={passFill.f} onClose={() => setPassFill(null)}
        onConfirm={async () => { const f = passFill.f; setPassFill(null); await patch(f, { test_status: PASS }, { progress: 100 }); }} />}
      {closing && <CloseModal f={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); reload(); }} />}
      {reopening && <ReopenModal f={reopening} onClose={() => setReopening(null)} onDone={() => { setReopening(null); reload(); }} />}
      {confirm && <ConfirmModal app={a} {...confirm} onClose={() => setConfirm(null)}
        onDone={async () => {
          // including again needs no reason: saved like the other cells; an exclusion is saved by the dialog itself
          if (confirm.mode === 'toggle' && confirm.enabled) { setConfirm(null); await patch(confirm.f, { enabled: true }); return; }
          setConfirm(null); reload();
        }} />}
    </div>
  );
}
