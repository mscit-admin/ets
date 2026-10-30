import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/index.jsx';
import { api, path } from '../../lib/api.js';
import { pc } from '../../lib/format.js';
import { TypeBadge } from '../ItemType.jsx';
import { ITEM_TYPES, countDelta, pctDelta } from '../../lib/itemRules.js';

// Function / report choice (add-function, bulk set): two radio cards with the type's icon and colour.
export function TypeChoice({ value, onChange, label }) {
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
export function useImpact(appId, body, key) {
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

export function ImpactTable({ impact }) {
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
