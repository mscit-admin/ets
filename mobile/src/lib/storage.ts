// Small key/value store for the app's settings (server address, language). On the phone: expo-secure-store
// (Android Keystore / iOS Keychain). The web preview has its own copy (storage.web.ts).
// The session itself is not stored here: it is the server's HttpOnly cookie, kept by the platform's cookie store.
import * as SecureStore from 'expo-secure-store';

export const KEYS = { server: 'ets.server', lang: 'ets.lang', rtlReload: 'ets.rtlReload' } as const;
type Key = (typeof KEYS)[keyof typeof KEYS];

export async function getItem(key: Key): Promise<string | null> {
  try { return await SecureStore.getItemAsync(key); } catch { return null; }
}
export async function setItem(key: Key, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}
export async function removeItem(key: Key): Promise<void> {
  try { await SecureStore.deleteItemAsync(key); } catch { /* nothing stored */ }
}
