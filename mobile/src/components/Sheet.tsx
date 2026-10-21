// The web UI's dialogs (components/ui.jsx Modal) on a phone: a bottom sheet over a dimmed screen, up to the full
// height, with a title, a 44 pt close button, a scrolling body that stays above the keyboard, and a fixed footer for
// the actions. Tapping outside, the close button or Android's back button closes it.
// Sheets are drawn by <SheetHost> (app/(tabs)/_layout.tsx) above the tabs, not by a native Modal: one dialog can
// replace another (item → rename → item) without a modal window being dismissed and presented again, the toasts stay
// on top, and the web preview behaves like the phone. While a sheet is open the screen under it is hidden from screen
// readers. ConfirmSheet: a question with cancel / confirm.
import { Fragment, createContext, useContext, useEffect, useEffectEvent, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/lib/i18n';
import { colors, fontSize, radius, space } from '@/theme';
import { Icon } from './Icon';
import { Button, Txt } from './ui';

type Host = { set: (id: number, node: ReactNode | null) => void };
const HostCtx = createContext<Host | null>(null);
let sheetSeq = 0;

export function SheetHost({ children }: { children: ReactNode }) {
  const [nodes, setNodes] = useState<[number, ReactNode][]>([]);
  const host = useMemo<Host>(() => ({
    set: (id, node) => setNodes(list => {
      const i = list.findIndex(x => x[0] === id);
      if (node === null) return i < 0 ? list : list.filter(x => x[0] !== id);
      if (i < 0) return [...list, [id, node]];
      const copy = [...list];
      copy[i] = [id, node];
      return copy;
    }),
  }), []);
  const open = nodes.length > 0;
  return (
    <HostCtx.Provider value={host}>
      <View style={st.flex} importantForAccessibility={open ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={open}>
        {children}
      </View>
      {nodes.map(([id, n]) => <Fragment key={id}>{n}</Fragment>)}
    </HostCtx.Provider>
  );
}

type SheetProps = {
  title: string; sub?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; full?: boolean; testID?: string;
};

/** Draws its content in the SheetHost (falls back to drawing in place outside one). */
export function Sheet(props: SheetProps) {
  const host = useContext(HostCtx);
  const [id] = useState(() => ++sheetSeq);
  const node = <SheetView {...props} />;
  useLayoutEffect(() => { host?.set(id, node); });
  useEffect(() => () => host?.set(id, null), [host, id]);
  // Android back button: closes the top-most sheet (the last one registered handles it first)
  const back = useEffectEvent(() => props.onClose());
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    return () => sub.remove();
  }, []);
  return host ? null : node;
}

function SheetView({ title, sub, onClose, children, footer, full, testID }: SheetProps) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={st.backdrop}>
      <Pressable style={st.outside} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[st.avoid, full && st.full, { paddingTop: insets.top }]}
        pointerEvents="box-none">
        <View style={[st.panel, full && st.panelFull, { paddingBottom: Math.max(insets.bottom, space.m) }]}
          accessibilityViewIsModal testID={testID} role="dialog" aria-label={title}>
          <View style={st.head}>
            <View style={st.grabber} />
            <View style={st.headRow}>
              <View style={st.titles}>
                <Txt w={700} size={fontSize.l} accessibilityRole="header" numberOfLines={2}>{title}</Txt>
                {sub ? <Txt size={fontSize.s} color={colors.textMuted} numberOfLines={2}>{sub}</Txt> : null}
              </View>
              <Pressable onPress={onClose} style={st.close} accessibilityRole="button" accessibilityLabel={t('close')}>
                <Icon name="x" size={20} color={colors.gray700} />
              </Pressable>
            </View>
          </View>
          <ScrollView style={st.body} contentContainerStyle={st.bodyIn} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
          {footer ? <View style={st.footer}>{footer}</View> : null}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

/** The buttons of a sheet footer: cancel, then the action (danger: red). */
export function SheetActions({ onCancel, title, onPress, disabled, busy, danger, cancelTitle, testID }: {
  onCancel: () => void; title: string; onPress: () => void; disabled?: boolean; busy?: boolean; danger?: boolean; cancelTitle?: string; testID?: string;
}) {
  const { t } = useI18n();
  return (
    <View style={st.actions}>
      <Button kind="default" title={cancelTitle ?? t('cancel')} onPress={onCancel} style={st.action} />
      <Button kind={danger ? 'danger' : 'primary'} title={title} onPress={onPress} disabled={disabled} busy={busy} style={st.action} testID={testID} />
    </View>
  );
}

export function ConfirmSheet({ title, message, confirmTitle, onConfirm, onClose, danger, busy, children }: {
  title: string; message?: string; confirmTitle: string; onConfirm: () => void; onClose: () => void; danger?: boolean; busy?: boolean;
  children?: ReactNode;
}) {
  return (
    <Sheet title={title} onClose={onClose} footer={<SheetActions onCancel={onClose} title={confirmTitle} onPress={onConfirm} danger={danger} busy={busy} />}>
      {message ? <Txt size={fontSize.base}>{message}</Txt> : null}
      {children}
    </Sheet>
  );
}

const st = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0, backgroundColor: 'rgba(23, 23, 23, 0.45)', justifyContent: 'flex-end', zIndex: 50 },
  outside: { position: 'absolute', top: 0, bottom: 0, start: 0, end: 0 },
  avoid: { maxHeight: '100%' },
  full: { flex: 1 },
  panel: {
    backgroundColor: colors.card, borderTopLeftRadius: radius.lg + 4, borderTopRightRadius: radius.lg + 4, flexShrink: 1, maxHeight: '100%',
  },
  panelFull: { flex: 1 },
  head: { paddingHorizontal: space.xl, paddingTop: space.s, paddingBottom: space.m, borderBottomWidth: 1, borderBottomColor: colors.border },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.gray300, marginBottom: space.s },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  titles: { flex: 1, minWidth: 0 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.gray100 },
  body: { flexShrink: 1 },
  bodyIn: { padding: space.xl, gap: space.l },
  footer: { paddingHorizontal: space.xl, paddingTop: space.m, borderTopWidth: 1, borderTopColor: colors.border },
  actions: { flexDirection: 'row', gap: space.m },
  action: { flex: 1 },
});
