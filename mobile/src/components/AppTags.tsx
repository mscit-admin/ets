// Marks of an application (web: Department.jsx row-tags): addendum, scope cut, module not in the design.
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import type { Application } from '@/lib/types';
import { Pill } from './ui';

export function AppTags({ a }: { a: Application }) {
  const { t } = useI18n();
  if (!a.addendum && !a.scope_cut && !a.extra_module) return null;
  return (
    <View style={st.tags}>
      {a.addendum ? <Pill color="blue">{`${t('addendum')} ${a.addendum}`}</Pill> : null}
      {a.scope_cut ? <Pill color="orange">{t('scope_cut')}</Pill> : null}
      {a.extra_module ? <Pill color="purple">{t('extra_module')}</Pill> : null}
    </View>
  );
}

const st = StyleSheet.create({ tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 } });
