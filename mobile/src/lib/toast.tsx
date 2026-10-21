// Short messages over the screen, like the web's toast() (frontend/src/components/ui.jsx): «أُرسل
// للاعتماد» (blue), a refusal of the server (red), a saved change (green). toast() can be called from anywhere; the
// host (app/_layout.tsx, above every screen and dialog) shows the last three at the top of the screen, each for 4.5 s
// (7 s for an error); tapping one closes it, and screen readers announce them.
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fontSize, pills, radius, shadows, space, type PillName } from '@/theme';
import { Icon } from '@/components/Icon';
import { Txt } from '@/components/ui';

export type ToastKind = 'green' | 'red' | 'blue' | 'orange' | 'gray';
type Item = { id: number; text: string; kind: ToastKind };

let seq = 0;
let items: Item[] = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach(f => f());
const set = (list: Item[]) => { items = list; changed(); };

export function toast(text: string, kind: ToastKind = 'green') {
  const id = ++seq;
  set([...items.slice(-2), { id, text, kind }]);
  AccessibilityInfo.announceForAccessibility?.(text);
  setTimeout(() => dismiss(id), kind === 'red' ? 7000 : 4500);
}
export const dismiss = (id: number) => set(items.filter(x => x.id !== id));
/** what is shown now (tests, the web preview checks) */
export const currentToasts = () => items.map(x => ({ text: x.text, kind: x.kind }));

const ICON: Record<ToastKind, string> = { green: 'check', red: 'alert', blue: 'info', orange: 'alert', gray: 'info' };

export function ToastHost() {
  const [, render] = useState(0);
  const insets = useSafeAreaInsets();
  useEffect(() => {
    const f = () => render(n => n + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  const list = items;
  if (!list.length) return null;
  return (
    <View pointerEvents="box-none" style={[st.host, { top: insets.top + 8 }]}>
      {list.map(x => {
        const p = pills[x.kind as PillName];
        return (
          <Pressable key={x.id} onPress={() => dismiss(x.id)} style={[st.toast, { borderStartColor: p.text }]}
            accessibilityRole="alert" accessibilityLiveRegion="polite" testID="toast">
            <Icon name={ICON[x.kind]} size={16} color={p.text} style={st.icon} />
            <Txt size={fontSize.m} color={colors.text} style={st.text}>{x.text}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  host: { position: 'absolute', start: space.l, end: space.l, gap: space.s, zIndex: 1000, elevation: 20 },
  toast: {
    flexDirection: 'row', alignItems: 'flex-start', gap: space.m, minHeight: 44, paddingVertical: space.m, paddingHorizontal: space.l,
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, borderStartWidth: 4,
    boxShadow: shadows.md,
  },
  icon: { marginTop: 3 },
  text: { flex: 1 },
});
