// Form controls of the editing dialogs, in the web UI's look (grey inputs, dark selection), sized for fingers (44 pt):
//   Label           a field's label, «*» when required
//   TextArea        multi-line input with a hint, a live error and a «n/500» counter (reasons, notes)
//   Choice          radio rows (one choice, with an optional hint per option) — the web's <select> / radio groups
//   StatusChoice    the test / notification / review statuses as coloured chips (count chips, default 4)
//   NumStepper      a number with − / + buttons (web: NumCell): committed when typing ends (blur / done) or shortly
//                   after the last tap; a value from the server never replaces what the user is typing
//   SwitchRow       a labelled switch;  Check  a checkbox
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { Toggle } from './Toggle';
import { colors, font, fontSize, pills, radius, space, type PillName } from '@/theme';
import { clampNum } from '@/shared/web';
import { toast } from '@/lib/toast';
import { Icon } from './Icon';
import { Txt, ltr } from './ui';

export function Label({ children, required, id }: { children: string; required?: boolean; id?: string }) {
  return <Txt w={600} size={fontSize.s} color={colors.gray700} nativeID={id}>{children}{required ? ' *' : ''}</Txt>;
}

export function TextArea({ label, required, hint, error, count, max, ltr: leftToRight, style, ...input }: TextInputProps & {
  label: string; required?: boolean; hint?: string; error?: string | null; count?: number; max?: number; ltr?: boolean;
}) {
  return (
    <View style={st.field}>
      <Label required={required}>{label}</Label>
      <TextInput placeholderTextColor={colors.gray500} multiline textAlignVertical="top" {...input}
        accessibilityLabel={label + (required ? ' *' : '')} aria-required={required} aria-invalid={!!error}
        style={[st.input, st.area, font(400), leftToRight && st.ltr, !!error && st.invalid, style]} />
      {hint || max ? (
        <View style={st.hintRow}>
          <Txt size={fontSize.xs} color={colors.textMuted} style={st.flex}>{hint ?? ''}</Txt>
          {max ? <Txt size={fontSize.xs} color={(count ?? 0) > max ? pills.red.text : colors.textMuted} accessibilityLiveRegion="polite">{ltr(`${count ?? 0}/${max}`)}</Txt> : null}
        </View>
      ) : null}
      {error ? <Txt size={fontSize.xs} color={pills.red.text} accessibilityRole="alert">{error}</Txt> : null}
    </View>
  );
}

export function Input({ label, required, hint, error, ltr: leftToRight, style, ...input }: TextInputProps & {
  label: string; required?: boolean; hint?: string; error?: string | null; ltr?: boolean;
}) {
  return (
    <View style={st.field}>
      <Label required={required}>{label}</Label>
      <TextInput placeholderTextColor={colors.gray500} {...input} accessibilityLabel={label + (required ? ' *' : '')}
        aria-invalid={!!error} style={[st.input, font(400), leftToRight && st.ltr, !!error && st.invalid, style]} />
      {hint ? <Txt size={fontSize.xs} color={error ? pills.red.text : colors.textMuted}>{hint}</Txt> : null}
      {error && !hint ? <Txt size={fontSize.xs} color={pills.red.text} accessibilityRole="alert">{error}</Txt> : null}
    </View>
  );
}

export type ChoiceOption<T> = { value: T; label: string; hint?: string; icon?: string; disabled?: boolean };
export function Choice<T extends string | number>({ label, options, value, onChange, required, disabled, invalid, testID }: {
  label?: string; options: ChoiceOption<T>[]; value: T | null | undefined; onChange: (v: T) => void; required?: boolean;
  disabled?: boolean; invalid?: boolean; testID?: string;
}) {
  return (
    <View style={st.field} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
      {label ? <Label required={required}>{label}</Label> : null}
      <View style={[st.choices, invalid && st.choicesInvalid]}>
        {options.map(o => {
          const on = o.value === value;
          const off = disabled || o.disabled;
          return (
            <Pressable key={String(o.value)} onPress={() => !off && onChange(o.value)} disabled={off}
              style={[st.choice, on && st.choiceOn, off && st.dim]} accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: !!off }} aria-checked={on} accessibilityLabel={o.hint ? `${o.label}. ${o.hint}` : o.label}>
              <View style={[st.radio, on && st.radioOn]}>{on ? <View style={st.radioDot} /> : null}</View>
              {o.icon ? <Icon name={o.icon} size={16} color={colors.gray800} /> : null}
              <View style={st.flex}>
                <Txt w={on ? 700 : 600} size={fontSize.m}>{o.label}</Txt>
                {o.hint ? <Txt size={fontSize.xs} color={colors.textMuted}>{o.hint}</Txt> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function StatusChoice({ label, value, prefix, colorsOf, onChange, disabled, t, count = 4 }: {
  label: string; value: number; prefix: string; colorsOf: PillName[]; onChange: (v: number) => void; disabled?: boolean;
  t: (k: string) => string; count?: number;
}) {
  return (
    <View style={st.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Label>{label}</Label>
      <View style={st.chips}>
        {Array.from({ length: count }, (_, i) => i).map(i => {
          const on = i === value;
          const p = pills[colorsOf[i] ?? 'gray'];
          return (
            <Pressable key={i} onPress={() => !disabled && !on && onChange(i)} disabled={disabled}
              style={[st.chip, { backgroundColor: on ? p.text : p.bg }, disabled && !on && st.dim]} accessibilityRole="radio"
              accessibilityState={{ checked: on, disabled: !!disabled }} aria-checked={on} accessibilityLabel={`${label}: ${t(prefix + i)}`}>
              <Txt w={600} size={fontSize.s} color={on ? colors.white : p.text} style={st.chipText}>{t(prefix + i)}</Txt>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const COMMIT_AFTER_TAP_MS = 900;

export function NumStepper({ label, value, min, max, step = 1, disabled, onCommit, check, suffix, testID }: {
  label: string; value: number; min: number; max: number; step?: number; disabled?: boolean; onCommit: (v: number) => void;
  /** a message when the value cannot be saved (the field goes back to its value) */
  check?: (v: number) => string | null; suffix?: string; testID?: string;
}) {
  const [v, setV] = useState(String(value));
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // what a commit after the last − / + tap uses (the timer fires after this render)
  const latest = useRef({ value, onCommit, check });
  useEffect(() => { latest.current = { value, onCommit, check }; });
  // a new value from the server replaces the shown one, except while the user is typing in this field
  const [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); if (!typing) setV(String(value)); }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = (raw: string) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setTyping(false);
    const cur = latest.current.value;
    const n = clampNum(raw, min, max);
    if (n === null || n === +cur) { setV(String(cur)); return; }
    const problem = latest.current.check?.(n);
    if (problem) { toast(problem, 'red'); setV(String(cur)); return; }   // not saved: back to the value, and why
    setV(String(n));
    latest.current.onCommit(n);
  };
  const stepBy = (d: number) => {
    const base = clampNum(v, min, max) ?? +value;
    const next = Math.min(max, Math.max(min, Math.round((base + d) / step) * step));
    setTyping(true);
    setV(String(next));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(String(next)), COMMIT_AFTER_TAP_MS);
  };
  const num = clampNum(v, min, max) ?? +value;
  return (
    <View style={st.field} testID={testID}>
      <Label>{label}</Label>
      <View style={[st.stepper, disabled && st.dim]}>
        <Pressable onPress={() => stepBy(-step)} disabled={disabled || num <= min} style={st.stepBtn} accessibilityRole="button"
          accessibilityLabel={`${label} −${step}`} accessibilityState={{ disabled: !!disabled || num <= min }}>
          <Txt w={700} size={20} color={colors.gray800} center>−</Txt>
        </Pressable>
        <View style={st.stepValue}>
          <TextInput value={v} editable={!disabled} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus
            onChangeText={x => { setTyping(true); setV(x); }} onBlur={() => commit(v)} onSubmitEditing={() => commit(v)}
            returnKeyType="done" accessibilityLabel={label} style={[st.stepInput, font(700)]} />
          {suffix ? <Txt w={600} size={fontSize.base} color={colors.textMuted}>{suffix}</Txt> : null}
        </View>
        <Pressable onPress={() => stepBy(step)} disabled={disabled || num >= max} style={st.stepBtn} accessibilityRole="button"
          accessibilityLabel={`${label} +${step}`} accessibilityState={{ disabled: !!disabled || num >= max }}>
          <Txt w={700} size={20} color={colors.gray800} center>+</Txt>
        </Pressable>
      </View>
    </View>
  );
}

export function SwitchRow({ label, value, onValueChange, disabled, hint, testID }: {
  label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean; hint?: string; testID?: string;
}) {
  return (
    <View style={st.switchRow}>
      <View style={st.flex}>
        <Txt w={600} size={fontSize.m}>{label}</Txt>
        {hint ? <Txt size={fontSize.xs} color={colors.textMuted}>{hint}</Txt> : null}
      </View>
      <Toggle value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={label} testID={testID} />
    </View>
  );
}

export function Check({ on, label, onPress, disabled }: { on: boolean; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} style={st.checkHit} accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!disabled }} aria-checked={on} accessibilityLabel={label}>
      <View style={[st.check, on && st.checkOn, disabled && st.dim]}>{on ? <Icon name="check" size={14} color={colors.white} /> : null}</View>
    </Pressable>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={st.section}>
      <View style={st.sectionHead}>
        <Txt w={700} size={fontSize.s} color={colors.textMuted} style={st.flex} accessibilityRole="header">{title}</Txt>
        {right}
      </View>
      {children}
    </View>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  field: { gap: space.xs },
  input: {
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null),
    minHeight: 44, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.md, backgroundColor: colors.gray100, borderWidth: 1,
    borderColor: 'transparent', fontSize: 15, color: colors.text, textAlign: 'auto',
  },
  area: { minHeight: 88 },
  ltr: { direction: 'ltr', textAlign: 'left', writingDirection: 'ltr' },
  invalid: { borderColor: pills.red.text, backgroundColor: '#fff7f7' },
  hintRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m },
  choices: { gap: space.xs },
  choicesInvalid: { borderWidth: 1, borderColor: pills.red.text, borderRadius: radius.md, padding: 2 },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, paddingHorizontal: space.l, paddingVertical: space.s,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card,
  },
  choiceOn: { borderColor: colors.gray800, backgroundColor: colors.gray50 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.gray400, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.gray900 },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.gray900 },
  dim: { opacity: 0.5 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { minHeight: 40, paddingHorizontal: 12, borderRadius: radius.pill, justifyContent: 'center' },
  chipText: { lineHeight: 20 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  stepBtn: { width: 48, height: 48, borderRadius: radius.md, backgroundColor: colors.gray100, alignItems: 'center', justifyContent: 'center' },
  stepValue: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 48, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, direction: 'ltr',
  },
  stepInput: {
    ...(Platform.OS === 'web' ? { outlineWidth: 0 } : null),
    minWidth: 56, maxWidth: 120, fontSize: 18, color: colors.text, textAlign: 'center', paddingVertical: 6,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48 },
  checkHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  check: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.gray400, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  checkOn: { backgroundColor: colors.gray900, borderColor: colors.gray900 },
  section: { gap: space.m },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
});
