import { useState } from 'react';
import { useI18n } from '../i18n/index.jsx';
import { Icon } from './Icon.jsx';

// A complete "how to read this screen" guide for the project-status page: a toggle button and, when open, a panel
// that explains every section and metric (status badge, schedule performance, forecast, S-curve, recommendations,
// departments and quality). Term labels reuse the same i18n keys the page itself shows, so wording stays in sync;
// each description is a g_d_* key. Pure presentational, no data — safe to render once below the page header.
const GROUPS = [
  { h: 'g_h_overall', rows: [['g_t_status', 'g_d_status'], ['time_elapsed', 'g_d_time'], ['work_done', 'g_d_work']] },
  { h: 'sec_schedule_perf', rows: [['planned_now', 'g_d_planned'], ['actual_now', 'g_d_actual'], ['deviation', 'g_d_deviation'],
    ['schedule_delay', 'g_d_delay'], ['spi', 'g_d_spi'], ['spi_t', 'g_d_spit']] },
  { h: 'sec_forecast', rows: [['forecast_end', 'g_d_forecast'], ['current_pace', 'g_d_pace'], ['required_pace', 'g_d_reqpace'],
    ['days_remaining', 'g_d_days'], ['forecast_by_spi', 'g_d_forecast_spi']] },
  { h: 'schedule_title', rows: [['schedule_title', 'g_d_curve']] },
  { h: 'recommendations', rows: [['recommendations', 'g_d_insights']] },
  { h: 'dept_vs_plan', rows: [['dept_vs_plan', 'g_d_dept']] },
  { h: 'sec_quality', rows: [['functions_state', 'g_d_functions'], ['quality_flags', 'g_d_quality']] },
];

export function StatusGuide() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="status-guide-wrap">
      <button type="button" className={'btn btn-default btn-sm' + (open ? ' active' : '')} aria-expanded={open}
        onClick={() => setOpen(o => !o)}>
        <Icon name="info" size={14} /> {t('guide_btn')}
      </button>
      {open && (
        <section className="card status-guide" role="note" aria-label={t('guide_title')}>
          <h3>{t('guide_title')}</h3>
          <p className="muted small">{t('guide_intro')}</p>
          {GROUPS.map(g => (
            <div key={g.h} className="sg-group">
              <h4>{t(g.h)}</h4>
              <dl>
                {g.rows.map(([term, desc]) => (
                  <div key={desc} className="sg-row"><dt>{t(term)}</dt><dd>{t(desc)}</dd></div>
                ))}
              </dl>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
