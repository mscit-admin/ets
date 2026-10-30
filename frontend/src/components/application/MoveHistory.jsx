import { useI18n } from '../../i18n/index.jsx';
import { Modal } from '../ui.jsx';
import { Icon } from '../Icon.jsx';

// «منقول من <application> / <old code>» (1.10.0): the move that brought the item here; the tooltip gives the reason, who
// and when; the button opens the item's whole move history. The application's name is shown only within the reader's
// scope («تطبيق آخر» otherwise).
export function MovedBadge({ m, onOpen }) {
  const { t, nm, fmtDate } = useI18n();
  const app = nm(m, 'from_app_name') || t('mv_badge_other');
  const tip = t('mv_badge_tip', { date: fmtDate(m.moved_at), name: m.moved_by_name || '—', reason: m.reason });
  return (
    <button type="button" className="moved-chip" onClick={onOpen} title={tip} aria-label={t('mv_badge', { app, code: m.from_code }) + ' — ' + tip}>
      <Icon name="move" size={12} /> {t('mv_badge', { app, code: m.from_code })}
    </button>
  );
}

export function MoveHistory({ f, onClose }) {
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
