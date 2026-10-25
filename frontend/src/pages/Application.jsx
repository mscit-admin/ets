import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useI18n } from '../i18n/index.jsx';
import { api, path, qs, notFoundError } from '../lib/api.js';
import { pc, VENDOR_COLORS } from '../lib/format.js';
import { Icon } from '../components/Icon.jsx';
import { PctEquation } from '../components/PctEquation.jsx';
import { Alert, Card, ErrorBox, Field, Indicator, Loading, Modal, PageHeader, toast, useLoad } from '../components/ui.jsx';
import { ExportButton } from '../components/ExportButton.jsx';
import { useLiveUpdates } from '../lib/live.js';
import { MultiSelect } from '../components/MultiSelect.jsx';
import { DisableReasonForm, DisabledReason } from '../components/DisableReason.jsx';
import { ItemTypeChip, ItemTypeLegend, TypeBadge } from '../components/ItemType.jsx';
import { RenameDialog } from '../components/RenameDialog.jsx';
import { MoveDialog, MoveFields, AppMoveDialog } from '../components/MoveDialog.jsx';
import {
  DISABLE_REASONS, ITEM_TYPES, MOVE_MAX, SOURCES, SRC_COLOR, blockedItemKey, blockedItems,
  PASS, countDelta, emptyMove, emptyReason, moveReady, needsNote, noteProblem, noteReasons, passAutoFill, passConflict, pctDelta, pctText, pendingByFunction,
  pendingDetails, pendingLifecycle, pendingSummary, progressPassProblem, reasonBody, reasonProblem, typeOf,
} from '../lib/itemRules.js';

// The rules of an edit — required notes, «نجح» = 100 % (1.8.1, auto-filled since 1.12.21: choosing «نجح» brings the
// progress up to 100 % after a confirmation, the server sets both together), reasons, pending values — are in
// lib/itemRules.js, shared with the mobile app.

// "reason" filter values: the reasons a user picks, 'import', and 'none' (excluded before 1.5.0, no reason recorded)
const REASON_FILTER = [...DISABLE_REASONS, 'import', 'none'];
const DEFAULT_FILTER = { q: '', source: '', test: '', reason: '', type: '', showOff: false, showRemoved: false };
// Functions table pagination: rows per page (remembered per browser, default 10).
const PAGE_SIZES = [5, 10, 15, 20, 25];
const PAGE_SIZE_KEY = 'ets.fnPageSize';
const readPageSize = () => {
  try { const n = parseInt(localStorage.getItem(PAGE_SIZE_KEY), 10); return PAGE_SIZES.includes(n) ? n : 10; } catch { return 10; }
};
const savePageSize = n => { try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* storage unavailable */ } };

// The progress header stays visible (CSS position: sticky) only on screens wide and tall enough —
// keep in sync with the @media rule of .app-sticky in app.css.
const STICKY_MQ = '(min-width: 900px) and (min-height: 500px)';
const navbarHeight = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--navbar-h')) || 52;

// Is the sticky header currently stuck under the top bar? (→ compact look + shadow)
// It only switches to the compact look when the page is long enough to stay scrolled after shrinking,
// so the header never flickers between the two sizes at the end of a short page.
function useStuck(sentinelRef, boxRef, layoutKey) {
  const [stuck, setStuck] = useState(false);
  const check = useCallback(() => {
    const s = sentinelRef.current, box = boxRef.current;
    if (!s || !box || !window.matchMedia(STICKY_MQ).matches) { setStuck(false); return; }
    const top = s.getBoundingClientRect().top - navbarHeight();     // < 0 once the header has reached the top bar
    if (top >= 0) { setStuck(false); return; }
    setStuck(was => {
      if (was) return true;
      const room = document.documentElement.scrollHeight - window.innerHeight - (window.scrollY + top);
      return room > box.offsetHeight;
    });
  }, [sentinelRef, boxRef]);
  useEffect(() => {
    let raf = 0;
    const on = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(check); };
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('scroll', on); window.removeEventListener('resize', on); };
  }, [check]);
  useLayoutEffect(() => { check(); }, [check, layoutKey]);   // re-check when the rows below change
  return stuck;
}

function Pager({ page, pages, total, size, onPage, onSize }) {
  const { t, dir } = useI18n();
  const from = (page - 1) * size + 1, to = Math.min(total, page * size);
  // icons picked by direction (not mirrored with CSS): in Arabic "next" points left, "previous" points right
  const rtl = dir === 'rtl';
  const arrow = (icon, label, target, disabled) => (
    <button type="button" className="btn btn-default btn-sm pager-arrow" disabled={disabled} onClick={() => onPage(target)}
      aria-label={label} title={label}><Icon name={icon} size={15} /></button>
  );
  const [before, after] = t('showing_range', { n: total }).split('{range}');
  return (
    <nav className="fn-pager" aria-label={t('page_of', { page, pages })}>
      <label className="fn-pager-size">
        <span>{t('rows_per_page')}</span>
        <select className="input input-sm" value={size} onChange={e => onSize(parseInt(e.target.value, 10))}>
          {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="fn-pager-range muted small">{before}<bdi dir="ltr">{from}–{to}</bdi>{after}</span>
      <div className="fn-pager-nav">
        {arrow(rtl ? 'chevrons' : 'chevrons_back', t('first_page'), 1, page <= 1)}
        {arrow(rtl ? 'chevron' : 'chevron_back', t('previous_page'), page - 1, page <= 1)}
        <span className="fn-pager-page small" aria-live="polite">{t('page_of', { page, pages })}</span>
        {arrow(rtl ? 'chevron_back' : 'chevron', t('next_page'), page + 1, page >= pages)}
        {arrow(rtl ? 'chevrons_back' : 'chevrons', t('last_page'), pages, page >= pages)}
      </div>
    </nav>
  );
}

// Number input that only commits on blur / Enter (one request per edit, not per keystroke).
// A new value from the server (save, or a live update by another user) replaces the shown one, except while the
// user is typing in this cell: the typed value is kept until it is committed or abandoned (blur).
// check(n): a message when the value cannot be saved (shown as an alert; the cell goes back to its value).
function NumCell({ value, min, max, step = 1, disabled, onCommit, label, check }) {
  const [v, setV] = useState(String(value));
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setV(String(value)); }, [value]);
  const commit = () => {
    editing.current = false;
    const n = Math.min(max, Math.max(min, parseFloat(v)));
    if (!Number.isFinite(n)) { setV(String(value)); return; }
    if (n === +value) { setV(String(value)); return; }
    const problem = check?.(n);
    if (problem) { toast(problem, 'red'); setV(String(value)); return; }
    onCommit(n);
  };
  return (
    <input className="input input-sm num-input" type="number" min={min} max={max} step={step} value={v} disabled={disabled}
      aria-label={label} onChange={e => { editing.current = true; setV(e.target.value); }} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
  );
}

// test_status has five states (1.12.25), review_status six (1.12.17); notification has four.
function StatusSelect({ value, prefix, disabled, onChange, label, states = 4 }) {
  const { t } = useI18n();
  return (
    <select className={'input input-sm select-status s' + value + ' ' + prefix + value} value={value} disabled={disabled} aria-label={label}
      onChange={e => onChange(parseInt(e.target.value, 10))}>
      {Array.from({ length: states }, (_, i) => <option key={i} value={i}>{t(prefix + i)}</option>)}
    </select>
  );
}

export default function Application() {
  const { id } = useParams();
  const { t, nm, errText, fmtDate, lang } = useI18n();
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
  const [noteFor, setNoteFor] = useState(null);
  const [bulk, setBulk] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState(null);   // {f, mode: 'remove' | 'restore' | 'toggle', enabled?}
  const [renaming, setRenaming] = useState(null);  // the item being renamed (1.9.1)
  const [moving, setMoving] = useState(null);      // the item being moved to another application (1.10.0)
  const [movingApp, setMovingApp] = useState(false); // moving the whole application to another department (1.12.16)
  const [history, setHistory] = useState(null);    // the item whose move history is open
  const [passFill, setPassFill] = useState(null);  // confirm «نجح» auto-fill to 100 % (1.12.21): { f }

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
  useEffect(() => {
    if (!hashId || !data) return;
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
            {pendingLife.map((p, i) => (
              <li key={i}>{p.field === 'create' ? `＋ ${t('fn_add')}: ${p.new_value?.name_ar}` : p.new_value?.removed
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
            {[0, 1, 2, 3, 4].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}
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
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && <tr><td colSpan={8} className="empty">{t('fn_no_matches')}</td></tr>}
              {shown.slice((cur - 1) * pageSize, cur * pageSize).map(f => (
                <tr key={f.id} id={'fn-' + f.id} className={(f.removed_at ? 'row-off row-removed' : f.enabled ? '' : 'row-off') + (focusId === f.id ? ' row-focus' : '')
                  + (typeOf(f) === 'report' ? ' row-report' : '')}>
                  <td className="w-check">
                    <input type="checkbox" checked={f.enabled} disabled={!can.tog || !!f.removed_at} aria-label={t('enabled')}
                      title={f.enabled ? t('exclude_hint') : t('include_hint')}
                      onChange={e => setConfirm({ f, mode: 'toggle', enabled: e.target.checked })} />
                  </td>
                  <td className="fn-name">
                    <div className="fn-title">
                      <ItemTypeChip type={typeOf(f)} code={f.code} editable={can.tog && !f.removed_at} onChange={v => patch(f, { item_type: v })} />
                      <div className="fn-title-text" lang="ar" dir="rtl">{f.name_ar}</div>
                      {can.ren && !f.removed_at && (
                        <button type="button" className="btn-icon btn-rename" onClick={() => setRenaming(f)}
                          aria-label={t('rn_button')} title={t('rn_button')}><Icon name="edit" size={15} /></button>
                      )}
                      {can.mov && !f.removed_at && (
                        <button type="button" className="btn-icon btn-move" onClick={() => setMoving(f)}
                          aria-label={t('mv_button') + ' — ' + f.code} title={t('mv_button')}><Icon name="move" size={15} /></button>
                      )}
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
                      {can.tog && !f.removed_at && <button className="btn-link small red-text" onClick={() => setConfirm({ f, mode: 'remove' })}>{t('fn_remove')}</button>}
                      {can.tog && f.removed_at && <button className="btn-link small" onClick={() => setConfirm({ f, mode: 'restore' })}>{t('fn_restore')}</button>}
                    </div>
                  </td>
                  <td className="num-col"><NumCell value={f.weight} min={0} max={1000} step={0.5} disabled={!can.wgt || !f.enabled} label={t('weight')} onCommit={v => patch(f, { weight: v })} /></td>
                  <td className="num-col">
                    <NumCell value={f.progress} min={0} max={100} step={5} disabled={!can.pct || !f.enabled} label={t('progress')} onCommit={v => patch(f, { progress: v })}
                      check={v => { const p = progressPassProblem(f, v); return p ? t(p.key, p.vars) : null; }} />
                    <div className="mini-progress"><i style={{ width: f.progress + '%' }} /></div>
                  </td>
                  <td>
                    <div className="ts-cell">
                      <StatusSelect value={f.test_status} prefix="ts_" states={5} disabled={!can.tst || !f.enabled} label={t('test_status')} onChange={v => setStatus(f, 'test_status', v)} />
                      {!f.removed_at && passConflict(f) && (
                        <span className="pass-conflict" role="img" aria-label={t('pass_conflict_hint')} title={t('pass_conflict_hint') + ' — ' + t('pass_conflict_fix')}>
                          <Icon name="alert" size={15} />
                        </span>
                      )}
                    </div>
                  </td>
                  <td><StatusSelect value={f.notif_status} prefix="ns_" disabled={!can.pct || !f.enabled} label={t('notif_status')} onChange={v => setStatus(f, 'notif_status', v)} /></td>
                  <td><StatusSelect value={f.review_status} prefix="rv_" states={6} disabled={!can.tst || !f.enabled} label={t('review_status')} onChange={v => setStatus(f, 'review_status', v)} /></td>
                  <td className="w-check">
                    <button className={'btn-icon' + (f.note ? ' has-note' : needsNote(f) ? ' note-missing' : '')} onClick={() => setNoteFor({ f })}
                      title={f.note || (needsNote(f) ? t('note_required_hint') : t('edit_note'))} aria-label={t('edit_note')}>
                      <Icon name="note" size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length > 0 && <Pager page={cur} pages={pages} total={shown.length} size={pageSize} onPage={goPage} onSize={setPageSize} />}
      </Card>
      </div>

      {noteFor && <NoteModal f={noteFor.f} pending={noteFor.pending} canEdit={can.tst || !!noteFor.pending}
        onClose={() => setNoteFor(null)} onSave={async note => { await patch(noteFor.f, { ...(noteFor.pending || {}), note }); setNoteFor(null); }} />}
      {bulk && <BulkModal app={a} can={can} onClose={() => setBulk(false)} onDone={() => { setBulk(false); reload(); }} />}
      {adding && <AddModal app={a} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {renaming && <RenameDialog f={renaming} others={fns} onClose={() => setRenaming(null)} onDone={() => { setRenaming(null); reload(); }} />}
      {moving && <MoveDialog app={a} f={moving} onClose={() => setMoving(null)} onDone={() => { setMoving(null); reload(); }} />}
      {movingApp && <AppMoveDialog app={a} onClose={() => setMovingApp(false)} onDone={() => { setMovingApp(false); reload(); }} />}
      {history && <MoveHistory f={history} onClose={() => setHistory(null)} />}
      {passFill && <PassFillModal f={passFill.f} onClose={() => setPassFill(null)}
        onConfirm={async () => { const f = passFill.f; setPassFill(null); await patch(f, { test_status: PASS }, { progress: 100 }); }} />}
      {confirm && <ConfirmModal app={a} {...confirm} onClose={() => setConfirm(null)}
        onDone={async () => {
          // including again needs no reason: saved like the other cells; an exclusion is saved by the dialog itself
          if (confirm.mode === 'toggle' && confirm.enabled) { setConfirm(null); await patch(confirm.f, { enabled: true }); return; }
          setConfirm(null); reload();
        }} />}
    </div>
  );
}

function NoteModal({ f, pending, canEdit, onClose, onSave }) {
  const { t } = useI18n();
  const [v, setV] = useState(f.note || '');
  const after = { ...f, ...(pending || {}) };
  const required = needsNote(after);
  const empty = !v.trim();
  // which "with notes" status(es) make the note mandatory, e.g. "حالة الاختبار: نجح مع ملاحظة"
  const reasons = noteReasons(t, after);
  return (
    <Modal title={required ? t('note_required_title') : t('edit_note')} onClose={onClose}
      footer={canEdit && <>
        {!pending && <button className="btn btn-default" disabled={required} title={required ? t('note_required_hint') : ''} onClick={() => onSave('')}>{t('clear')}</button>}
        {pending && <button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>}
        <button className="btn btn-primary" disabled={required && empty} onClick={() => onSave(v)}>{t('save')}</button>
      </>}>
      <p className="muted small" lang="ar" dir="rtl">{f.name_ar}</p>
      {required && <Alert kind="orange">{t('note_required_msg')} <b>{reasons.join(' · ')}</b></Alert>}
      <textarea className={'input' + (required && empty ? ' input-required' : '')} rows={6} maxLength={2000} value={v} readOnly={!canEdit}
        autoFocus onChange={e => setV(e.target.value)} placeholder={required ? t('note_required_placeholder') : ''} />
    </Modal>
  );
}

// Confirm the «نجح» auto-fill (1.12.21): choosing «نجح» on an item below 100 % brings its progress up to 100 %.
// Confirm → the status and the progress are saved together; cancel → nothing is saved (the select reverts on its own).
function PassFillModal({ f, onClose, onConfirm }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async () => { setBusy(true); try { await onConfirm(); } catch { setBusy(false); } };
  return (
    <Modal title={t('pass_fill_title')} onClose={onClose}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={busy}>{t('pass_fill_confirm')}</button></>}>
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      <Alert kind="blue">{t('pass_fill_msg', { progress: pctText(f.progress) })}</Alert>
    </Modal>
  );
}

// Bulk set: progress / test status of every counted function, exclude chosen functions with one reason, or set the
// type (function / report) of chosen items.
function BulkModal({ app, can, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [field, setField] = useState(can.pct ? 'progress' : can.tst ? 'test_status' : can.tog ? 'exclude' : 'move');
  const [value, setValue] = useState(field === 'progress' ? 100 : 2);
  const [chosen, setChosen] = useState([]);              // functions to exclude / items to retype
  const [toType, setToType] = useState('report');
  const [why, setWhy] = useState(emptyReason);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [passAsk, setPassAsk] = useState(false);        // confirm the «نجح» auto-fill to 100 % before applying (1.12.21)
  const exclude = field === 'exclude', retype = field === 'item_type', move = field === 'move';
  const bulkPass = field === 'test_status' && +value === PASS;
  const [mv, setMv] = useState(emptyMove);               // move (1.10.0): module, application, reason
  const [mvPreview, setMvPreview] = useState(null);
  const moveIds = useMemo(() => chosen.map(x => x.id), [chosen]);
  const run = async () => {
    if (move) {
      setTried(true);
      if (!chosen.length || !moveReady(mv, mvPreview)) return;
      setBusy(true); setErr(null);
      try {
        const r = await api.post(path`/tracker/applications/${app.id}/bulk-move`, { to_app_id: mv.app, function_ids: moveIds, reason: mv.reason.trim() });
        toast(r.pending ? t('sent_for_approval') : t('mv_done_n', { n: r.moved?.length ?? chosen.length }), r.pending ? 'blue' : 'green'); onDone();
      } catch (e) { setErr(e); setBusy(false); }
      return;
    }
    let body = { field, value: +value };
    if (exclude) {
      setTried(true);
      if (!chosen.length || reasonProblem(why)) return;
      body = { field: 'enabled', value: false, function_ids: chosen.map(x => x.id), ...reasonBody(why) };
    }
    if (retype) {
      setTried(true);
      if (!chosen.length) return;
      body = { field: 'item_type', value: toType, function_ids: chosen.map(x => x.id) };
    }
    // Bulk «نجح»: confirm first — every affected item below 100 % is brought up to 100 % (1.12.21). Cancel the modal
    // to do nothing; the server sets the progress (its single source of truth).
    if (bulkPass && !passAsk) { setPassAsk(true); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/applications/${app.id}/bulk`, body);
      toast(r.pending ? t('sent_for_approval') : t('done_n', { n: r.updated }), r.pending ? 'blue' : 'green'); onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  const loadOwn = q => api.get('/tracker/function-options' + qs({ app_id: app.id, q })).then(r => r.options);
  // a move may take excluded items too (they carry no weight)
  const loadAll = q => api.get('/tracker/function-options' + qs({ app_id: app.id, q, with_off: 1 })).then(r => r.options);
  return (
    <Modal title={move ? t('mv_title_bulk') : t('bulk_set')} onClose={onClose} wide={exclude || retype || move}
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className={'btn ' + (exclude ? 'btn-danger' : 'btn-primary')}
          disabled={busy || (exclude && !!noteProblem(why)) || (move && (!chosen.length || chosen.length > MOVE_MAX || !moveReady(mv, mvPreview)))} onClick={run}>
          {exclude ? t('confirm_exclude_n', { n: chosen.length }) : retype ? t('confirm_type_n', { n: chosen.length })
            : move ? t('mv_confirm_n', { n: chosen.length }) : passAsk ? t('bulk_pass_fill_confirm') : t('apply')}</button></>}>
      {err && <Alert>{errText(err)}
        {blockedItems(err).length > 0 && <>
          <div className="mt-s"><b>{t('bulk_blocked_items', { n: err.data.count ?? blockedItems(err).length })}</b></div>
          <ul className="imp-errors bulk-blocked">
            {blockedItems(err).map(x => <li key={x.function_id}><span className="code">{x.code}</span> <span lang="ar" dir="rtl">{x.name_ar}</span>
              {' — '}{t(blockedItemKey(x), { progress: pctText(x.current_progress) })}</li>)}
          </ul>
        </>}
      </Alert>}
      <Field label={t('bulk_set')}>
        <select className="input" value={field} onChange={e => { setField(e.target.value); setValue(e.target.value === 'progress' ? 100 : 2); setTried(false); setErr(null); setPassAsk(false); }}>
          {can.pct && <option value="progress">{t('bulk_progress')}</option>}
          {can.tst && <option value="test_status">{t('bulk_test')}</option>}
          {can.tog && <option value="exclude">{t('bulk_exclude')}</option>}
          {can.tog && <option value="item_type">{t('bulk_type')}</option>}
          {can.mov && <option value="move">{t('bulk_move')}</option>}
        </select>
      </Field>
      {field === 'progress' && <Field label={t('progress') + ' %'}><input className="input" type="number" min={0} max={100} value={value} onChange={e => setValue(e.target.value)} /></Field>}
      {field === 'test_status' && <Field label={t('test_status')}><select className="input" value={value} onChange={e => { setValue(e.target.value); setPassAsk(false); }}>{[0, 1, 2, 3, 4].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}</select></Field>}
      {bulkPass && <Alert kind={passAsk ? 'orange' : 'blue'}>{t(passAsk ? 'bulk_pass_fill_confirm_msg' : 'bulk_pass_fill_msg')}</Alert>}
      {exclude && <>
        <Alert kind="blue">{t('exclude_msg')}</Alert>
        <div className="field">
          <MultiSelect value={chosen} onChange={setChosen} load={loadOwn} label={t('bulk_exclude_pick') + ' *'} placeholder={t('dr_duplicates_placeholder')}
            invalid={tried && !chosen.length} chipLabel={o => o.code}
            renderOption={o => <><span className="code">{o.code}</span> <span lang="ar" dir="rtl">{o.name_ar}</span></>} />
          {tried && !chosen.length && <span className="field-hint red-text">{t('bulk_exclude_none')}</span>}
        </div>
        <DisableReasonForm appId={app.id} excludeIds={chosen.map(x => x.id)} value={why} onChange={setWhy} showErrors={tried} />
      </>}
      {retype && <>
        <Alert kind="blue">{t('bulk_type_msg')}</Alert>
        <TypeChoice value={toType} onChange={setToType} label={t('bulk_type_to')} />
        <div className="field">
          <MultiSelect value={chosen} onChange={setChosen} load={loadOwn} label={t('bulk_type_pick') + ' *'} placeholder={t('dr_duplicates_placeholder')}
            invalid={tried && !chosen.length} chipLabel={o => o.code}
            renderOption={o => <><span className="code">{o.code}</span> <span lang="ar" dir="rtl">{o.name_ar}</span></>} />
          {tried && !chosen.length && <span className="field-hint red-text">{t('bulk_type_none')}</span>}
        </div>
      </>}
      {move && <>
        <Alert kind="blue">{t('bulk_move_msg', { max: MOVE_MAX })}</Alert>
        <div className="field">
          <MultiSelect value={chosen} onChange={setChosen} load={loadAll} label={t('bulk_move_pick') + ' *'} placeholder={t('dr_duplicates_placeholder')}
            invalid={tried && !chosen.length} chipLabel={o => o.code}
            renderOption={o => <><span className="code">{o.code}</span> <span lang="ar" dir="rtl">{o.name_ar}</span>{o.enabled === false && <span className="muted small"> ({t('mv_not_counted')})</span>}</>} />
          {tried && !chosen.length && <span className="field-hint red-text">{t('bulk_move_none')}</span>}
        </div>
        <MoveFields appId={app.id} ids={moveIds} value={mv} onChange={setMv} onPreview={setMvPreview} showErrors={tried} />
      </>}
    </Modal>
  );
}

// Function / report choice (add-function, bulk set): two radio cards with the type's icon and colour.
function TypeChoice({ value, onChange, label }) {
  const { t } = useI18n();
  return (
    <fieldset className="field it-choice">
      <legend className="field-label">{label}</legend>
      <div className="it-choice-row">
        {ITEM_TYPES.map(v => (
          <label key={v} className={'it-choice-opt it-' + v + (value === v ? ' on' : '')}>
            <input type="radio" name="item_type" value={v} checked={value === v} onChange={() => onChange(v)} />
            <TypeBadge type={v} />
            <span className="muted small">{t(v === 'report' ? 'it_legend_report_none' : 'it_legend_function')}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// Before → after percentages of the application, its department and the project for a proposed change.
function useImpact(appId, body, key) {
  const [v, setV] = useState(null);
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      api.post(path`/tracker/applications/${appId}/impact`, body).then(r => { if (alive) setV(r); }).catch(() => { if (alive) setV(null); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [appId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

function ImpactTable({ impact }) {
  const { t } = useI18n();
  if (!impact) return <div className="muted small">{t('loading')}…</div>;
  const rows = [['app', t('application')], ['dept', t('department')], ['total', t('project')]];
  return (
    <div className="impact">
      <div className="impact-title">{t('impact_title')}</div>
      <table className="table">
        <thead><tr><th /><th className="num-col">{t('before')}</th><th className="num-col">{t('after')}</th><th className="num-col">{t('change')}</th></tr></thead>
        <tbody>
          {rows.map(([k, label]) => {
            const d = pctDelta(impact[k].before, impact[k].after, pc);
            return (
              <tr key={k}>
                <td>{label}</td>
                <td className="num-col num">{pc(impact[k].before)}%</td>
                <td className="num-col num"><b>{pc(impact[k].after)}%</b></td>
                <td className={'num-col num ' + (d.tone === 'muted' ? 'muted' : d.tone + '-text')}>{d.text}</td>
              </tr>
            );
          })}
          <tr><td>{t('included_functions')}</td><td className="num-col num">{impact.included.before}</td><td className="num-col num"><b>{impact.included.after}</b></td>
            <td className="num-col num muted">{countDelta(impact.included.after - impact.included.before)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function AddModal({ app, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [f, setF] = useState({ name_ar: '', name_en: '', reference: '', weight: 1, progress: 0, enabled: true, item_type: 'function' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const preview = { weight: +f.weight || 0, progress: +f.progress || 0, enabled: f.enabled, item_type: f.item_type };
  const impact = useImpact(app.id, { add: preview }, JSON.stringify(preview));
  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/applications/${app.id}/functions`, { ...f, weight: +f.weight, progress: +f.progress });
      toast(r?.pending ? t('sent_for_approval') : t('fn_added'), r?.pending ? 'blue' : 'green'); onDone();
    } catch (e) { setErr(e); }
    setBusy(false);
  };
  return (
    <Modal title={t('add_function')} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className="btn btn-primary" onClick={run} disabled={!f.name_ar.trim() || busy}>{t('confirm_add')}</button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <Field label={t('fn_name_ar') + ' *'}><textarea className="input" rows={2} lang="ar" dir="rtl" value={f.name_ar} onChange={e => setF({ ...f, name_ar: e.target.value })} /></Field>
      <div className="form-grid">
        <Field label={t('fn_name_en')}><input className="input" dir="ltr" value={f.name_en} onChange={e => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t('requirement_reason')}><input className="input" value={f.reference} onChange={e => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label={t('weight')}><input className="input" type="number" min={0} max={1000} step={0.5} value={f.weight} onChange={e => setF({ ...f, weight: e.target.value })} /></Field>
        <Field label={t('progress') + ' %'}><input className="input" type="number" min={0} max={100} step={5} value={f.progress} onChange={e => setF({ ...f, progress: e.target.value })} /></Field>
      </div>
      <TypeChoice value={f.item_type} onChange={v => setF({ ...f, item_type: v })} label={t('item_type')} />
      <label className="check mb"><input type="checkbox" checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} /> <b>{t('include_in_calc')}</b></label>
      <ImpactTable impact={impact} />
    </Modal>
  );
}

// Confirmation with impact for: remove (reason required), restore, include / exclude (exclusion: reason required).
function ConfirmModal({ app, f, mode, enabled, onClose, onDone }) {
  const { t, errText } = useI18n();
  const [reason, setReason] = useState('');
  const [why, setWhy] = useState(emptyReason);          // why it is excluded (unticked)
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const excluding = mode === 'toggle' && !enabled;
  const body = mode === 'remove' ? { drop: [f.id] } : { set: [{ function_id: f.id, enabled: mode === 'restore' ? true : enabled }] };
  const impact = useImpact(app.id, body, mode + f.id + enabled);
  const title = { remove: t('fn_remove_title'), restore: t('fn_restore_title'), toggle: enabled ? t('include_title') : t('exclude_title') }[mode];
  const run = async () => {
    if (excluding) {
      setTried(true);
      if (reasonProblem(why)) return;
      setBusy(true); setErr(null);
      try {
        const r = await api.patch(path`/tracker/functions/${f.id}`, { enabled: false, ...reasonBody(why) });
        toast(r?.pending ? t('sent_for_approval') : t('fn_excluded'), r?.pending ? 'blue' : 'green');
        onDone();
      } catch (e) { setErr(e); setBusy(false); }
      return;
    }
    if (mode === 'toggle') return onDone();
    setBusy(true); setErr(null);
    try {
      const r = await api.post(path`/tracker/functions/${f.id}/${mode}`, mode === 'remove' ? { reason } : {});
      toast(r?.pending ? t('sent_for_approval') : mode === 'remove' ? t('fn_removed') : t('fn_restored'), r?.pending ? 'blue' : 'green');
      onDone();
    } catch (e) { setErr(e); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} wide
      footer={<><button className="btn btn-default" onClick={onClose}>{t('cancel')}</button>
        <button className={'btn ' + (mode === 'remove' ? 'btn-danger' : 'btn-primary')} disabled={busy || (mode === 'remove' && !reason.trim()) || (excluding && !!noteProblem(why))} onClick={run}>
          {{ remove: t('confirm_remove'), restore: t('confirm_restore'), toggle: enabled ? t('confirm_include') : t('confirm_exclude') }[mode]}
        </button></>}>
      {err && <Alert>{errText(err)}</Alert>}
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      {mode === 'remove' && <Alert kind="orange">{f.source === 'custom' ? t('fn_remove_msg_custom') : t('fn_remove_msg_scope')}</Alert>}
      {mode === 'toggle' && <Alert kind="blue">{enabled ? t('include_msg') : t('exclude_msg')}</Alert>}
      {excluding && <DisableReasonForm appId={app.id} excludeIds={[f.id]} value={why} onChange={setWhy} showErrors={tried} />}
      {mode === 'remove' && <Field label={t('remove_reason') + ' *'}><textarea className="input" rows={3} maxLength={1000} value={reason} autoFocus onChange={e => setReason(e.target.value)} /></Field>}
      <ImpactTable impact={impact} />
    </Modal>
  );
}

// «منقول من <application> / <old code>» (1.10.0): the move that brought the item here; the tooltip gives the reason, who
// and when; the button opens the item's whole move history. The application's name is shown only within the reader's
// scope («تطبيق آخر» otherwise).
function MovedBadge({ m, onOpen }) {
  const { t, nm, fmtDate } = useI18n();
  const app = nm(m, 'from_app_name') || t('mv_badge_other');
  const tip = t('mv_badge_tip', { date: fmtDate(m.moved_at), name: m.moved_by_name || '—', reason: m.reason });
  return (
    <button type="button" className="moved-chip" onClick={onOpen} title={tip} aria-label={t('mv_badge', { app, code: m.from_code }) + ' — ' + tip}>
      <Icon name="move" size={12} /> {t('mv_badge', { app, code: m.from_code })}
    </button>
  );
}

function MoveHistory({ f, onClose }) {
  const { t, nm, fmtDate } = useI18n();
  const place = (m, side) => `${nm(m, side + '_app_name') || m[side + '_app_id']}${nm(m, side + '_dept_name') ? ' (' + nm(m, side + '_dept_name') + ')' : ''}`;
  return (
    <Modal title={t('mv_history_title')} onClose={onClose} wide footer={<button className="btn btn-default" onClick={onClose}>{t('close')}</button>}>
      <p lang="ar" dir="rtl"><span className="code">{f.code}</span> {f.name_ar}</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('date')}</th><th>{t('mv_history_from')}</th><th>{t('mv_history_to')}</th><th className="num-col">{t('mv_history_share')}</th><th>{t('mv_history_by')}</th><th>{t('reason')}</th></tr></thead>
          <tbody>
            {(f.moves || []).map(m => (
              <tr key={m.id}>
                <td className="nowrap">{fmtDate(m.moved_at)}</td>
                <td>{place(m, 'from')} <span className="code">{m.from_code}</span></td>
                <td>{place(m, 'to')} <span className="code">{m.to_code}</span></td>
                <td className="num-col num">{m.weight_mode === 'auto' ? '—' : (+m.weight_share).toFixed(2)}</td>
                <td>{m.moved_by_name || '—'}{m.request_id && <div className="muted small">{t('mv_history_request', { id: m.request_id })}</div>}</td>
                <td className="rn-reason-text">{m.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}
