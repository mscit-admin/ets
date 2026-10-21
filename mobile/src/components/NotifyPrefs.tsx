// «التنبيهات» of حسابي (web: components/ProfileNotify.jsx NotifyPrefsCard): the daily summaries on / off, then the
// alert types this user may receive, by category, each with an in-app switch and — when the policy allows phone
// notifications for it — a phone switch. Mandatory types (for this role) and types an administrator turned off are
// locked with the reason. GET / PUT /api/notifications/prefs; the rules are shared (frontend/src/lib/notifyTabs.js).
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Toggle } from './Toggle';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { toast } from '@/lib/toast';
import { PREF_CATS, prefFlip, prefLockKey, prefLocked, prefOn, prefPhoneShown, type PrefKey, type Prefs, type PrefType } from '@/shared/web';
import { colors, fontSize, space } from '@/theme';
import { Icon } from './Icon';
import { SwitchRow } from './form';
import { Card, ErrorBox, Loading, Pill, Txt } from './ui';

function PrefSwitch({ x, k, label, busy, onFlip }: { x: PrefType; k: PrefKey; label: string; busy: boolean; onFlip: (x: PrefType, k: PrefKey, on: boolean) => void }) {
  const { t } = useI18n();
  const lock = prefLockKey(x);
  return (
    <View style={st.toggle}>
      <Txt size={fontSize.xs} color={colors.textMuted}>{label}</Txt>
      <Toggle value={prefOn(x, k)} disabled={busy || prefLocked(x, k)} onValueChange={on => onFlip(x, k, on)}
        accessibilityLabel={`${label}: ${t('nt_' + x.type)}`} accessibilityHint={lock ? t(lock) : undefined} />
    </View>
  );
}

export function NotifyPrefs() {
  const { t, errText } = useI18n();
  const { api } = useSession();
  const { data, error, reload } = useLoad(o => api.get<Prefs>('/notifications/prefs', o), [], { live: false });
  const [busy, setBusy] = useState(false);
  if (error && !data) return <Card title={t('notifications')}><ErrorBox error={error} onRetry={reload} /></Card>;
  if (!data) return <Card title={t('notifications')}><Loading /></Card>;
  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try { await api.put('/notifications/prefs', body); toast(t('saved'), 'green'); reload(); } catch (e) { toast(errText(e), 'red'); }
    setBusy(false);
  };
  const flip = (x: PrefType, k: PrefKey, on: boolean) => save(prefFlip(data.types, k, x.type, on));
  return (
    <Card title={t('notifications')}>
      <Txt size={fontSize.s} color={colors.textMuted}>{t('notif_prefs_hint')}</Txt>
      <SwitchRow label={t('notif_digest')} hint={t('notif_digest_hint')} value={data.digest} disabled={busy} onValueChange={v => save({ digest: v })} />
      {!data.types.length ? <Txt color={colors.textMuted}>{t('notif_no_types')}</Txt> : PREF_CATS.filter(c => data.types.some(x => x.category === c)).map(c => (
        <View key={c} style={st.cat}>
          <Txt w={700} size={fontSize.s} color={colors.gray700} accessibilityRole="header">{t('ncat_' + c)}</Txt>
          {data.types.filter(x => x.category === c).map(x => (
            <View key={x.type} style={st.row} testID={`pref-${x.type}`}>
              <View style={st.name}>
                <Txt size={fontSize.m}>{t('nt_' + x.type)}</Txt>
                <View style={st.tags}>
                  {x.mandatory ? <Pill color="gray" dot={false}>{t('notif_mandatory')}</Pill> : null}
                  {x.digest ? <Txt size={fontSize.xs} color={colors.textMuted}>{t('notif_summary')}</Txt> : null}
                  {prefLockKey(x) ? <Icon name="info" size={12} color={colors.textMuted} /> : null}
                  {prefLockKey(x) ? <Txt size={fontSize.xs} color={colors.textMuted} style={st.flex}>{t(prefLockKey(x)!)}</Txt> : null}
                </View>
              </View>
              <PrefSwitch x={x} k="muted" label={t('notif_in_app')} busy={busy} onFlip={flip} />
              {prefPhoneShown(x) ? <PrefSwitch x={x} k="mobile_muted" label={t('notif_phone')} busy={busy} onFlip={flip} />
                : <View style={st.toggle} accessible accessibilityLabel={t('notif_phone_off_policy')}><Txt size={fontSize.xs} color={colors.textMuted}>{t('notif_phone')}</Txt><Txt color={colors.textMuted}>—</Txt></View>}
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  cat: { marginTop: space.l, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.s, borderBottomWidth: 1, borderBottomColor: colors.border },
  name: { flex: 1, minWidth: 0, gap: 2 },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  toggle: { alignItems: 'center', minWidth: 56, gap: 2 },
});
