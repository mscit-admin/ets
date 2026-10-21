// "/" — the guards of _layout.tsx decide which screen is available; this only forwards to it.
import { Redirect } from 'expo-router';
import { useSession } from '@/lib/session';

export default function Index() {
  const { server, me } = useSession();
  if (!server) return <Redirect href="/setup" />;
  if (!(me?.authenticated && me.stage === 'done')) return <Redirect href="/login" />;
  if (me.user.must_change_password) return <Redirect href="/change-password" />;
  return <Redirect href="/home" />;
}
