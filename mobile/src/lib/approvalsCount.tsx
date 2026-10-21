// Edit requests waiting for this user, and this user's own pending requests: GET /api/approvals/pending-count
// ({ awaiting_me, mine }, as the web's sidebar badge). Reloaded on live updates (a request created or decided changes
// tracker data: the server publishes it), when the app returns to the foreground, and after an action of this user.
// The approvals tab is shown to approvers (apv_dept / apv_final) and to users with requests of their own
// (shared lib/approvalRules.js showsApprovals).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSession } from './session';
import { useLiveUpdates } from './liveContext';
import { showsApprovals } from '@/shared/web';

export type PendingCount = { awaiting_me: number; mine: number };
type Ctx = { count: PendingCount; reload: () => void; visible: boolean };
const EMPTY: PendingCount = { awaiting_me: 0, mine: 0 };
const C = createContext<Ctx>({ count: EMPTY, reload: () => {}, visible: false });

export function ApprovalsCountProvider({ children }: { children: ReactNode }) {
  const { api, user } = useSession();
  const [count, setCount] = useState<PendingCount>(EMPTY);
  const reload = useCallback(() => { api.get<PendingCount>('/approvals/pending-count', { live: true }).then(setCount).catch(() => {}); }, [api]);
  useEffect(() => { reload(); }, [reload]);
  useLiveUpdates(reload);
  const visible = showsApprovals(user?.permissions, count);
  const value = useMemo(() => ({ count, reload, visible }), [count, reload, visible]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export const useApprovalsCount = () => useContext(C);
