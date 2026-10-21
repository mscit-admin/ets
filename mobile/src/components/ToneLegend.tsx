// Colour scale of the percentages (web: .eq-legend / .erp-scale with pctGradient()): 0 % critical … 100 % good,
// drawn from the same pctTone() stops. The bar runs in the reading direction (0 % at the start).
import { useId } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useI18n } from '@/lib/i18n';
import { colors, fontSize, space } from '@/theme';
import { toneStops } from '@/theme/tone';
import { Txt, ltr } from './ui';

export function ToneLegend({ low, mid, high }: { low: string; mid?: string; high: string }) {
  const { rtl } = useI18n();
  const id = 'tone' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const mirror = rtl;
  return (
    <View style={styles.wrap} accessible={false}>
      <Svg width="100%" height={8}>
        <Defs>
          <LinearGradient id={id} x1={mirror ? '1' : '0'} y1="0" x2={mirror ? '0' : '1'} y2="0">
            {toneStops().map(st => <Stop key={st.offset} offset={st.offset} stopColor={st.color} />)}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="8" rx="4" fill={`url(#${id})`} />
      </Svg>
      <View style={styles.labels}>
        <Txt size={fontSize.xs} color={colors.textMuted}>{ltr('0%')} {low}</Txt>
        {mid ? <Txt size={fontSize.xs} color={colors.textMuted}>{mid}</Txt> : null}
        <Txt size={fontSize.xs} color={colors.textMuted}>{high} {ltr('100%')}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xs, marginTop: space.l },
  labels: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m },
});
