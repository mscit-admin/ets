// Building blocks in the web UI's look (frontend/src/components/ui.jsx + styles/app.css): cards with a soft
// border, indicator pills, progress bars, dark primary buttons, grey inputs, coloured alerts. Layout uses start /
// end only (marginStart, paddingEnd, textAlign 'start'), so it follows the reading direction.
import { type ReactNode } from 'react';
import {
  ActivityIndicator, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
  type StyleProp, type TextInputProps, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useI18n } from '@/lib/i18n';
import { barColor, colors, font, fontSize, pills, radius, shadows, space, type PillName, type Weight } from '@/theme';
import { pc } from '@/shared/web';
import { Icon } from './Icon';

/** A number with % that reads left-to-right inside Arabic text too (the web's .num { direction: ltr }). */
export const pctText = (v: unknown) => '‎' + pc(v) + '%‎';
export const ltr = (s: string | number) => '‎' + String(s) + '‎';

type TxtProps = TextProps & { w?: Weight; size?: number; color?: string; center?: boolean; style?: StyleProp<TextStyle> };
export function Txt({ w = 400, size = fontSize.base, color = colors.text, center, style, ...rest }: TxtProps) {
  return <Text {...rest} style={[font(w), { fontSize: size, color, lineHeight: Math.round(size * 1.55), textAlign: center ? 'center' : 'start' }, style]} />;
}

export function Card({ title, actions, children, style, padded = true }: {
  title?: string; actions?: ReactNode; children?: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean;
}) {
  return (
    <View style={[s.card, style]}>
      {(title || actions) && (
        <View style={s.cardHead}>
          {title ? <Txt w={700} size={fontSize.base} style={s.flex} accessibilityRole="header">{title}</Txt> : <View style={s.flex} />}
          {actions}
        </View>
      )}
      <View style={padded ? s.cardBody : null}>{children}</View>
    </View>
  );
}

export function Pill({ color = 'gray', children, dot = true, icon }: { color?: PillName; children: ReactNode; dot?: boolean; icon?: string }) {
  const p = pills[color];
  return (
    <View style={[s.pill, { backgroundColor: p.bg }]}>
      {icon ? <Icon name={icon} size={12} color={p.text} /> : dot ? <View style={[s.dot, { backgroundColor: p.text }]} /> : null}
      <Txt w={600} size={fontSize.xs} color={p.text} numberOfLines={1} style={s.pillText}>{children}</Txt>
    </View>
  );
}

export function ProgressBar({ value, color, height = 6 }: { value: number; color?: string; height?: number }) {
  const v = Math.max(0, Math.min(100, +value || 0));
  return (
    <View style={[s.track, { height }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(v) }}>
      <View style={{ width: `${v}%`, height, borderRadius: radius.pill, backgroundColor: color ?? barColor(v) }} />
    </View>
  );
}

type BtnKind = 'primary' | 'default' | 'ghost' | 'link' | 'danger';
export function Button({ title, onPress, kind = 'primary', disabled, busy, icon, small, style, accessibilityLabel, testID }: {
  title: string; onPress: () => void; kind?: BtnKind; disabled?: boolean; busy?: boolean; icon?: string; small?: boolean;
  style?: StyleProp<ViewStyle>; accessibilityLabel?: string; testID?: string;
}) {
  const fg = kind === 'primary' || kind === 'danger' ? colors.white : kind === 'link' ? colors.gray700 : colors.text;
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} testID={testID} hitSlop={small ? 4 : undefined}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => [s.btn, small && s.btnSmall, s[kind], pressed && s[`${kind}Pressed`], (disabled || busy) && s.disabled, style]}>
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={small ? 14 : 16} color={fg} /> : null}
      <Txt w={600} size={small ? 12.5 : 13.5} color={fg} center>{title}</Txt>
    </Pressable>
  );
}

// ltr: a value that is always written left to right (address, user name, password, codes), in Arabic too.
export function Field({ label, hint, error, ltr: leftToRight, style, ...input }: TextInputProps & { label: string; hint?: string; error?: boolean; ltr?: boolean }) {
  return (
    <View style={s.field}>
      <Txt w={600} size={fontSize.s} color={colors.gray700}>{label}</Txt>
      <TextInput placeholderTextColor={colors.gray500} {...input} accessibilityLabel={label}
        style={[s.input, font(400), leftToRight && s.ltrInput, error && { borderColor: pills.red.text }, style]} />
      {hint ? <Txt size={fontSize.xs} color={colors.textMuted}>{hint}</Txt> : null}
    </View>
  );
}

export function Alert({ kind = 'red', children, icon }: { kind?: PillName; children: ReactNode; icon?: string }) {
  if (!children) return null;
  const p = pills[kind];
  return (
    <View style={[s.alert, { backgroundColor: p.bg }]} accessibilityRole="alert">
      {icon ? <Icon name={icon} size={16} color={p.text} style={s.alertIcon} /> : null}
      <View style={s.flex}>{typeof children === 'string' ? <Txt size={fontSize.m} color={p.text}>{children}</Txt> : children}</View>
    </View>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <View style={s.loading} accessibilityLiveRegion="polite">
      <ActivityIndicator color={colors.gray600} />
      <Txt color={colors.textMuted}>{t('loading')}</Txt>
    </View>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, errText } = useI18n();
  if (!error) return null;
  const code = (error as { code?: string }).code;
  return (
    <View style={s.gapM}>
      <Alert kind="red" icon="alert">
        <Txt size={fontSize.m} color={pills.red.text}>{errText(error)}</Txt>
        {code === 'network' || code === 'timeout' ? <Txt size={fontSize.s} color={pills.red.text}>{t('m_network_hint')}</Txt> : null}
      </Alert>
      {onRetry ? <Button kind="default" small title={t('m_retry')} icon="restore" onPress={onRetry} /> : null}
    </View>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <View style={s.empty}><Txt color={colors.textMuted} center>{children ?? t('no_data')}</Txt></View>;
}

/** A scrolling screen body with pull-to-refresh. */
export function Screen({ children, refreshing, onRefresh, style }: {
  children: ReactNode; refreshing?: boolean; onRefresh?: () => void; style?: StyleProp<ViewStyle>;
}) {
  return (
    <ScrollView style={s.screen} contentContainerStyle={[s.screenBody, style]} keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} /> : undefined}>
      {children}
    </ScrollView>
  );
}

/** Number card of the dashboard (.number-card) */
export function NumberCard({ label, value, sub, color }: { label: string; value: ReactNode; sub?: string; color?: PillName }) {
  return (
    <View style={[s.card, s.numberCard]}>
      <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={2}>{label}</Txt>
      <Txt w={700} size={fontSize.xxl} color={color ? pills[color].text : colors.text}>{value}</Txt>
      {sub ? <Txt size={fontSize.xs} color={colors.textMuted}>{sub}</Txt> : null}
    </View>
  );
}

export const s = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  row: { flexDirection: 'row', alignItems: 'center' },
  gapM: { gap: space.m },
  card: {
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border,
    boxShadow: shadows.sm, marginBottom: space.xl,
  },
  cardHead: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.xl, paddingVertical: space.l,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  cardBody: { padding: space.xl },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 22, paddingHorizontal: 9, borderRadius: radius.pill, alignSelf: 'flex-start' },
  pillText: { lineHeight: 18 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  track: { flex: 1, borderRadius: radius.pill, backgroundColor: colors.gray200, overflow: 'hidden', minWidth: 40 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, paddingHorizontal: 14,
    borderRadius: radius.md,
  },
  btnSmall: { minHeight: 36, paddingHorizontal: 10 },
  primary: { backgroundColor: colors.primary },
  primaryPressed: { backgroundColor: colors.primaryHover },
  default: { backgroundColor: colors.gray100 },
  defaultPressed: { backgroundColor: colors.gray200 },
  ghost: { backgroundColor: 'transparent' },
  ghostPressed: { backgroundColor: colors.gray100 },
  danger: { backgroundColor: pills.red.text },
  dangerPressed: { backgroundColor: '#a82020' },
  link: { backgroundColor: 'transparent', minHeight: 36 },
  linkPressed: { opacity: 0.6 },
  disabled: { opacity: 0.55 },
  field: { gap: space.xs, marginBottom: space.l },
  input: {
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null),
    minHeight: 44, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.gray100, borderWidth: 1,
    borderColor: 'transparent', fontSize: 15, color: colors.text,
  },
  ltrInput: { direction: 'ltr', textAlign: 'left', writingDirection: 'ltr' },
  alert: { flexDirection: 'row', gap: space.m, padding: space.l, borderRadius: radius.md, marginBottom: space.l },
  alertIcon: { marginTop: 3 },
  loading: { flexDirection: 'row', gap: space.m, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  empty: { padding: space.xxl },
  screen: { flex: 1, backgroundColor: colors.bg },
  screenBody: { padding: space.xl, paddingBottom: space.xxl * 2 },
  numberCard: { flexBasis: '47%', flexGrow: 1, padding: 14, marginBottom: 0, gap: 2 },
});
