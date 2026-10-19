// «نجح» needs 100 % (1.8.1): an item's test status may be «نجح» (plain pass, test_status 2) only when its progress is
// 100 %, and the progress of a passed item cannot go below 100 %. «نجح مع ملاحظة» (pass with note, 1) has no progress
// rule. Enforced on every path that writes these two fields (single edit, bulk set, approved requests, imports);
// the screens apply the same rule before saving.
//
// Items already passed below 100 % before 1.8.1 are left as they are (flagged on the screen): only a change of the
// test status or of the progress is checked, so such an item can still be edited otherwise, and fixed by either
// field — progress to 100, or the status away from «نجح».

export const PASS = 2;
export const PASS_RULE_CODES = ['pass_requires_100', 'progress_below_100_while_passed'];

// Is this item passed below 100 %?
export const passConflict = f => Number(f.test_status) === PASS && Number(f.progress) < 100;

// The rule's error code for changing item cur by changes ({test_status?, progress?, …}), or null when allowed.
// pass_requires_100: the change sets «نجح» while the progress (after the change) is below 100.
// progress_below_100_while_passed: the change sets a progress below 100 on an item that stays «نجح».
export function passRuleError(cur, changes) {
  const has = k => Object.hasOwn(changes, k) && Number(changes[k]) !== Number(cur[k]);
  const t = has('test_status'), p = has('progress');
  if (!t && !p) return null;
  if (!passConflict({ ...cur, ...changes })) return null;
  return t ? 'pass_requires_100' : 'progress_below_100_while_passed';
}

// Same check for many items. list: [{ cur, changes, ...identity }] → [{ ...identity, error, progress, test_status }]
// (progress / test_status: the values the item would have).
export function passRuleErrors(list) {
  const out = [];
  for (const { cur, changes, ...who } of list) {
    const error = passRuleError(cur, changes);
    if (error) {
      const after = { ...cur, ...changes };
      out.push({ ...who, error, progress: Number(after.progress), test_status: Number(after.test_status) });
    }
  }
  return out;
}

// Short readable list of offending items for an error message: "per/D3, per/D7, … (+12)".
export function itemList(errors, max = 10) {
  const names = errors.slice(0, max).map(e => (e.app_id ? `${e.app_id}/${e.code}` : e.code));
  return names.join(', ') + (errors.length > max ? ` (+${errors.length - max})` : '');
}
