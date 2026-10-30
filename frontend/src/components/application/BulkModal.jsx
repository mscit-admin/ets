import { useMemo, useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path, qs } from '../../lib/api.js';
import { Alert, Field, Modal, toast } from '../ui.jsx';
import { MultiSelect } from '../MultiSelect.jsx';
import { DisableReasonForm } from '../DisableReason.jsx';
import { MoveFields } from '../MoveDialog.jsx';
import { TypeChoice } from './common.jsx';
import {
  MOVE_MAX, PASS, blockedItemKey, blockedItems, emptyMove, emptyReason, moveReady,
  noteProblem, pctText, reasonBody, reasonProblem,
} from '../../lib/itemRules.js';

// Bulk set: progress / test status of every counted function, exclude chosen functions with one reason, or set the
// type (function / report) of chosen items.
export function BulkModal({ app, can, onClose, onDone }) {
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
      {field === 'test_status' && <Field label={t('test_status')}><select className="input" value={value} onChange={e => { setValue(e.target.value); setPassAsk(false); }}>{[0, 1, 2, 3, 4, 5, 6, 7].map(i => <option key={i} value={i}>{t('ts_' + i)}</option>)}</select></Field>}
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
