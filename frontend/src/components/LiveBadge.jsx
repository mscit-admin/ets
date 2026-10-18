// Small "live updates" status: connected, reconnecting, or polling every 30 s (lib/live.js).
import { useI18n } from '../i18n/index.jsx';
import { useLiveStatus } from '../lib/live.js';

export function LiveBadge() {
  const { t } = useI18n();
  const s = useLiveStatus();
  if (s === 'off') return null;
  return (
    <span className={'live-badge ' + s} role="status" title={t('live_hint_' + s)}>
      <i aria-hidden="true" />{t('live_' + s)}
    </span>
  );
}
