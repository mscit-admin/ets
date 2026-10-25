// The messages tab's own stack: inbox / sent list → a conversation thread, a broadcast's recipient threads, and the
// compose screen. Back returns along it.
import { Stack } from 'expo-router';
import { colors } from '@/theme';

export default function MessagesStack() {
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }} />;
}
