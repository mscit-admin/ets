// Server address + signed-in user (GET /api/auth/me), like the web's AuthProvider (frontend/src/lib/auth.jsx).
// The API client is created here, bound to the chosen server; a 401 from any screen re-reads /auth/me, which
// sends the app back to the sign-in screen (app/_layout.tsx guards) with «انتهت الجلسة».
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError, createApi, type Api } from './api';
import { KEYS, getItem, removeItem, setItem } from './storage';
import { normalizeServerUrl } from './server';
import type { Me, PublicInfo, User } from './types';

type Session = {
  server: string | null;
  me: Me | null;                 // null while loading
  user: User | null;             // fully signed in
  info: PublicInfo | null;       // name, default language, branding versions
  api: Api;
  notice: string | null;         // error code shown once on the sign-in screen (session_ended)
  clearNotice: () => void;
  refresh: () => Promise<Me>;
  setServer: (url: string) => Promise<void>;
  forgetServer: () => Promise<void>;
  logout: () => Promise<void>;
  /** the live stream says the session may have ended: re-read it; signed out → «انتهت الجلسة» on the sign-in screen */
  checkSession: () => void;
  can: (perm: string) => boolean;
  logoUrl: string | null;        // the uploaded logo (Settings → Branding), else null (bundled mark)
};

const Ctx = createContext<Session | null>(null);

/** Checks that an address answers like an ETS server: /api/health is ok and /api/auth/public-info has the
 * organisation's name. Throws ApiError (network, timeout, http_<status>, not_ets…). */
export async function probeServer(input: string): Promise<{ url: string; info: PublicInfo }> {
  const n = normalizeServerUrl(input);
  if (!n.ok) throw new ApiError(0, n.error);
  const probe = createApi({ baseUrl: () => n.url, onUnauthorized: () => {} });
  const health = await probe.get<{ status?: string }>('/health').catch((e: ApiError) => {
    throw e.status === 404 ? new ApiError(404, 'not_ets') : e;
  });
  if (health?.status !== 'ok') throw new ApiError(0, 'not_ets');
  const info = await probe.get<PublicInfo>('/auth/public-info');
  if (!info || typeof info !== 'object' || !('org_name_ar' in info)) throw new ApiError(0, 'not_ets');
  return { url: n.url, info };
}

// One API client for the app, bound to the chosen server (like the web's lib/api.js with setUnauthorizedHandler).
let currentServer: string | null = null;
let unauthorized: (code: string) => void = () => {};
const client = createApi({ baseUrl: () => currentServer, onUnauthorized: code => unauthorized(code) });

async function readMe(): Promise<{ me: Me; notice: string | null }> {
  if (!currentServer) return { me: { authenticated: false }, notice: null };
  try {
    return { me: await client.get<Me>('/auth/me'), notice: null };
  } catch (e) {
    // the server cannot be reached: signed out on this screen; the sign-in screen shows why
    const code = e instanceof ApiError && (e.code === 'network' || e.code === 'timeout') ? e.code : null;
    return { me: { authenticated: false }, notice: code };
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [server, setServerState] = useState<string | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((r: { me: Me; notice: string | null }) => {
    setMe(r.me);
    if (r.notice) setNotice(r.notice);
    if (r.me.authenticated) {
      const m = r.me;
      setInfo(i => ({ ...i, org_name_ar: m.org_name_ar, org_name_en: m.org_name_en, branding: m.branding ?? i?.branding }));
    }
  }, []);
  const refresh = useCallback(async (): Promise<Me> => {
    const r = await readMe();
    apply(r);
    return r.me;
  }, [apply]);

  useEffect(() => {
    unauthorized = code => { setNotice(code === 'not_authenticated' ? 'session_ended' : code); refresh(); };
    return () => { unauthorized = () => {}; };
  }, [refresh]);

  // the stored server address, once
  useEffect(() => {
    getItem(KEYS.server).then(stored => {
      const n = stored ? normalizeServerUrl(stored) : null;
      currentServer = n?.ok ? n.url : null;
      setServerState(currentServer);
    });
  }, []);
  // the organisation's info and the session, whenever the server changes
  useEffect(() => {
    if (server === undefined) return undefined;
    let alive = true;
    if (server) client.get<PublicInfo>('/auth/public-info').then(i => { if (alive) setInfo(i); }).catch(() => {});
    readMe().then(r => { if (alive) apply(r); });
    return () => { alive = false; };
  }, [server, apply]);

  const setServer = useCallback(async (url: string) => {
    await setItem(KEYS.server, url);
    currentServer = url;
    setNotice(null);
    setMe(null);
    setServerState(url);
  }, []);
  const forgetServer = useCallback(async () => {
    await removeItem(KEYS.server);
    currentServer = null;
    setInfo(null);
    setMe(null);
    setServerState(null);
  }, []);
  const logout = useCallback(async () => {
    try { await client.post('/auth/logout'); } catch { /* signed out locally anyway */ }
    await refresh();
  }, [refresh]);

  const checkSession = useCallback(() => {
    refresh().then(m => { if (!m.authenticated) setNotice('session_ended'); }).catch(() => {});
  }, [refresh]);

  const value = useMemo<Session>(() => {
    const user = me?.authenticated && me.stage === 'done' ? me.user : null;
    const v = info?.branding?.logo;
    return {
      server: server ?? null, me, user, info, api: client, notice,
      clearNotice: () => setNotice(null),
      refresh, setServer, forgetServer, logout, checkSession,
      can: p => !!user?.permissions?.includes(p),
      logoUrl: server && v ? `${server}/api/branding/logo?v=${encodeURIComponent(String(v))}` : null,
    };
  }, [server, me, info, notice, refresh, setServer, forgetServer, logout, checkSession]);

  if (server === undefined) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
