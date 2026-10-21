// ERP module wheel of the dashboard (web: components/ErpWheel.jsx), drawn with react-native-svg from the shared
// geometry (frontend/src/lib/wheelGeometry.js) and module mapping (frontend/src/lib/erpModules.js):
//   active segment — navy fill (FILLS), icon, name, % chip in the tone of the value, progress arc on the rim;
//                    pressing it opens the department;
//   faded segment  — module not activated, or outside the reader's scope (dashed outline, no %).
// Shapes are SVG; the labels are native Text laid over the figure (Arabic shaping and the Cairo font are then the
// same as everywhere else in the app). The figure is mirrored (counter-clockwise) in Arabic, like the web.
import { Fragment } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { useI18n } from '@/lib/i18n';
import { W, geo, linesOf, rimAngles, segmentAngles, type Segment } from '@/shared/web';
import { colors } from '@/theme';
import { toneOf } from '@/theme/tone';
import { Icon } from './Icon';
import { Txt, pctText } from './ui';
import { ringDash } from './Ring';

const { SIZE, C, R_HUB, R_HUB_RING, R_RIM, R_TEXT, FILLS } = W;

/** Where a segment's label block sits, in viewBox units (centre of icon + name + chip). */
export function labelCenter(i: number, n: number, mirror: boolean): [number, number] {
  const [a0, a1] = segmentAngles(i, n);
  return geo(mirror).pt(R_TEXT, (a0 + a1) / 2);
}

export function ErpWheel({ segments, total, size, onOpen }: {
  segments: Segment[]; total: number; size: number; onOpen: (deptId: string) => void;
}) {
  const { t, lang } = useI18n();
  const mirror = lang === 'ar';
  const g = geo(mirror);
  const n = segments.length;
  const k = size / SIZE;                         // viewBox → screen
  const hub = toneOf(total);
  const [hubDash, hubGap] = ringDash(total, R_HUB_RING);
  const stateText = (m: Segment) => (m.state === 'out_of_scope' ? t('erp_out_of_scope') : t('erp_not_activated'));

  return (
    // direction ltr: the overlay is positioned with left/top in viewBox units (the mirroring is in the geometry)
    <View style={[styles.wrap, { width: size, height: size }]} accessibilityRole="none" accessibilityLabel={t('erp_wheel_title')}>
      <Svg width={size} height={size} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {segments.map((m, i) => {
          const [a0, a1] = segmentAngles(i, n);
          const active = m.state === 'active';
          const pct = active ? m.pct ?? 0 : 0;
          const { rimStart, rimEnd, rimTo } = rimAngles(a0, a1, pct);
          return (
            <G key={m.key} onPress={active && m.dept ? () => onOpen(m.dept!.id) : undefined}>
              <Path d={g.wedge(a0, a1)} fill={active ? FILLS[i % FILLS.length] : m.state === 'out_of_scope' ? colors.erpScope : colors.erpOff}
                stroke={active ? undefined : colors.erpOffLine} strokeWidth={active ? 0 : 1.2} strokeDasharray={active ? undefined : '4 4'} />
              {active && <Path d={g.arc(R_RIM, rimStart, rimEnd)} fill="none" stroke={colors.erpTrack} strokeWidth={6} strokeLinecap="round" />}
              {active && pct > 0.05 && <Path d={g.arc(R_RIM, rimStart, rimTo)} fill="none" stroke={toneOf(pct).stroke} strokeWidth={6} strokeLinecap="round" />}
            </G>
          );
        })}
        <Circle cx={C} cy={C} r={R_HUB} fill={colors.white} stroke={colors.erpTrack} strokeWidth={1} />
        <Circle cx={C} cy={C} r={R_HUB_RING} fill="none" stroke={colors.erpTrack} strokeWidth={7} />
        {total > 0 && (
          <Circle cx={C} cy={C} r={R_HUB_RING} fill="none" stroke={hub.stroke} strokeWidth={7} strokeLinecap="round"
            strokeDasharray={`${hubDash} ${hubGap}`} transform={`rotate(-90 ${C} ${C})`} />
        )}
      </Svg>

      {segments.map((m, i) => {
        const [x, y] = labelCenter(i, n, mirror);
        const active = m.state === 'active';
        const lines = linesOf(m, lang);
        const name = m[`name_${lang}`] || m.name_ar;
        const w = 150 * k, h = 120 * k;
        const label = active
          ? t('erp_seg_label', { module: name, dept: (m.dept && (m.dept[`name_${lang}`] || m.dept.name_ar)) || '', pct: (m.pct ?? 0).toFixed(1) })
          : `${name}: ${stateText(m)}`;
        const body = (
          <Fragment>
            <Icon name={m.icon} size={Math.max(12, 24 * k)} color={active ? colors.white : colors.erpOffIcon} />
            {lines.map((l, j) => (
              <Txt key={j} w={active ? 700 : 600} size={16 * k} color={active ? colors.white : colors.erpOffText} center
                style={{ lineHeight: 19 * k }} numberOfLines={1}>{l}</Txt>
            ))}
            {active ? (
              <View style={[styles.chip, { height: 27 * k, minWidth: 68 * k, borderRadius: 13.5 * k, marginTop: 4 * k }]}>
                <Txt w={800} size={17 * k} color={toneOf(m.pct).text} center style={{ lineHeight: 22 * k }}>{pctText(m.pct)}</Txt>
              </View>
            ) : (
              <Txt w={600} size={14 * k} color={colors.erpOffText} center style={{ lineHeight: 18 * k, marginTop: 2 * k }}>{stateText(m)}</Txt>
            )}
          </Fragment>
        );
        const box = { left: x * k - w / 2, top: y * k - h / 2, width: w, height: h };
        return active && m.dept ? (
          <Pressable key={m.key} style={[styles.label, box]} onPress={() => onOpen(m.dept!.id)}
            accessibilityRole="link" accessibilityLabel={label}>{body}</Pressable>
        ) : (
          <View key={m.key} style={[styles.label, box]} accessible accessibilityLabel={label} pointerEvents="none">{body}</View>
        );
      })}

      <View style={[styles.hub, { left: (C - R_HUB) * k, top: (C - R_HUB) * k, width: 2 * R_HUB * k, height: 2 * R_HUB * k }]}
        accessible accessibilityRole="text" accessibilityLabel={`${t('erp_overall')}: ${pctText(total)}`} pointerEvents="none">
        <Txt w={800} size={12 * k} color={colors.erpNavy} center style={{ letterSpacing: 3.8 * k, lineHeight: 16 * k }}>ERP</Txt>
        <Txt w={800} size={34 * k} color={hub.text} center style={{ lineHeight: 42 * k }}>{pctText(total)}</Txt>
        <Txt w={600} size={12.5 * k} color={colors.textMuted} center style={{ lineHeight: 16 * k }}>{t('erp_overall')}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { direction: 'ltr', alignSelf: 'center' },
  label: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  chip: { backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  hub: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
});
