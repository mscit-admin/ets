# Changelog — ETS mobile app (React Native / Expo)

Changes to the cross-platform app in `mobile/` (`ly.ets.mobile`). The web system has its own [CHANGELOG](../CHANGELOG.md);
the native ETS Alerts app has [android/CHANGELOG.md](../android/CHANGELOG.md). Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
versions: [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — Phase 1: sign-in, viewing, alerts

### Added
- Expo SDK 58 / React Native 0.88 / TypeScript (strict) project with expo-router; app name «ETS», id `ly.ets.mobile`;
  exact dependency versions and a committed lockfile.
- **Server address** («عنوان الخادم») at first launch: `https://` only (http:// and other schemes refused), checked against
  `/api/health` and `/api/auth/public-info`, kept in the secure store (expo-secure-store).
- **Sign-in** like the web: username or e-mail + password, 2FA with an authenticator code or a recovery code, 2FA set-up
  at sign-in when the policy requires it (QR, key, one-time recovery codes), forced password change, sign-out.
  Session = the server's `__Host-ets_sid` cookie (no server change); `X-Requested-With: ets` on every request; a 401
  returns to the sign-in screen with «انتهت الجلسة»; errors shown with the shared `err_<code>` messages.
- **Dashboard:** ERP module wheel (react-native-svg, same geometry, fills and tones as the web), overall %, active
  modules, number cards, departments, five lowest applications, test status distribution; bell with the unread count.
- **Department:** applications with progress rings, item counts, test counters, weight.
- **Application** (read-only): the weighted equation header (functions % + reports % = application %, tone legend,
  counters), the application's note, items as cards loaded 20 at a time — type chip, code, source, progress, test status,
  ⚠ «نجح» below 100 %, exclusion reason badge (with details), «منقول من …», awaiting-approval mark, note; search, test
  status / conflict filters, «show excluded».
- **Alerts:** category tabs, unread only, mark read / unread, mark all read, pages of 30, opening an alert's
  application or department; unread badge on the tab and the bell.
- **My account:** name, role, scope, permissions, language (PUT `/api/auth/language`), server, version, sign-out.
- Pull-to-refresh on every screen; polling every 60 s in the foreground (`X-ETS-Live: 1`).
- Arabic (RTL) / English (LTR) with the shared web translations plus `src/i18n/mobileMessages.ts`; language from the
  app choice → account → phone → organisation default; direction applied with `I18nManager` and one reload.
- Design tokens from `frontend/src/styles/app.css`, Cairo bundled from `@expo-google-fonts/cairo` (400–800), the web's
  icon set drawn with react-native-svg, the organisation's uploaded logo (`/api/branding/logo`) or the bundled ETS mark.
- Android config plugin `plugins/withAndroidNetworkSecurity.js`: trusts system + user-installed CAs, no cleartext
  (debug builds: plain HTTP to Metro on localhost / 10.0.2.2 only).
- Jest tests (API client error mapping, server address rules, tokens vs app.css, tone scale, wheel geometry and module
  mapping, RTL / language rules, translations, icons, items rules, alert links, the network plugin).
- `scripts/web-preview.mjs` (development only): HTTPS preview of the web export with an `/api` proxy.
- CI: `.github/workflows/mobile.yml` — typecheck, lint, jest, `expo prebuild`, `assembleRelease` (debug-signed) and the
  APK artifact `ets-mobile-debug-<sha>`; a disabled iOS job outline.
