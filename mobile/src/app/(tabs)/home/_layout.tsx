// The home tab's own stack: dashboard → department → application (back returns along it).
import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function HomeStack() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
