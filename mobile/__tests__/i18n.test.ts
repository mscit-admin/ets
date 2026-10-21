import fs from 'node:fs';
import path from 'node:path';
import { mobileMessages } from '@/i18n/mobileMessages';
import { hasKey, timeAgo, translator } from '@/lib/i18n';

const SRC = path.resolve(__dirname, '../src');
const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));

describe('translations', () => {
  it('the app strings exist in both languages', () => {
    expect(Object.keys(mobileMessages.en).sort()).toEqual(Object.keys(mobileMessages.ar).sort());
  });
  it('every literal t("key") of the app exists in Arabic and English (shared + app)', () => {
    const missing: string[] = [];
    for (const f of files(SRC)) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*'([a-z0-9_]+)'\s*[,)]/g)) {
        for (const lang of ['ar', 'en'] as const) if (!hasKey(lang, m[1])) missing.push(`${lang}:${m[1]} (${path.relative(SRC, f)})`);
      }
    }
    expect(missing).toEqual([]);
  });
  it('replaces placeholders and falls back like the web', () => {
    const t = translator('en');
    expect(t('apps_count', { n: 4 })).toBe('4 applications');
    expect(t('m_items_count', { shown: 3, total: 9 })).toBe('3 of 9 items');
    expect(t('no_such_key')).toBe('no_such_key');
    expect(translator('ar')('m_tab_home')).toBe('الرئيسية');
    expect(translator('ar')('notifications')).toBe('التنبيهات');
    expect(translator('ar')('profile_title')).toBe('حسابي');
  });
  it('time ago', () => {
    const now = Date.parse('2026-10-21T10:00:00Z');
    expect(timeAgo('en', '2026-10-21T09:59:30Z', now)).toMatch(/now|sec/);
    expect(timeAgo('en', '2026-10-21T07:00:00Z', now)).toMatch(/3/);
  });
});
