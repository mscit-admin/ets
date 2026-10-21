# ETS · تطبيق ETS للهاتف

The ETS mobile app for Android and iOS, built with React Native and Expo. Phase 1 lets you sign in, view the project and read your alerts.
تطبيق ETS للهاتف، لأندرويد و iOS، مبني بـ React Native و Expo. المرحلة الأولى: تسجيل الدخول، وعرض المشروع، وقراءة التنبيهات.

- [العربية](#العربية)
- [English](#english)
- [Developer notes](#developer-notes)

> This app is separate from **ETS Alerts** (`android/`, `ly.ets.alerts`). That app is still in use. This one has its own id, `ly.ets.mobile`, so both can be installed on the same phone.

---

## العربية

### ما هو التطبيق؟

تطبيق للهاتف يعرض نظام ETS بنفس شكل الموقع. الألوان والخط Cairo والشعار وعجلة وحدات ERP وحلقات النسب وألوان الحالة كلها مثل الموقع. يتصل بخادم ETS في مؤسستك مباشرة، ويستخدم نفس الحساب ونفس الصلاحيات ونفس النطاق.

**المرحلة الأولى (هذا الإصدار، للعرض فقط):**

- عنوان الخادم عند أول تشغيل. يُقبل `https://` فقط.
- تسجيل الدخول باسم المستخدم أو البريد الإلكتروني، ثم التحقق بخطوتين برمز التطبيق أو برمز احتياطي. إن كانت السياسة تُلزم بالتحقق بخطوتين والحساب غير مفعّل له، يفعّله التطبيق من نفس الشاشة.
- تغيير كلمة المرور إذا طلب المسؤول ذلك.
- **الرئيسية:** عجلة وحدات ERP، والإنجاز الكلي، وبطاقات الأرقام، والإدارات، وأدنى خمسة تطبيقات، وتوزيع حالة الاختبار.
- **الإدارة:** تطبيقاتها، ولكل تطبيق حلقة نسبة وعدد البنود ونتائج الاختبار.
- **التطبيق:** معادلة النسبة (نسبة الوظائف + نسبة التقارير = نسبة التطبيق)، ثم البنود كبطاقات تُحمَّل تباعاً أثناء التمرير. لكل بند: نوعه (وظيفة أو تقرير)، والإنجاز، وحالة الاختبار، وتنبيه ⚠ إذا كانت الحالة «نجح» والنسبة أقل من 100%، وسبب الاستبعاد، و«منقول من». يمكن البحث والتصفية حسب حالة الاختبار.
- **التنبيهات:** حسب التصنيف، وغير المقروءة فقط، وتعليم تنبيه كمقروء أو غير مقروء، وتعليم الكل كمقروء. عدد غير المقروء يظهر على الجرس في الأعلى وعلى تبويب التنبيهات.
- **حسابي:** الاسم والدور والنطاق والصلاحيات، واللغة (تُحفظ في حسابك كما في الموقع)، وتسجيل الخروج.
- السحب للأسفل يحدّث أي شاشة. وتتحدّث البيانات كل دقيقة ما دام التطبيق مفتوحاً.

**المرحلة الثانية:** التعديل والاعتماد حسب الصلاحيات: نسب الإنجاز، وحالة الاختبار، والملاحظات، وطلبات الاعتماد، والاستيراد.
**المرحلة الثالثة:** تثبيت شهادة الخادم (pinning)، وتوقيع رسمي ونشر على المتاجر، ونسخة iOS، وإشعارات فورية.

### تنزيل التطبيق (APK)

1. افتح المستودع على GitHub، ثم **Actions**، ثم **Mobile (ETS app, React Native / Expo)**. اختر آخر تشغيل ناجح.
2. نزّل من قسم **Artifacts** الملف `ets-mobile-debug-<sha>`. هو ملف zip، وبداخله `ets-mobile-<الإصدار>-<sha>.apk` و`SHA256SUMS.txt`.
3. انقل ملف APK إلى الهاتف وافتحه. سيطلب أندرويد السماح بـ **تثبيت التطبيقات غير المعروفة**. فعّل الخيار ثم اضغط **تثبيت**. يتطلب التطبيق أندرويد 7.0 أو أحدث.

> هذه نسخة اختبار، موقّعة بمفتاح تطوير يتغيّر من بناء لآخر. إذا رفض الهاتف التحديث، احذف النسخة القديمة أولاً. النسخة الموقّعة رسمياً تأتي في المرحلة الثالثة.

### عنوان الخادم

- عند أول تشغيل يطلب التطبيق **عنوان الخادم**، مثل `ets.example.ly` أو `https://ets.example.ly:8443`. يُضاف `https://` تلقائياً.
- **يُرفض `http://`.** جلسة ETS تعمل عبر الاتصال المشفّر فقط.
- قبل حفظ العنوان يتأكد التطبيق أنه يتصل فعلاً بنظام ETS. ويُحفظ العنوان في المخزن الآمن للهاتف.
- لتغيير الخادم: سجّل الخروج، ثم اضغط **تغيير الخادم** أسفل شاشة الدخول.
- الخادم داخلي في الغالب، لذلك **يجب أن يكون الهاتف متصلاً بشبكة المؤسسة أو بالـ VPN**.

### تثبيت شهادة الخادم على أندرويد

إذا كانت شهادة الخادم صادرة من شهادة جذر داخلية في مؤسستك، أو كانت شهادة موقّعة ذاتياً، فثبّتها على الهاتف قبل إدخال العنوان. بدون ذلك يظهر «تعذّر الاتصال بالخادم».

1. اطلب من مسؤول النظام ملف الشهادة: شهادة الجذر (CA) بصيغة `.crt` أو `.cer` أو `.pem`. إذا لم تكن هناك جهة جذر، فاطلب شهادة الخادم نفسها.
2. انقل الملف إلى الهاتف.
3. افتح **الإعدادات ← الأمان والخصوصية ← المزيد من الإعدادات ← التشفير وبيانات الاعتماد ← تثبيت شهادة ← شهادة CA**. تختلف الأسماء قليلاً بين الأجهزة، ويمكنك البحث في الإعدادات عن «شهادة CA».
4. وافق على التحذير، ثم اختر الملف. قد يطلب الهاتف قفل شاشة.
5. للتحقق: **التشفير وبيانات الاعتماد ← بيانات الاعتماد الموثوقة ← المستخدم**. يجب أن تظهر الشهادة هناك.

التطبيق يثق بشهادات النظام وبالشهادات التي يثبّتها المستخدم، ويرفض الاتصال غير المشفّر. أما تثبيت بصمة الشهادة نفسها (pinning) ففي المرحلة الثالثة.

**iOS (لاحقاً):** أرسل الشهادة إلى الهاتف بالبريد أو AirDrop، ثبّت ملف التعريف من **الإعدادات ← تم تنزيل ملف التعريف**، ثم فعّل الثقة الكاملة من **الإعدادات ← عام ← حول ← إعدادات الثقة بالشهادات**.

### اللغة والاتجاه

- لغة البداية هي لغة الهاتف إن كانت العربية أو الإنجليزية، وإلا فلغة النظام الافتراضية. بعد الدخول تُستخدم لغة حسابك. وأي لغة تختارها في التطبيق تبقى هي المعتمدة.
- تغيير اللغة من **حسابي** يحفظها في حسابك أيضاً.
- عند الانتقال بين العربية (من اليمين لليسار) والإنجليزية (من اليسار لليمين) **يعيد التطبيق تشغيل نفسه مرة واحدة** لتطبيق الاتجاه. إذا لم يتمكن من ذلك، تظهر رسالة تطلب إغلاقه وفتحه مجدداً.

---

## English

### What is it?

A phone app that shows ETS the same way as the website: the same colours, the Cairo font, the logo, the ERP module wheel, the progress rings and the tone colours. It talks directly to your organisation's ETS server, with the same account, permissions and scope.

**Phase 1 (this release, view only):**

- Server address at first launch. Only `https://` is accepted.
- Sign in with a username or email address, then two-step verification with an authenticator code or a recovery code. If the policy requires 2FA and the account does not have it yet, the app sets it up on the same screen.
- A password change when an administrator requires one.
- **Home:** the ERP module wheel, overall progress, number cards, departments, the five lowest applications and the test status distribution.
- **Department:** its applications, each with a progress ring, item counts and test results.
- **Application:** the progress equation (functions % + reports % = application %), then the items as cards that load as you scroll. Each card shows the item type (function or report), progress, test status, a ⚠ when an item is "Passed" below 100%, the exclusion reason and "Moved from". You can search and filter by test status.
- **Notifications:** category tabs, unread only, mark one read or unread, mark all as read. The unread count shows on the bell at the top and on the Notifications tab.
- **My account:** name, role, scope, permissions, language (saved to your account, as on the website), and sign out.
- Pull down on any screen to refresh. While the app is open, data refreshes every minute.

**Phase 2:** editing and approvals by permission: progress, test status, notes, approval requests and imports.
**Phase 3:** certificate pinning, release signing and store publishing, the iOS build, and push notifications.

### Download the app (APK)

1. On GitHub, open the repository, then **Actions**, then **Mobile (ETS app, React Native / Expo)**. Pick the latest successful run.
2. Under **Artifacts**, download `ets-mobile-debug-<sha>`. It is a zip file that contains `ets-mobile-<version>-<sha>.apk` and `SHA256SUMS.txt`.
3. Copy the APK to the phone and open it. Android asks you to allow **Install unknown apps**. Allow it, then tap **Install**. Android 7.0 or later is required.

> This is a test build, signed with a development key that changes between builds. If the phone refuses an update, uninstall the old version first. A properly signed build comes in phase 3.

### Server address

- At first launch the app asks for the **server address**, for example `ets.example.ly` or `https://ets.example.ly:8443`. The app adds `https://` if you leave it out.
- **`http://` is refused.** The ETS session only works over an encrypted connection.
- Before saving the address, the app checks that an ETS server answers there. The address is kept in the phone's secure storage.
- To change servers, sign out, then tap **Change server** at the bottom of the sign-in screen.
- The server is usually internal, so **the phone must be on the company network or connected to the VPN**.

### Install the server certificate on Android

If the server's certificate comes from your organisation's own root CA, or is self-signed, install it on the phone before you enter the address. Otherwise the app shows "Cannot reach the server".

1. Ask the system administrator for the certificate file. You need the root CA certificate (`.crt`, `.cer` or `.pem`). If there is no CA, ask for the server certificate itself.
2. Copy the file to the phone.
3. Open **Settings → Security & privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**. The names vary a little between phones. You can also search Settings for "CA certificate".
4. Accept the warning, then pick the file. The phone may ask you to set a screen lock.
5. To check it worked, open **Encryption & credentials → Trusted credentials → User**. The certificate should be listed there.

The app trusts the system CAs and the CAs you install yourself, and it refuses unencrypted connections. Pinning the server's own certificate comes in phase 3.

**iOS (later):** send the certificate to the phone by mail or AirDrop. Install the profile from **Settings → Profile Downloaded**, then turn on full trust in **Settings → General → About → Certificate Trust Settings**.

### Language and direction

- The app starts in the phone's language if that is Arabic or English. Otherwise it uses the organisation's default language. After you sign in, it switches to your account's language. A language you pick in the app always wins.
- Changing the language in **My account** also saves it to your account.
- Switching between Arabic (right to left) and English (left to right) **restarts the app once** to apply the direction. If the app cannot restart itself, it asks you to close and reopen it.

---

## Developer notes

### Versions

| | |
|---|---|
| Expo SDK | 58 (`expo` 58.0.16, `expo-router` 58.0.24) |
| React Native | 0.88.0 (New Architecture, Hermes) |
| React | 19.3.0 |
| TypeScript | 6.0.3, `strict` |
| Android | minSdk 24, targetSdk 36, compileSdk 37 (Expo defaults) |
| App id | `ly.ets.mobile` (Android package and iOS bundle id) |

Every dependency is pinned to an exact version, and `package-lock.json` is committed. To upgrade, use `npx expo install --fix` for a new SDK, then pin the versions again.

### Layout

```
mobile/
├── app.json                     Expo config: name ETS, ly.ets.mobile, plugins, updates off, RTL support
├── metro.config.js              Adds ../frontend/src as a watch folder (shared modules)
├── tsconfig.json                strict, aliases @/* → src/*, @web/* → ../frontend/src/*
├── jest.config.js · eslint.config.js
├── plugins/withAndroidNetworkSecurity.js   Config plugin: network_security_config (system + user CAs, no cleartext)
├── scripts/web-preview.mjs      Dev only: HTTPS static server for the web export + /api proxy to a local backend
├── assets/images/               Icon, adaptive icon, splash, favicon (the ETS mark of frontend/public/favicon.svg)
├── __tests__/                   Jest unit tests
└── src/
    ├── app/                     Screens (expo-router, file-based)
    │   ├── _layout.tsx          Fonts, language, session; which screens are allowed (Stack.Protected)
    │   ├── setup.tsx · login.tsx · change-password.tsx
    │   └── (tabs)/              الرئيسية / التنبيهات / حسابي
    │       ├── home/            index (dashboard), department/[id], app/[id]
    │       ├── notifications.tsx
    │       └── profile.tsx
    ├── components/              ErpWheel, PctEquation, Ring, ToneLegend, ItemCard, Icon, TopBar, AuthCard, Logo, ui
    ├── lib/                     api, session, i18n, rtl, server, storage(.web), useLoad, notifCount, links, items, types
    ├── shared/web.ts            Typed entry point to the modules shared with the web frontend
    ├── i18n/mobileMessages.ts   Strings that exist only in the app (m_*, err_* of the app)
    └── theme/                   tokens (app.css variables), fonts (Cairo), tone (pctTone scale)
```

### Code shared with the web frontend

The app imports these files directly from `../frontend/src`. They are not copied:

| File | Used for |
|---|---|
| `i18n/messages.js` | All Arabic and English strings. The app adds a few of its own in `src/i18n/mobileMessages.ts`. |
| `lib/format.js` | `pc`, `pctColor`, `pctTone` / `pctHue` (the continuous red → green scale) |
| `lib/erpModules.js` | ERP modules and the department → module mapping (`wheelSegments`) |
| `lib/wheelGeometry.js` | Wheel geometry and fills (moved out of `ErpWheel.jsx`) |
| `lib/equation.js` | The application equation (moved out of `PctEquation.jsx`) |
| `lib/notifyTabs.js` | Alert categories and severity colours (moved out of `NotificationBell.jsx`) |
| `lib/iconPaths.js` | The SVG icon set (moved out of `Icon.jsx`). Drawn with react-native-svg. |

**Why import from the frontend instead of a `shared/` folder?** These files were already plain, dependency-free JavaScript. Pointing Metro at the folder (`watchFolders`, plus `nodeModulesPaths` so Babel helpers resolve from `mobile/node_modules`) and adding a tsconfig alias was enough. The web code, its imports and its build stay as they were. The only web change was moving four small pieces out of components into `lib/`.

Rules that keep this safe:

- A shared file must import nothing. `__tests__/shared.test.ts` checks this.
- `src/shared/web.ts` is the only place that imports `@web/*`, and it gives every export a TypeScript type.
- `.github/workflows/mobile.yml` runs on changes to these files. The test above also checks that the workflow's path list stays complete.
- `__tests__/theme.test.ts` compares `src/theme/tokens.ts` with the CSS variables in `frontend/src/styles/app.css`.

### Sign-in and the session cookie (no server change)

The app signs in exactly like the website: `POST /api/auth/login`, then `/api/auth/2fa/verify` (or `/2fa/setup` + `/2fa/enable`), then `GET /api/auth/me`. The session is the server's cookie: `__Host-ets_sid`, `HttpOnly; Secure; SameSite=Strict; Path=/`, with no Domain. Every request sends `X-Requested-With: ets`, which is the server's CSRF check.

- **Android:** React Native's `fetch` uses OkHttp. Its cookie jar forwards to the system `CookieManager`, and the app calls fetch with `credentials: 'include'`. A Secure, host-only cookie with `Path=/` and no Domain satisfies the `__Host-` rules on an `https://` address. `SameSite` only applies to cross-site browser requests, not to the app's own requests. `CookieManager` stores the cookie on disk, so the session survives an app restart until the server's idle limit (60 min) or absolute limit (12 h).
- **iOS:** `NSURLSession` with `HTTPShouldHandleCookies` stores cookies in `NSHTTPCookieStorage`. Nothing there rejects a `__Host-` name. This still needs a check on a real iPhone.
- **Web preview:** checked in Chromium with `COOKIE_SECURE=true`. The browser received `__Host-ets_sid` (`secure=true`, `sameSite=Strict`), and every screen loaded with it.
- **Result: no server change is needed.** The production CORS settings were not touched. The web preview avoids CORS by serving the app and proxying `/api` from a single HTTPS origin (`scripts/web-preview.mjs`).
- A `401` outside `/api/auth/*` re-reads `/api/auth/me`, which returns the app to the sign-in screen with «انتهت الجلسة» / "Your session has ended". Server errors are shown with the shared `err_<code>` messages. Codes the app produces itself are `network`, `timeout`, `not_ets`, `url_*` and `no_server`.
- Automatic reloads (polling) send `X-ETS-Live: 1`, like the website's live reloads. They therefore never keep an idle session alive.

### Live updates

Phase 1 uses **polling** instead of the `/api/events` stream. While a screen is open and the app is in the foreground, it reloads every 60 s. The unread count also reloads every 60 s. Nothing runs in the background. React Native has no built-in `EventSource`, and a third-party SSE library would add a native-networking dependency for little gain at this stage. Phase 2 can switch to the stream.

### Direction (RTL)

`src/lib/rtl.ts` and `src/lib/i18n.tsx` handle direction. Arabic calls `I18nManager.allowRTL(true)` and `forceRTL(true)`. English calls `allowRTL(false)` and `forceRTL(false)`, so an Arabic phone does not flip the English app. When the running direction is wrong, the app reloads the bundle once with `Updates.reloadAsync()`. That call also works with expo-updates disabled. In development builds the app uses `DevSettings.reload()`. If a reload did not take effect, the app does not try again within 15 s. It shows "close and reopen" instead, so it can never loop. Layouts use only start/end properties (`marginStart`, `paddingEnd`, `textAlign: 'start'`, `borderStartWidth`). The wheel mirrors its own geometry, and its label overlay is pinned to `direction: 'ltr'`.

### Commands

```bash
cd mobile
npm ci                      # exact versions from package-lock.json
npm run typecheck           # tsc --noEmit
npm run lint                # expo lint
npm test                    # jest
npx expo start              # development server (needs a development build on the phone, see below)
```

**Web preview** (for looking at the screens on a computer; it is not a product):

```bash
npx expo export --platform web            # → dist/
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=localhost \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout key.pem -out cert.pem
TLS_CERT=cert.pem TLS_KEY=key.pem ETS_API=http://127.0.0.1:3000 npm run preview:web
# open https://localhost:8443 and enter https://localhost:8443 as the server address
```

### Build Android locally (Android Studio)

1. Install Android Studio. In the SDK Manager, add Android SDK Platform 37, Build-Tools 37.0.0, NDK 27.1.12297006 and CMake 3.22.1. Use JDK 17, for example Android Studio's bundled JBR.
2. Run `cd mobile && npm ci && npx expo prebuild --platform android --clean`. This generates `android/`, which is gitignored. Do not edit it: change `app.json` or `plugins/` instead.
3. Choose one:
   - Open `mobile/android` in Android Studio and run the `app` configuration.
   - For a development build with fast refresh, run `npx expo run:android`.
   - For an APK like CI's, run `cd android && ./gradlew assembleRelease`. The output is `app/build/outputs/apk/release/app-release.apk`.

A **debug** APK does not contain the JavaScript bundle. It loads the bundle from Metro (`npx expo start`, plus `adb reverse tcp:8081 tcp:8081` for a USB phone). That is why CI builds the release variant. Until a release key exists (phase 3), the generated project signs that variant with the Android debug key. Debug builds may use plain HTTP to Metro on `localhost`/`10.0.2.2`, and to no other host.

### CI

`.github/workflows/mobile.yml` runs on changes to `mobile/**`, the shared frontend files and the workflow itself, and can also be started by hand (`workflow_dispatch`). It runs `npm ci`, typecheck, lint and jest. It then runs `expo prebuild` for Android, checks the generated network security config, runs `./gradlew assembleRelease` (debug-signed, arm64-v8a / armeabi-v7a / x86_64), and uploads the APK as `ets-mobile-debug-<sha>`. It does not use EAS.

**iOS:** the workflow has a commented, disabled job for a macOS runner. It can be turned on once there is an Apple Developer account, the bundle id `ly.ets.mobile` is registered, and a distribution certificate and provisioning profile are stored as repository secrets. The code is iOS-ready: no Android-only API is used, and the network config plugin only touches Android.

### What only a device or CI can confirm

- That the cookie persists across restarts in Android's `CookieManager`, and how `NSHTTPCookieStorage` behaves on iOS.
- Trust of a user-installed CA with a real self-signed server.
- The RTL reload through `Updates.reloadAsync()`.
- Arabic text and the Cairo font in native `Text`, and react-native-svg drawing of the wheel and the rings.
- The Gradle build itself. It needs `dl.google.com` and Maven, which the development container here cannot reach.

### Phase 2 and 3 notes

- **Phase 2:** editing by permission (`can.*` from `/api/tracker/applications/:id`), using the same `PATCH /tracker/functions/:id` and approval flows as the web. Also: the approvals list, approve and reject, the live stream (`/api/events`) instead of polling, a notification preferences screen, 2FA management and password change in the profile, and notification deep links to approvals.
- **Phase 3:** certificate pinning (SHA-256 of the server leaf, like ETS Alerts' `cert_sha256`, through a native OkHttp / `URLSession` hook or a pinning library); a release keystore in repository secrets; store listings; the iOS job; push notifications (FCM / APNs) reusing the device pairing of `/api/devices`; and replacing ETS Alerts.
