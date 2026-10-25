// Compose a new message (web: the Compose modal of pages/Messages.jsx), for users with the 'msg' permission. The
// audience combines: specific individuals (searchable via /recipients), everyone in scope, by department and by role
// (from /compose-meta). The resolved recipient count (/resolve) refreshes as the selection changes. Subject is
// optional, body required (1..4000). POST /messages sends one private thread per recipient. The recipient set is
// always scope-limited server-side; the picker only offers what the sender can reach.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { useLoad } from '@/lib/useLoad';
import { toast } from '@/lib/toast';
import type { ComposeMeta, Recipient, ResolveResult, SendResult } from '@/lib/types';
import { colors, fontSize, radius, space } from '@/theme';
import { Input, Label, TextArea } from '@/components/form';
import { MultiPicker } from '@/components/MultiPicker';
import { TopBar } from '@/components/TopBar';
import { Button, Screen, Txt, s as ui } from '@/components/ui';

const BODY_MAX = 4000;
const SUBJECT_MAX = 200;

function PickChips({ label, options, selected, onToggle }: {
  label: string; options: { id: string; name: string }[]; selected: Set<string>; onToggle: (id: string) => void;
}) {
  if (!options.length) return null;
  return (
    <View style={st.field}>
      <Label>{label}</Label>
      <View style={st.chips}>
        {options.map(o => {
          const on = selected.has(o.id);
          return (
            <Pressable key={o.id} onPress={() => onToggle(o.id)} style={[st.pick, on && st.pickOn]}
              accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={o.name}>
              <Txt w={600} size={fontSize.s} color={on ? colors.white : colors.gray800}>{o.name}</Txt>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function Compose() {
  const { t, nm, errText } = useI18n();
  const { api } = useSession();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [people, setPeople] = useState<Recipient[]>([]);
  const [all, setAll] = useState(false);
  const [depts, setDepts] = useState<Set<string>>(new Set());
  const [roles, setRoles] = useState<Set<string>>(new Set());
  const [count, setCount] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);
  const { data: meta } = useLoad(o => api.get<ComposeMeta>('/messages/compose-meta', o), [], { live: false });

  const audience = useCallback(() => ({ all, users: people.map(p => p.id), depts: [...depts], roles: [...roles] }), [all, people, depts, roles]);

  // resolved recipient count, refreshed (debounced) when the selection changes; stale answers ignored. The resolve
  // preview is a direct consequence of the person's choice, so it is a normal (activity) request, like on the web.
  const seq = useRef(0);
  useEffect(() => {
    const aud = audience();
    const my = ++seq.current;
    const h = setTimeout(() => {
      api.post<ResolveResult>('/messages/resolve', { audience: aud }).then(d => { if (my === seq.current) setCount(d.count); }).catch(() => {});
    }, 250);
    return () => clearTimeout(h);
  }, [audience, api]);

  const loadPeople = (q: string) => api.get<{ recipients: Recipient[] }>('/messages/recipients' + (q ? '?q=' + encodeURIComponent(q) : '')).then(d => d.recipients);
  const toggle = (set: Set<string>, setSet: (s: Set<string>) => void, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id); else n.add(id);
    setSet(n);
  };

  const send = async () => {
    if (!body.trim() || !count || busy) return;
    setBusy(true);
    try {
      const r = await api.post<SendResult>('/messages', { subject: subject.trim() || undefined, body: body.trim(), audience: audience() });
      toast(t('msg_sent_ok', { n: r.sent }), 'green');
      router.back();
    } catch (e) { toast(errText(e), 'red'); setBusy(false); }
  };

  return (
    <View style={ui.flex}>
      <TopBar back title={t('msg_new_title')} />
      <Screen>
        <Txt size={fontSize.s} color={colors.textMuted} style={st.hint}>{t('msg_select_hint')}</Txt>
        <MultiPicker<Recipient>
          value={people} onChange={setPeople} load={loadPeople}
          label={t('msg_to_people')} placeholder={t('msg_search_people')}
          chipLabel={o => o.full_name || o.username} optionLabel={o => o.full_name || o.username} optionSub={o => o.username} />
        <Pressable onPress={() => setAll(v => !v)} style={st.everyone} accessibilityRole="checkbox" accessibilityState={{ checked: all }} accessibilityLabel={t('msg_everyone')}>
          <View style={[st.box, all && st.boxOn]}>{all ? <Txt w={700} size={13} color={colors.white} center>✓</Txt> : null}</View>
          <Txt size={fontSize.m} style={ui.flex}>{t('msg_everyone')}</Txt>
        </Pressable>
        <PickChips label={t('msg_by_dept')} selected={depts} onToggle={id => toggle(depts, setDepts, id)}
          options={(meta?.departments ?? []).map(d => ({ id: d.id, name: nm(d, 'short') || nm(d) }))} />
        <PickChips label={t('msg_by_role')} selected={roles} onToggle={id => toggle(roles, setRoles, id)}
          options={(meta?.roles ?? []).map(r => ({ id: r.id, name: nm(r) }))} />
        <View style={st.field}>
          <Input label={t('msg_subject')} value={subject} onChangeText={setSubject} maxLength={SUBJECT_MAX} placeholder={t('msg_subject_ph')} />
        </View>
        <TextArea label={t('msg_body')} required value={body} onChangeText={setBody} maxLength={BODY_MAX}
          count={body.length} max={BODY_MAX} placeholder={t('msg_body_ph')} />
        <View style={st.footer}>
          <Txt size={fontSize.s} color={count ? colors.gray700 : colors.textMuted} style={ui.flex}>
            {count ? t('msg_resolved_count', { n: count }) : t('msg_resolved_zero')}
          </Txt>
          <Button icon="out" title={busy ? t('msg_sending') : t('msg_send')} onPress={send} busy={busy} disabled={!body.trim() || !count} />
        </View>
      </Screen>
    </View>
  );
}

const st = StyleSheet.create({
  hint: { marginBottom: space.l },
  field: { marginBottom: space.l },
  everyone: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, marginBottom: space.l },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: colors.gray400, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  boxOn: { backgroundColor: colors.gray900, borderColor: colors.gray900 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  pick: { minHeight: 38, paddingHorizontal: 12, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: colors.gray100, borderWidth: 1, borderColor: colors.border },
  pickOn: { backgroundColor: colors.gray900, borderColor: colors.gray900 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: space.m, marginTop: space.m },
});
