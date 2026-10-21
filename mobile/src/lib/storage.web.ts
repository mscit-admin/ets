// Web preview only (react-native-web): expo-secure-store has no web implementation, so the browser's localStorage
// holds the same keys. Nothing secret is stored (the session is an HttpOnly cookie).
export const KEYS = { server: 'ets.server', lang: 'ets.lang', rtlReload: 'ets.rtlReload' } as const;
type Key = (typeof KEYS)[keyof typeof KEYS];

export async function getItem(key: Key): Promise<string | null> {
  try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
}
export async function setItem(key: Key, value: string): Promise<void> {
  globalThis.localStorage?.setItem(key, value);
}
export async function removeItem(key: Key): Promise<void> {
  try { globalThis.localStorage?.removeItem(key); } catch { /* storage unavailable */ }
}
