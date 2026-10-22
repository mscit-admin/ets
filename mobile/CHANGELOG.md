# Changelog — ETS mobile app (React Native / Expo)

Changes to the cross-platform app in `mobile/` (`ly.ets.mobile`). The web system has its own [CHANGELOG](../CHANGELOG.md);
the native ETS Alerts app has [android/CHANGELOG.md](../android/CHANGELOG.md). Format: [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
versions: [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Requests a person starts send `X-ETS-Activity: 1`; automatic ones (polling, live reloads, presence, the session
  check `GET /auth/me`) send `X-ETS-Live: 1`. Server 1.12.2 extends the idle timeout only on `X-ETS-Activity`, so an app
  in use stays signed in and an app left open signs out after `SESSION_IDLE_MINUTES` (`src/lib/api.ts`, `session.tsx`).

## [0.2.0] — Phase 2: editing and approvals by permission, live updates

### Added
- **Item editing** on the application screen, gated by the server's `can` flags exactly like the website
  (`pct`: progress, notification status; `tst`: test / review status, note; `wgt`: weight; `tog`: include / exclude,
  item type, add / remove / restore; `ren`: rename; `mov`: move). Tapping an item opens its editor (bottom sheet):
  progress and weight with − / + steppers, statuses as chips, note (required with a "… with notes" status), type.
- **«نجح» = 100 %:** nothing is filled in automatically; a refused status or progress goes back with the web's toasts
  (`pass_needs_100_now`, `pass_lower_blocked`; server `pass_requires_100`, `progress_below_100_while_passed`).
  «نجح مع ملاحظة» stays allowed below 100 %.
- **Exclude** with the required reason category, the duplicate picker (search, chips, this application by default,
  «البحث في كل التطبيقات») and a note of 3–500 characters (spaces not counted); **rename** with a required reason
  and the same-name notice; **move** with module → application pickers, a required reason and the impact (both
  applications, both departments, the project, the weight transferred); **add / remove / restore** with the impact.
- **«تعيين جماعي»**: progress, test status, exclude with a reason, item type, move — for the whole application or for
  items ticked in the list (long press or «تحديد»).
- **Approval answers:** a 202 shows «أُرسل للاعتماد» and the waiting values on the item («تعديل الاسم إلى …»,
  «الإنجاز 80%»…); every server error, 409 conflicts included, shows the shared `err_<code>` message.
- **Approvals tab** («الاعتمادات») for approvers (`apv_dept` / `apv_final`) and users with requests of their own, with
  the `awaiting_me` badge: status filter, «طلباتي فقط», approve (a move: source / destination / both), reject with a
  reason, withdraw, approve all; request details (changes old → new, reasons, duplicates, move stage, shares, impact).
- **Notification preferences** in حسابي (digest, in-app and phone per type; mandatory types locked).
- **Alert links** open the screen: an application (`#fn-<id>` brings the item into view, `?filter=conflict`), a
  department, the approvals (`?mine=1`).
- **Presence** for the «Online users» page: `POST /api/presence` (`X-ETS-Client: mobile`) on screen changes and every
  60 s in the foreground; off until the next start when the server does not have the endpoint (404).
- Dialogs as bottom sheets drawn above the tabs (no native modal), toasts, 44 pt touch targets, RTL / LTR.
- Jest: shared edit / approval rules, dialog validation, `can` flags, server error codes → messages, the live client
  (reconnect, backoff, debounce, background, fallback) and presence, with fake timers.

### Changed
- **Live updates** over the server's Server-Sent Events stream `GET /api/events` (session cookie) instead of the
  60 s polling: debounced reloads, reconnect with backoff, polling every 30 s after 3 failures, paused in the
  background, `session_ended` → sign-in check. Library: **sse.js 2.8.0** (Apache-2.0, 2026-02-07); react-native-sse
  was not used because its last release dates from March 2024.
- A value being saved or typed is never replaced by a reload or a live event (the web's rule).
- Shared with the web: `frontend/src/lib/itemRules.js`, `approvalRules.js`, `liveRules.js` and the preference rules of
  `notifyTabs.js` (the CI path filter and `__tests__/shared.test.ts` follow).
- Version 0.2.0, Android `versionCode` 2.

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
