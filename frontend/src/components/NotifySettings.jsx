// Settings → «الإشعارات» (1.9.0): on/off, schedule (daily hour, work days, time zone), thresholds, and the policy
// matrix type × role with «الجوال» (may go to the phone) and «إلزامي» (mandatory for the roles it is on for).
// Cells that are not eligible (—) cannot be turned on, mandatory-in-code cells (🔒) cannot be turned off: the
// server refuses both (notify-catalog.js). Saved with the page's Save button (PUT /api/settings), audited.
import { useI18n } from '../i18n/index.jsx';
import { api } from '../lib/api.js';
import { Card, Field, Loading, useLoad } from './ui.jsx';
import { Icon } from './Icon.jsx';

const CATS = ['approvals', 'tracking', 'plan', 'security', 'system'];
// [key, min, max, step]
const THRESHOLDS = [
  ['notify.stuck_days', 3, 90], ['notify.untested_days', 1, 60], ['notify.failed_retest_days', 1, 60], ['notify.not_started_days', 7, 180],
  ['notify.approval_remind_hours', 4, 168], ['notify.approval_escalate_days', 1, 30], ['notify.import_overdue_days', 1, 30],
  ['notify.dept_risk_gap', 1, 50], ['notify.dept_delay_gap', 1, 50], ['notify.dept_stalled_points', 0, 10, 0.1], ['notify.close_warning_days', 1, 180],
  ['notify.failed_logins_threshold', 5, 500], ['notify.access_denied_threshold', 5, 1000], ['notify.server_errors_threshold', 1, 1000],
  ['notify.backup_max_age_hours', 2, 168], ['notify.rate_cap_per_hour', 5, 500], ['notify.retention_days', 30, 730], ['notify.device_idle_days', 7, 365],
];

export function NotifySettingsCard({ s, set }) {
  const { t, nm } = useI18n();
  const meta = useLoad(() => api.get('/notifications/policy-meta'), []);
  const pol = s['notify.policy'] || {};
  const cell = k => pol[k] || meta.data?.policy[k] || { roles: {}, push: false, mandatory: false };
  const setCell = (k, patch) => set('notify.policy', { ...pol, [k]: { ...cell(k), ...patch } });
  const setRole = (k, role, on) => setCell(k, { roles: { ...cell(k).roles, [role]: on } });
  const days = s['notify.work_days'] || [];
  const num = (k, min, max, step = 1) => (
    <input className="input" type="number" min={min} max={max} step={step} value={s[k] ?? ''}
      onChange={e => set(k, step < 1 ? parseFloat(e.target.value) || 0 : parseInt(e.target.value, 10) || 0)} />
  );
  return (
    <section id="notifications">
      <Card title={t('sec_notifications')}>
        <label className="check strong"><input type="checkbox" checked={!!s['notify.enabled']} onChange={e => set('notify.enabled', e.target.checked)} /> {t('notify_enabled')}</label>
        <div className="field-hint mt-s">{t('notify_enabled_hint')}</div>

        <h4 className="mt">{t('notify_schedule')}</h4>
        <div className="form-grid">
          <Field label={t('notify_digest_hour')} hint={t('notify_digest_hour_hint')}>
            <select className="input" value={s['notify.digest_hour']} onChange={e => set('notify.digest_hour', +e.target.value)}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </select>
          </Field>
          <Field label={t('notify_timezone')} hint={t('notify_timezone_hint')}>
            <input className="input" dir="ltr" value={s['notify.timezone'] || ''} onChange={e => set('notify.timezone', e.target.value)} />
          </Field>
          <div className="field"><span className="field-label">{t('notify_work_days')}</span>
            <div className="days-row" role="group" aria-label={t('notify_work_days')}>
              {[0, 1, 2, 3, 4, 5, 6].map(d => (
                <label key={d} className="check"><input type="checkbox" checked={days.includes(d)}
                  onChange={e => set('notify.work_days', e.target.checked ? [...days, d].sort() : days.filter(x => x !== d))} /> {t('wd_' + d)}</label>
              ))}
            </div>
          </div>
        </div>

        <h4 className="mt">{t('notify_thresholds')}</h4>
        <div className="form-grid">
          {THRESHOLDS.map(([k, min, max, step]) => (
            <Field key={k} label={t('ns_' + k.slice(7))} hint={`${min}–${max}`}>{num(k, min, max, step)}</Field>
          ))}
        </div>

        <h4 className="mt">{t('notify_policy')}</h4>
        <div className="field-hint mb-s">{t('notify_policy_hint')}</div>
        {!meta.data ? <Loading /> : (
          <>
            <div className="matrix-wrap">
              <table className="matrix">
                <thead>
                  <tr>
                    <th scope="col">{t('notif_type')}</th>
                    {meta.data.roles.map(r => <th key={r.id} scope="col">{nm(r)}</th>)}
                    <th scope="col">{t('notif_phone')}</th>
                    <th scope="col">{t('notif_mandatory')}</th>
                  </tr>
                </thead>
                <tbody>
                  {CATS.map(c => [
                    <tr key={c} className="cat"><td colSpan={meta.data.roles.length + 3}>{t('ncat_' + c)}</td></tr>,
                    ...meta.data.types.filter(x => x.category === c).map(x => {
                      const v = cell(x.type);
                      return (
                        <tr key={x.type}>
                          <th scope="row"><span className="code">{x.code}</span>{t('nt_' + x.type)}</th>
                          {meta.data.roles.map(r => {
                            if (!x.eligible.includes(r.id)) return <td key={r.id}><span className="na" title={t('notify_cell_na')} aria-label={t('notify_cell_na')}>—</span></td>;
                            if (x.locked.includes(r.id)) return <td key={r.id}><span className="lock" title={t('notify_cell_locked')} aria-label={t('notify_cell_locked')}><Icon name="lock" size={14} /></span></td>;
                            return (
                              <td key={r.id}><input type="checkbox" checked={!!v.roles[r.id]} onChange={e => setRole(x.type, r.id, e.target.checked)}
                                aria-label={`${t('nt_' + x.type)} — ${nm(r)}`} /></td>
                            );
                          })}
                          <td><input type="checkbox" checked={!!v.push} onChange={e => setCell(x.type, { push: e.target.checked })}
                            aria-label={`${t('nt_' + x.type)} — ${t('notif_phone')}`} /></td>
                          <td><input type="checkbox" checked={!!v.mandatory} onChange={e => setCell(x.type, { mandatory: e.target.checked })}
                            aria-label={`${t('nt_' + x.type)} — ${t('notif_mandatory')}`} /></td>
                        </tr>
                      );
                    }),
                  ])}
                </tbody>
              </table>
            </div>
            <div className="matrix-legend">
              <span>☑ {t('notify_legend_on')}</span><span>— {t('notify_cell_na')}</span>
              <span><Icon name="lock" size={12} /> {t('notify_cell_locked')}</span><span>{t('notify_legend_phone')}</span>
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
