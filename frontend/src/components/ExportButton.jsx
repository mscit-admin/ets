import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { useAuth } from '../lib/auth.jsx';
import { downloadFile, path, qs } from '../lib/api.js';
import { Icon } from './Icon.jsx';
import { toast } from './ui.jsx';

// «Export to Excel» for a screen: GET /api/export/<report>.xlsx with the screen's current filters and language.
// Shown only to holders of 'exp' (adminOnly: also the administrator role); the server checks both again, limits
// the rows to the reader's scope and records the export in the audit trail (export policy).
export function ExportButton({ report, params = {}, adminOnly = false, label }) {
  const { t, lang, errText } = useI18n();
  const { can, user } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!can('exp') || (adminOnly && (user?.role !== 'admin' || !can('usr')))) return null;
  const run = async () => {
    setBusy(true);
    try { await downloadFile(path`/export/${report + '.xlsx'}` + qs({ ...params, lang }), `ets-${report}.xlsx`); }
    catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };
  return (
    <button type="button" className="btn btn-default btn-sm" onClick={run} disabled={busy}>
      <Icon name="sheet" size={14} /> {busy ? t('exporting') : label || t('export_xlsx')}
    </button>
  );
}
