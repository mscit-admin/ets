// «نجح» = 100 % (1.8.1, auto-filled since 1.12.21): a passed item (test status «نجح», plain pass, test_status 2) is
// always at 100 %. Choosing «نجح» no longer needs the progress to be 100 first — setting the test status to «نجح»
// now brings the progress up to 100 in the same write (withPassProgress, the server's single source of truth on every
// path: single edit, bulk set, approved requests). The progress of a passed item still cannot be *lowered* below 100
// while it stays «نجح» (progress_below_100_while_passed) — change the status away from «نجح» first. «نجح مع ملاحظة»
// (pass with note, 1) has no progress rule. The screens apply the same auto-fill (with a confirmation) before saving.
//
// Items already passed below 100 % before 1.8.1 are left as they are (flagged on the screen): only a change of the
// test status or of the progress is checked. A bulk «نجح» does not touch an item that is already «نجح» (its progress
// is left untouched even when below 100); a newly-passed item is the one brought to 100.

export const PASS = 2;
export const PASS_RULE_CODES = ['pass_requires_100', 'progress_below_100_while_passed'];

// Is this item passed below 100 %?
export const passConflict = f => Number(f.test_status) === PASS && Number(f.progress) < 100;

// Auto-fill (1.12.21): a change that sets the test status to «نجح» (PASS) is completed with progress = 100 in the same
// write, so a passed item is always at 100 % — the invariant is now satisfied automatically instead of refused.
// Returns the changes with progress added when the status becomes «نجح» and the resulting progress is below 100,
// otherwise the changes unchanged (never mutates the input). The progress bump is a consequence of the «نجح» choice,
// so callers apply it after the per-field permission check (it is covered by the test-status permission).
export function withPassProgress(cur, changes) {
  if (Object.hasOwn(changes, 'test_status') && Number(changes.test_status) === PASS
      && Number({ ...cur, ...changes }.progress) < 100) {
    return { ...changes, progress: 100 };
  }
  return changes;
}

// The rule's error code for changing item cur by changes ({test_status?, progress?, …}), or null when allowed.
// Callers pass the changes *after* withPassProgress, so setting «نجح» is never an error (the progress came up to 100).
// progress_below_100_while_passed: the change lowers the progress below 100 on an item that stays «نجح».
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
