// Before → after tables (web: ImpactTable of pages/Application.jsx, MoveImpact of components/MoveDialog.jsx):
//   ImpactTable  the application, its department and the project for an add / remove / restore / include / exclude
//                (POST /tracker/applications/:id/impact, debounced: useImpact)
//   MoveImpact   both applications, their department(s), the project, and the application weight that goes with the
//                moved items (POST …/move/preview, or the impact stored in a move request)
// Numbers read left to right in Arabic too; the change is green / red as on the web.
import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';
import { path } from '@/lib/api';
import type { Impact, MoveImpactData } from '@/lib/types';
import { countDelta, num2, pc, pctDelta, weightDelta, type Delta } from '@/shared/web';
import { colors, fontSize, pills, radius, space } from '@/theme';
import { Alert, Txt, ltr } from './ui';

export function useImpact(appId: string, body: unknown, key: string) {
  const { api } = useSession();
  const [v, setV] = useState<Impact | null>(null);
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      api.post<Impact>(path`/tracker/applications/${appId}/impact`, body).then(r => { if (alive) setV(r); }).catch(() => { if (alive) setV(null); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [appId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  return v;
}

const toneColor = (d: Delta) => (d.tone === 'green' ? pills.green.text : d.tone === 'red' ? pills.red.text : d.tone === 'muted' ? colors.textMuted : colors.text);

function Row({ label, before, after, delta, strong }: { label: string; before: string; after: string; delta: Delta | string; strong?: boolean }) {
  const d = typeof delta === 'string' ? { text: delta, tone: 'muted' as const } : delta;
  return (
    <View style={st.row} accessible accessibilityLabel={`${label}: ${before} → ${after} (${d.text})`}>
      <Txt size={fontSize.s} style={st.label} w={strong ? 700 : 400}>{label}</Txt>
      <Txt size={fontSize.s} style={st.num} color={colors.textMuted}>{ltr(before)}</Txt>
      <Txt size={fontSize.s} style={st.num} w={700}>{ltr(after)}</Txt>
      <Txt size={fontSize.s} style={st.num} color={toneColor(d)}>{ltr(d.text)}</Txt>
    </View>
  );
}

function Table({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <View style={st.box}>
      <Txt w={700} size={fontSize.m} accessibilityRole="header">{title}</Txt>
      <View style={[st.row, st.headRow]}>
        <View style={st.label} />
        {[t('before'), t('after'), t('change')].map(h => <Txt key={h} w={600} size={fontSize.xs} color={colors.textMuted} style={st.num}>{h}</Txt>)}
      </View>
      {children}
    </View>
  );
}

export function ImpactTable({ impact }: { impact: Impact | null }) {
  const { t } = useI18n();
  if (!impact) return <Txt size={fontSize.s} color={colors.textMuted}>{t('loading')}…</Txt>;
  const rows: [keyof Impact, string][] = [['app', t('application')], ['dept', t('department')], ['total', t('project')]];
  return (
    <Table title={t('impact_title')}>
      {rows.map(([k, label]) => (
        <Row key={k} label={label} before={pc(impact[k].before) + '%'} after={pc(impact[k].after) + '%'}
          delta={pctDelta(impact[k].before, impact[k].after, pc)} />
      ))}
      <Row label={t('included_functions')} before={String(impact.included.before)} after={String(impact.included.after)}
        delta={String(countDelta(impact.included.after - impact.included.before))} />
    </Table>
  );
}

export function MoveImpact({ impact }: { impact: MoveImpactData | null | undefined }) {
  const { t, nm } = useI18n();
  if (!impact) return null;
  const [src, dst] = impact.apps;
  const w = impact.weight;
  const pctRow = (label: string, x: { before: number; after: number }, k: string) => (
    <Row key={k} label={label} before={pc(x.before) + '%'} after={pc(x.after) + '%'} delta={pctDelta(x.before, x.after, pc)} />
  );
  const R = (o: object) => o as Record<string, unknown>;
  return (
    <View style={st.gap}>
      <Table title={t('mv_impact_title')}>
        {pctRow(t('mv_row_src', { name: nm(R(src)) }), src.pct, 'src')}
        {pctRow(t('mv_row_dst', { name: nm(R(dst)) }), dst.pct, 'dst')}
        {impact.departments.map(d => pctRow(t('mv_row_dept', { name: nm(R(d)) }), d.pct, 'd' + d.id))}
        {pctRow(t('mv_row_project'), impact.total, 'total')}
        <Txt w={700} size={fontSize.s} color={colors.textMuted} style={st.sep}>{t('mv_weights')}</Txt>
        <Row label={t('mv_weight_src')} before={num2(w.src.before)} after={num2(w.src.after)} delta={weightDelta(w.src.before, w.src.after)} />
        <Row label={t('mv_weight_dst')} before={num2(w.dst.before)} after={num2(w.dst.after)} delta={weightDelta(w.dst.before, w.dst.after)} />
        <Row strong label={t('mv_weight_moved')} before="" after={num2(w.share)} delta="" />
      </Table>
      <Txt size={fontSize.xs} color={colors.textMuted}>{t('mv_counted', { n: impact.counted, total: impact.items })}</Txt>
      <Txt size={fontSize.xs} color={colors.textMuted}>{impact.mode === 'auto' ? t('mv_weight_auto')
        : w.share > 0 ? t('mv_weight_rule', { src: num2(w.src.before), w: num2(w.moved_weight), sum: num2(w.src_items_weight) }) : t('mv_weight_none')}</Txt>
      {w.overflow ? <Alert kind="red">{t('mv_weight_overflow')}</Alert> : null}
    </View>
  );
}

const st = StyleSheet.create({
  gap: { gap: space.s },
  box: { backgroundColor: colors.gray50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: space.l, gap: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 28 },
  headRow: { minHeight: 22, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 2 },
  label: { flex: 1.6, minWidth: 0 },
  num: { flex: 1, textAlign: 'center' },
  sep: { marginTop: space.s },
});
