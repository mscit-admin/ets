// Root of the app: Cairo font, language / direction, server + session, and which screens may be shown:
//   no server address     → setup («عنوان الخادم»)
//   not signed in         → login (password, then the 2FA step like the web)
//   password must change  → change-password
//   signed in             → (tabs): الرئيسية / التنبيهات / حسابي
import { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Stack, LocaleProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { SessionProvider, useSession } from '@/lib/session';
import { colors, fontFiles } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function Gate() {
  const { server, me, info } = useSession();
  const { rtl, offerLang } = useI18n();
  const accountLang = me?.authenticated ? me.user?.language : undefined;
  // the organisation's default language, then the account's (lib/rtl.ts pickLang decides which one counts)
  useEffect(() => { offerLang(info?.default_language, 'org'); }, [info?.default_language, offerLang]);
  useEffect(() => { offerLang(accountLang, 'account'); }, [accountLang, offerLang]);
  const ready = me !== null || !server;
  useEffect(() => { if (ready) SplashScreen.hideAsync().catch(() => {}); }, [ready]);
  if (!ready) return null;
  const signedIn = !!(me?.authenticated && me.stage === 'done');
  const mustChange = signedIn && me?.authenticated && me.user.must_change_password;
  return (
    <LocaleProvider direction={rtl ? 'rtl' : 'ltr'}>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={!server}>
          <Stack.Screen name="setup" />
        </Stack.Protected>
        <Stack.Protected guard={!!server && !signedIn}>
          <Stack.Screen name="login" />
        </Stack.Protected>
        <Stack.Protected guard={!!server && !!mustChange}>
          <Stack.Screen name="change-password" />
        </Stack.Protected>
        <Stack.Protected guard={!!server && signedIn && !mustChange}>
          <Stack.Screen name="(tabs)" />
        </Stack.Protected>
      </Stack>
    </LocaleProvider>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(fontFiles);
  if (!fontsLoaded && !fontError) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <Gate />
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
