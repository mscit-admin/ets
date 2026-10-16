// Users → Import users: template → choose an .xlsx / .csv file (read in the browser) → server-side check of every
// row → create all of them at once → the one-time temporary passwords, shown here only.
import { useMemo, useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Icon } from '../components/Icon.jsx';
import { Alert, Field, Indicator, Loading, Modal, toast, useLoad } from '../components/ui.jsx';
import { MAX_ROWS, TEMPLATE_COLUMNS, apiRow, downloadCsv, downloadTemplate, downloadXlsx, listText, matchers, readImportFile, resolveRow } from '../lib/userImport.js';

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');

export function UserImport({ onClose, onDone }) {
  const { t, nm, lang, errText } = useI18n();
  const meta = useLoad(() => api.get('/users/meta'), []);
  const [step, setStep] = useState('choose');          // choose → preview → done
  const [file, setFile] = useState(null);
  const [rows, setRows] = useState([]);
  const [check, setCheck] = useState(null);             // { results, ok, errors }
  const [created, setCreated] = useState(null);         // [{ username, temporary_password }]
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const msg = code => t('err_' + code) === 'err_' + code ? code : t('err_' + code, { max: MAX_ROWS });
  const fieldName = f => ({ role: t('role'), language: t('language'), departments: t('department'), applications: t('application') })[f] || f;
  // the messages of one result: the value that was not recognised when the server names it, else the generic text
  const messagesOf = x => {
    const out = [];
    for (const c of x?.errors || []) {
      const ds = (x.details || []).filter(d => d.code === c);
      if (!ds.length) { out.push(msg(c)); continue; }
      for (const d of ds) {
        const key = c === 'invalid_scope' ? `imp_d_invalid_scope_${d.field}` : 'imp_d_' + c;
        out.push(t(key) === key ? `${msg(c)}: ${d.value}` : t(key, { value: d.value, field: fieldName(d.field), matches: (d.matches || []).join(', ') }));
      }
    }
    return out;
  };
  const ix = useMemo(() => (meta.data ? matchers(meta.data) : null), [meta.data]);
  const byId = (list, id) => list.find(o => o.id === id);
  const close = () => {
    if (busy) return;
    if (step === 'done' && !saved && !window.confirm(t('imp_close_unsaved'))) return;
    if (step === 'done') onDone(); else onClose();
  };

  const choose = async f => {
    setErr(null); setCheck(null); setRows([]); setFile(f || null);
    if (!f) return;
    setBusy(true);
    try {
      const r = await readImportFile(f);
      if (r.missing.length) throw Object.assign(new Error(), { code: 'import_missing_columns', data: { columns: r.missing.join(', ') } });
      if (!r.rows.length) throw Object.assign(new Error(), { code: 'import_no_rows' });
      if (r.rows.length > MAX_ROWS) throw Object.assign(new Error(), { code: 'too_many_rows', data: { max: MAX_ROWS } });
      setRows(r.rows);
      setCheck(await api.post('/users/import/preview', { rows: r.rows.map(apiRow) }));
      setStep('preview');
    } catch (e) { setErr(e); setStep('choose'); }
    setBusy(false);
  };

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.post('/users/import', { rows: rows.map(apiRow) });
      setCreated(r.users); setStep('done');
      toast(t('imp_created_n', { n: r.created }));
    } catch (e) {
      if (e.code === 'import_has_errors' && e.data?.results) setCheck(e.data);
      setErr(e);
    }
    setBusy(false);
  };

  const resultOf = i => check?.results[i];
  const errorReport = kind => {
    const head = ['line', ...TEMPLATE_COLUMNS, 'status', 'messages'];
    const body = rows.map((r, i) => {
      const x = resultOf(i);
      return [r.line, ...TEMPLATE_COLUMNS.map(c => r[c]), x?.status === 'ok' ? t('imp_ok') : t('imp_error'), messagesOf(x).join(' | ')];
    });
    const name = `ets-users-import-errors-${stamp()}`;
    return kind === 'csv' ? downloadCsv(name + '.csv', [head, ...body])
      : downloadXlsx(name + '.xlsx', [{ name: 'errors', rows: [head, ...body], rtl: lang === 'ar',
        widths: [6, 18, 26, 24, 16, 12, 24, 18, 18, 24, 18, 18, 10, 70] }]);
  };
  const passwordsTable = () => [['username', 'temporary_password'], ...created.map(u => [u.username, u.temporary_password])];
  const savePasswords = async kind => {
    const name = `ets-new-users-${stamp()}`;
    if (kind === 'csv') downloadCsv(name + '.csv', passwordsTable());
    else await downloadXlsx(name + '.xlsx', [{ name: 'users', rows: passwordsTable(), widths: [24, 24] }]);
    setSaved(true);
  };
  const copyPasswords = async () => {
    try {
      await navigator.clipboard.writeText(passwordsTable().map(r => r.join('\t')).join('\n'));
      toast(t('copied')); setSaved(true);
    } catch { toast(t('imp_copy_failed'), 'red'); }
  };

  const footer = step === 'done'
    ? <button className="btn btn-primary" onClick={close}>{t('imp_finish')}</button>
    : <>
        <button className="btn btn-default" onClick={close} disabled={busy}>{t('cancel')}</button>
        {step === 'preview' && <button className="btn btn-primary" onClick={run} disabled={busy || !check || check.errors > 0}>
          {busy ? t('imp_creating') : t('imp_create_n', { n: rows.length })}</button>}
      </>;

  return (
    <Modal title={t('imp_title')} onClose={close} wide footer={footer}>
      {err && <Alert>{errText(err)}</Alert>}

      {step !== 'done' && <>
        <p className="muted small">{t('imp_intro', { max: MAX_ROWS })}</p>
        <div className="row gap wrap mb">
          <span className="small"><b>{t('imp_template')}:</b></span>
          <button className="btn btn-default btn-sm" disabled={!meta.data} onClick={() => downloadTemplate('xlsx', meta.data, t, lang).catch(e => setErr(e))}>
            <Icon name="download" size={14} /> Excel (.xlsx)</button>
          <button className="btn btn-default btn-sm" disabled={!meta.data} onClick={() => downloadTemplate('csv', meta.data, t, lang)}>
            <Icon name="download" size={14} /> CSV</button>
        </div>
        {meta.data && <HelpLists meta={meta.data} />}
        <Field label={t('imp_choose_file')} hint={t('imp_file_hint')}>
          <input className="input" type="file" accept=".xlsx,.csv" disabled={busy} onChange={e => { choose(e.target.files[0]); e.target.value = ''; }} />
        </Field>
        {file && <p className="muted small" dir="ltr">{file.name}</p>}
        {busy && step === 'choose' && <Loading />}
      </>}

      {step === 'preview' && check && <>
        <div className="row gap wrap mb">
          <Indicator color="green">{t('imp_ok_n', { n: check.ok })}</Indicator>
          {check.errors > 0 && <Indicator color="red">{t('imp_errors_n', { n: check.errors })}</Indicator>}
          {check.errors > 0 && <>
            <span className="sep-v" />
            <button className="btn btn-default btn-sm" onClick={() => errorReport('xlsx').catch(e => setErr(e))}><Icon name="download" size={14} /> {t('imp_error_report')} (.xlsx)</button>
            <button className="btn btn-default btn-sm" onClick={() => errorReport('csv')}><Icon name="download" size={14} /> {t('imp_error_report')} (.csv)</button>
          </>}
        </div>
        {check.errors > 0 ? <Alert kind="orange">{t('imp_fix_and_retry')}</Alert> : <Alert kind="green">{t('imp_ready', { n: rows.length })}</Alert>}
        {busy && <Alert kind="blue">{t('imp_creating_hint')}</Alert>}
        <div className="table-wrap imp-table">
          <table className="table">
            <thead><tr><th>{t('imp_line')}</th><th>{t('username')}</th><th>{t('full_name')}</th><th>{t('role')}</th>
              <th>{t('language')}</th><th>{t('imp_departments')}</th><th>{t('imp_applications')}</th><th>{t('status')}</th></tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const x = resultOf(i);
                // what will be created, in names (same matching as the server); a value not recognised is shown as typed
                const v = ix ? resolveRow(ix, r) : {};
                const role = v.role && byId(meta.data.roles, v.role);
                const fullScope = role?.full_scope;
                const names = (list, ids, typed) => (ids?.length ? ids.map(id => nm(byId(list, id))).join('، ') : typed);
                return (
                  <tr key={i} className={x?.status === 'error' ? 'row-error' : ''}>
                    <td className="num">{r.line}</td>
                    <td dir="ltr" className="code">{r.username}</td>
                    <td>{r.full_name}</td>
                    <td>{role ? nm(role) : <span className="muted">{r.role}</span>}</td>
                    <td>{v.language ? t('au_lang_' + v.language) : v.language === '' ? <span className="muted small">{t('imp_lang_default')}</span> : <span className="muted">{r.language}</span>}</td>
                    {fullScope ? <td colSpan={2} className="muted small">{t('full_scope')}</td> : <>
                      <td>{names(meta.data?.departments, v.departments, listText(r, 'departments'))}</td>
                      <td>{names(meta.data?.applications, v.applications, listText(r, 'applications'))}</td>
                    </>}
                    <td>{x?.status === 'ok' ? <Indicator color="green">{t('imp_ok')}</Indicator>
                      : <>{<Indicator color="red">{t('imp_error')}</Indicator>}<ul className="imp-errors">{messagesOf(x).map((m, k) => <li key={k}>{m}</li>)}</ul></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}

      {step === 'done' && created && <>
        <Alert kind="orange"><b>{t('imp_passwords_once')}</b></Alert>
        <p className="small">{t('imp_passwords_hint', { n: created.length })}</p>
        <div className="row gap wrap mb">
          <button className="btn btn-default btn-sm" onClick={copyPasswords}><Icon name="note" size={14} /> {t('copy')}</button>
          <button className="btn btn-default btn-sm" onClick={() => savePasswords('xlsx').catch(e => setErr(e))}><Icon name="download" size={14} /> {t('download')} (.xlsx)</button>
          <button className="btn btn-default btn-sm" onClick={() => savePasswords('csv')}><Icon name="download" size={14} /> {t('download')} (.csv)</button>
        </div>
        <div className="table-wrap imp-table">
          <table className="table">
            <thead><tr><th>{t('username')}</th><th>{t('imp_temp_password')}</th></tr></thead>
            <tbody>{created.map(u => <tr key={u.username}><td dir="ltr" className="code">{u.username}</td><td dir="ltr" className="code">{u.temporary_password}</td></tr>)}</tbody>
          </table>
        </div>
      </>}
    </Modal>
  );
}

// Valid role / department / application ids, for filling the file (also on the template's "help" sheet).
function HelpLists({ meta }) {
  const { t, nm } = useI18n();
  return (
    <details className="imp-help mb">
      <summary>{t('imp_help_title')}</summary>
      <p className="muted small">{t('imp_help_text')}</p>
      <div className="imp-help-grid">
        <table className="table">
          <thead><tr><th>{t('role')}</th><th>id</th></tr></thead>
          <tbody>{meta.roles.map(r => <tr key={r.id}><td>{nm(r)}{!r.full_scope && <span className="muted small"> · {t('imp_scope_needed')}</span>}</td><td dir="ltr" className="code">{r.id}</td></tr>)}</tbody>
        </table>
        <table className="table">
          <thead><tr><th>{t('imp_departments')}</th><th>id</th></tr></thead>
          <tbody>{meta.departments.map(d => <tr key={d.id}><td>{nm(d)}</td><td dir="ltr" className="code">{d.id}</td></tr>)}</tbody>
        </table>
        <table className="table">
          <thead><tr><th>{t('imp_applications')}</th><th>id</th></tr></thead>
          <tbody>{meta.applications.map(a => <tr key={a.id}><td>{nm(a)}</td><td dir="ltr" className="code">{a.id}</td></tr>)}</tbody>
        </table>
      </div>
    </details>
  );
}
