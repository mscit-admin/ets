// Client / server rule-parity guard (review A3 / FE-1). The "… with notes" rule set and the «نجح» (PASS) value are
// hand-duplicated across packages: the server declares NOTE_REQUIRED in routes/tracker.js and PASS in
// services/passRule.js, while the client declares both in frontend/src/lib/itemRules.js (shared with the mobile app
// through mobile/src/shared/web.ts). There is no compiler / module link between the two copies, so a change on one
// side can silently diverge from the other — the UI would then validate one way and the API reject another. This
// test FAILS the moment the authoritative constants on the two sides stop matching, so drift is caught in CI.
//
// It reads the constants from BOTH sides, not a hard-coded expectation: the client file is a pure, import-free ESM
// module, so it is imported directly when the runner can resolve it, with a text-parse fallback; the server's
// NOTE_REQUIRED is module-local (not exported) and is parsed from the route file's text, while PASS is imported from
// passRule.js. The test is deterministic and needs no database — it does not import the Express app or open a pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const TRACKER = new URL('../src/routes/tracker.js', import.meta.url);
const CLIENT_RULES = new URL('../../frontend/src/lib/itemRules.js', import.meta.url);

// Extract the balanced { … } object literal assigned to `name` in source text, returning its JS value. The literals
// in question are plain {key: [numbers]} maps, so evaluating the captured literal in isolation is safe and exact
// (it reproduces the real value, including array order, rather than guessing with a brittle regex).
function objectLiteral(text, name) {
  const at = text.search(new RegExp(`(?:^|[^.\\w])${name}\\s*=\\s*\\{`, 'm'));
  assert.notEqual(at, -1, `could not locate "${name} = {" in source`);
  const start = text.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.notEqual(end, -1, `unbalanced braces while parsing "${name}"`);
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${text.slice(start, end)});`)();
}

// Extract a numeric scalar assigned to `name` (e.g. `PASS = 2`).
function numberLiteral(text, name) {
  const m = text.match(new RegExp(`(?:^|[^.\\w])${name}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`, 'm'));
  assert.ok(m, `could not locate "${name} = <number>" in source`);
  return Number(m[1]);
}

// The server side. NOTE_REQUIRED is module-local in tracker.js (not exported), so it is parsed from the file text;
// PASS is a real export of passRule.js.
const trackerSrc = readFileSync(TRACKER, 'utf8');
const serverNoteRequired = objectLiteral(trackerSrc, 'NOTE_REQUIRED');
const { PASS: serverPass } = await import('../src/services/passRule.js');

// The client side. Prefer a direct import of the pure ESM module; fall back to parsing the file text if the runner
// cannot resolve it (keeps the guard working regardless of how the frontend package is laid out).
let clientNoteRequired, clientPass, clientVia;
try {
  const mod = await import(CLIENT_RULES.href);
  assert.ok(mod.NOTE_REQUIRED && mod.PASS !== undefined, 'client module missing NOTE_REQUIRED / PASS');
  clientNoteRequired = mod.NOTE_REQUIRED;
  clientPass = mod.PASS;
  clientVia = 'import';
} catch {
  const src = readFileSync(CLIENT_RULES, 'utf8');
  clientNoteRequired = objectLiteral(src, 'NOTE_REQUIRED');
  clientPass = numberLiteral(src, 'PASS');
  clientVia = 'text-parse';
}

test('NOTE_REQUIRED is identical on the server (routes/tracker.js) and the client (lib/itemRules.js)', () => {
  // Sanity: both sides parsed to the expected shape (non-empty map of status field -> array of codes), so an empty
  // or malformed parse can never make the equality pass vacuously.
  for (const [label, m] of [['server', serverNoteRequired], ['client', clientNoteRequired]]) {
    assert.equal(typeof m, 'object', `${label} NOTE_REQUIRED is not an object`);
    const keys = Object.keys(m);
    assert.ok(keys.length >= 3, `${label} NOTE_REQUIRED has too few keys: ${keys}`);
    for (const k of keys) assert.ok(Array.isArray(m[k]) && m[k].length >= 1, `${label} NOTE_REQUIRED[${k}] is not a non-empty array`);
  }
  assert.ok(['test_status', 'notif_status', 'review_status'].every(k => k in serverNoteRequired),
    'server NOTE_REQUIRED is missing one of the expected status fields');
  // The guard itself: the full map (every status field and its array of codes) must match exactly.
  assert.deepEqual(serverNoteRequired, clientNoteRequired,
    `NOTE_REQUIRED diverged between server (routes/tracker.js) and client (lib/itemRules.js) [client via ${clientVia}]`);
});

test('PASS is identical on the server (services/passRule.js) and the client (lib/itemRules.js)', () => {
  assert.equal(typeof serverPass, 'number', 'server PASS is not a number');
  assert.equal(typeof clientPass, 'number', 'client PASS is not a number');
  assert.equal(serverPass, clientPass,
    `PASS diverged between server (services/passRule.js = ${serverPass}) and client (lib/itemRules.js = ${clientPass}) [client via ${clientVia}]`);
});
