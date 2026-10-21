// Application progress as a weighted equation (header of the application page, components/PctEquation.jsx, and the
// mobile app's mobile/src/components/PctEquation.tsx):
//   functions % × (1 − reports_share)  +  reports % × reports_share  =  application %
// Every number comes from the API (application.calc: fnPct, reportPct and the shares fnShare / reportShare the server
// used for calc.pct — services/calc.js), nothing is recomputed here. Plain functions, no imports.

export const share = w => Math.round(w * 1000) / 10 + '%';   // 0.15 → "15%", 0.125 → "12.5%"

// The numbers the equation needs, all from the same values the API already used for calc.pct.
export function equation(calc, settings) {
  // the shares the server used; an older answer without them: the 1.7.0 rule (reports blended when present)
  const rwSetting = +settings?.reports_share || 0;
  const rw = calc.reportShare ?? (calc.reportPct != null ? rwSetting : 0);
  const fw = calc.fnShare ?? 1 - rw;
  const withReports = calc.reportPct != null && rw > 0;
  const withFunctions = fw > 0;
  return {
    withReports, withFunctions, both: withReports && withFunctions, fw, rw,
    fn: calc.fnPct, fnPart: calc.fnPct * fw,
    rep: withReports ? calc.reportPct : null, repPart: withReports ? calc.reportPct * rw : 0,
    result: calc.pct,
  };
}

// What the reports ring is made of: «5 بند تقرير + متابعة التقارير» (t = the translation function).
export const repParts = (t, calc) => {
  const n = calc.reportItems || 0;
  if (n && calc.reportTrack) return t('eq_rep_items_track', { n });
  if (n) return t('eq_rep_items', { n });
  return calc.reportTrack ? t('eq_rep_track') : null;
};
