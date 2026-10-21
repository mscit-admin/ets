// Searchable multi-select (web: components/MultiSelect.jsx) for a phone: the chosen items as chips (× removes one),
// a search box, an optional «البحث في كل التطبيقات» switch, and the matching items as rows to tick. The options come
// from load(query, all), called 200 ms after the text or the switch changes (GET /tracker/function-options).
import { useEffect, useEffectEvent, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, Platform } from 'react-native';
import { Toggle } from './Toggle';
import { useI18n } from '@/lib/i18n';
import { colors, font, fontSize, pills, radius, space } from '@/theme';
import { Icon } from './Icon';
import { Label } from './form';
import { Txt } from './ui';

const SHOWN = 60;       // rows drawn at once (the server sends up to 200; the search narrows them)

export function MultiPicker<O extends { id: number }>({ value, onChange, load, chipLabel, optionLabel, optionSub, label, placeholder,
  allLabel, invalid, hint, testID }: {
  value: O[]; onChange: (v: O[]) => void; load: (q: string, all: boolean) => Promise<O[]>;
  chipLabel: (o: O) => string; optionLabel: (o: O) => string; optionSub?: (o: O) => string | null;
  label: string; placeholder?: string; allLabel?: string; invalid?: boolean; hint?: string; testID?: string;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [opts, setOpts] = useState<O[] | null>(null);
  const fetchOptions = useEffectEvent((query: string, everywhere: boolean) => load(query, everywhere));
  const selected = new Set(value.map(v => v.id));

  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      fetchOptions(q.trim(), all).then(list => { if (alive) setOpts(list); }).catch(() => { if (alive) setOpts([]); });
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [q, all]);

  const toggle = (o: O) => onChange(selected.has(o.id) ? value.filter(v => v.id !== o.id) : [...value, o]);
  return (
    <View style={st.wrap} testID={testID}>
      <Label required>{label.replace(/ \*$/, '')}</Label>
      {allLabel ? (
        <View style={st.allRow}>
          <Txt size={fontSize.s} style={st.flex}>{allLabel}</Txt>
          <Toggle value={all} onValueChange={setAll} accessibilityLabel={allLabel} />
        </View>
      ) : null}
      <View style={[st.box, invalid && st.invalid]}>
        {value.length ? (
          <View style={st.chips} accessibilityLabel={t('ms_selected', { n: value.length })}>
            {value.map(o => (
              <View key={o.id} style={st.chip}>
                <Txt w={600} size={fontSize.s} color={colors.gray800} style={st.chipText}>{chipLabel(o)}</Txt>
                <Pressable onPress={() => toggle(o)} hitSlop={10} style={st.chipX} accessibilityRole="button"
                  accessibilityLabel={t('ms_remove', { item: chipLabel(o) })}>
                  <Icon name="x" size={13} color={colors.gray700} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
        <View style={st.search}>
          <Icon name="search" size={16} color={colors.gray600} />
          <TextInput value={q} onChangeText={setQ} placeholder={placeholder} placeholderTextColor={colors.gray500} autoCorrect={false}
            accessibilityLabel={label} style={[st.input, font(400)]} />
        </View>
      </View>
      {hint ? <Txt size={fontSize.xs} color={colors.textMuted}>{hint}</Txt> : null}
      <View style={st.list} accessibilityRole="list">
        {opts === null ? <Txt size={fontSize.s} color={colors.textMuted} style={st.empty}>{t('loading')}…</Txt>
          : !opts.length ? <Txt size={fontSize.s} color={colors.textMuted} style={st.empty}>{t('ms_no_options')}</Txt>
            : opts.slice(0, SHOWN).map(o => {
              const on = selected.has(o.id);
              const sub = optionSub?.(o);
              return (
                <Pressable key={o.id} onPress={() => toggle(o)} style={[st.opt, on && st.optOn]} accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }} aria-checked={on} accessibilityLabel={optionLabel(o) + (sub ? ' · ' + sub : '')}>
                  <View style={[st.tick, on && st.tickOn]}>{on ? <Icon name="check" size={13} color={colors.white} /> : null}</View>
                  <View style={st.flex}>
                    <Txt size={fontSize.m} numberOfLines={2}>{optionLabel(o)}</Txt>
                    {sub ? <Txt size={fontSize.xs} color={colors.textMuted} numberOfLines={1}>{sub}</Txt> : null}
                  </View>
                </Pressable>
              );
            })}
        {opts && opts.length > SHOWN ? <Txt size={fontSize.xs} color={colors.textMuted} style={st.empty}>{t('ms_results', { n: opts.length })}</Txt> : null}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  wrap: { gap: space.xs },
  allRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 44 },
  box: { borderRadius: radius.md, backgroundColor: colors.gray100, borderWidth: 1, borderColor: 'transparent', padding: space.xs },
  invalid: { borderColor: pills.red.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, padding: space.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 30, paddingStart: 10, paddingEnd: 4, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  chipText: { lineHeight: 20, direction: 'ltr' },
  chipX: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m },
  input: { ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null), flex: 1, minHeight: 44, fontSize: 15, color: colors.text, textAlign: 'auto' },
  list: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  empty: { padding: space.l },
  opt: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, paddingHorizontal: space.l, paddingVertical: space.xs, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.card },
  optOn: { backgroundColor: colors.gray50 },
  tick: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.gray400, alignItems: 'center', justifyContent: 'center' },
  tickOn: { backgroundColor: colors.gray900, borderColor: colors.gray900 },
});
