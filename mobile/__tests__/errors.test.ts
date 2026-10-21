// Phase 2: every error code the server can answer to an edit, an approval or a preference has a message in both
// languages (the shared err_<code> translations), with the answer's fields as placeholders — 409 conflicts included.
// The codes are read from the backend sources, so a new code without a message fails here.
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, errorFromResponse, errorMessage } from '@/lib/api';
import { hasKey, translator } from '@/lib/i18n';

const B = path.resolve(__dirname, '../../backend/src');
const FILES = ['routes/tracker.js', 'routes/approvals.js', 'routes/notifications.js', 'routes/events.js', 'services/move.js',
  'services/rename.js', 'services/disable.js', 'services/edits.js', 'services/functions.js', 'services/passRule.js',
  'middleware/auth.js', 'middleware/common.js'];

function codes() {
  const out = new Set<string>();
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(B, f), 'utf8');
    for (const m of src.matchAll(/\bbad\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/HttpError\(\s*\d{3},\s*'([a-z0-9_]+)'(?!\s+in\b)/g)) out.add(m[1]);
    for (const m of src.matchAll(/HttpError\(\s*\d{3},\s*[^,()]*\?\s*'([a-z0-9_]+)'\s*:\s*'([a-z0-9_]+)'/g)) { out.add(m[1]); out.add(m[2]); }
    for (const m of src.matchAll(/\b(?:err|fail)\(\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/code:\s*'([a-z0-9_]+)'/g)) out.add(m[1]);
  }
  for (const m of fs.readFileSync(path.join(B, 'services/passRule.js'), 'utf8').matchAll(/'(pass_requires_100|progress_below_100_while_passed)'/g)) out.add(m[1]);
  return [...out].sort();
}

describe('server error codes → shared messages', () => {
  const list = codes();
  it('finds the codes of the edit / approval endpoints', () => {
    for (const c of ['pass_requires_100', 'progress_below_100_while_passed', 'note_changed', 'name_changed', 'note_required', 'function_removed',
      'move_weight_out_of_range', 'request_not_pending', 'cannot_approve', 'requester_not_allowed', 'reason_required', 'forbidden', 'too_many_streams']) {
      expect(list).toContain(c);
    }
  });
  it.each(['ar', 'en'] as const)('every code has err_<code> in %s', lang => {
    expect(list.filter(c => !hasKey(lang, 'err_' + c))).toEqual([]);
  });
  it('409 conflicts read the server fields', () => {
    const t = translator('en'), has = (k: string) => hasKey('en', k);
    const ta = translator('ar'), hasA = (k: string) => hasKey('ar', k);
    expect(errorMessage(errorFromResponse(409, { error: 'pass_requires_100', progress: 80, test_status: 2, code: 'D3' }), t, has))
      .toBe('"Passed" can only be chosen when progress is 100%. Enter 100% progress first, then choose "Passed".');
    expect(errorMessage(errorFromResponse(400, { error: 'progress_below_100_while_passed' }), ta, hasA)).toBe('الحالة «نجح» تتطلب 100%. غيّر حالة الاختبار أولاً.');
    expect(errorMessage(errorFromResponse(409, { error: 'move_weight_out_of_range', max: 1000 }), t, has)).toContain('1000');
    expect(errorMessage(errorFromResponse(409, { error: 'note_changed' }), t, has)).toBe(t('err_note_changed'));
    expect(errorMessage(new ApiError(400, 'move_pending_request', { list: 'per/D3' }), ta, hasA)).toContain('per/D3');
    expect(errorMessage(new ApiError(403, 'forbidden', { permission: 'mov' }), t, has)).toBe(t('err_forbidden', { permission: 'mov' }));
  });
});
