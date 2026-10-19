# ETS Alerts · تنبيهات ETS

A small native Android app that delivers ETS notifications to the phone.
تطبيق أندرويد صغير يوصل تنبيهات نظام ETS إلى الهاتف.

- [العربية](#العربية)
- [English](#english)
- [Developer notes](#developer-notes)

---

## العربية

### ما الذي يفعله التطبيق؟

- يُربط الهاتف بحسابك في ETS عن طريق رمز QR من صفحة **الملف الشخصي ← أجهزتي**.
- يستقبل تنبيهات ETS ويعرضها كإشعارات على الهاتف، مصنّفة حسب الخطورة: **حرج** و**تحذير** و**معلومة**.
- عند الضغط على الإشعار يفتح الرابط في المتصفح، ويُعلَّم التنبيه كمقروء.
- تعرض الشاشة الرئيسية آخر 50 تنبيهاً مع لون الخطورة والوقت وحالة القراءة.
- لا يحتوي التطبيق على أي تحليلات ولا خدمات Google. ولا يتصل إلا بخادم ETS الذي رُبط به.
- على شاشة القفل يظهر فقط «تنبيه جديد من ETS»، ولا يظهر العنوان ولا النص.

### تنزيل التطبيق (APK)

**الإصدار الرسمي الموقَّع (موصى به):**

1. افتح صفحة المستودع على GitHub ثم **Releases**.
2. نزّل الملف `ets-alerts-<الإصدار>.apk` من آخر إصدار `android-v…`.

**نسخة تجريبية (Debug) من أي بناء:**

1. افتح **Actions ← Android (ETS Alerts)** واختر آخر تشغيل ناجح.
2. نزّل من قسم **Artifacts** الملف `ets-alerts-debug-<sha>`. وهو ملف zip بداخله `app-debug.apk`.

> كل بناء Debug يُوقَّع بمفتاح مؤقت مختلف. لذلك قد يرفض الهاتف تحديث نسخة Debug بنسخة Debug أحدث. في هذه الحالة احذف القديمة أولاً. أما الإصدارات الرسمية فتتحدّث فوق بعضها مباشرة.

### التثبيت

1. انقل ملف APK إلى الهاتف، أو نزّله مباشرة من المتصفح.
2. افتحه. سيطلب أندرويد السماح بـ **تثبيت التطبيقات غير المعروفة** للتطبيق الذي فتح الملف (المتصفح أو مدير الملفات). فعّل الخيار ثم ارجع واضغط **تثبيت**.
3. يتطلب التطبيق أندرويد 8.0 أو أحدث.

### الربط

1. على الكمبيوتر افتح ETS ثم **الملف الشخصي ← أجهزتي** وأنشئ رمز QR للربط.
2. على الهاتف افتح **تنبيهات ETS** واضغط **مسح رمز QR**. اسمح باستخدام الكاميرا عند الطلب.
3. إن تعذّر المسح فانسخ نص JSON الظاهر أسفل الرمز، والصقه في الحقل، ثم اضغط **ربط**.
4. راجع عنوان الخادم وبصمة الشهادة، ثم أكّد. سيظهر اسمك بعد نجاح الربط.
5. اسمح بالإشعارات عندما يطلبها التطبيق (أندرويد 13 وما بعده).

لإلغاء الربط اضغط **فصل** في شاشة «الجهاز والربط»، ثم احذف الجهاز أيضاً من **أجهزتي** على الموقع.
إذا أُلغي الجهاز من الموقع يمسح التطبيق بياناته تلقائياً، ويظهر إشعار «تم إلغاء ربط الجهاز».

### الـ VPN

خادم ETS داخلي. **يجب أن يكون الهاتف متصلاً بشبكة VPN الخاصة بالشركة** حتى يصل إلى الخادم، سواء عند الربط أو لاستقبال التنبيهات.
عند انقطاع الـ VPN تتأخر التنبيهات، ثم تصل تلقائياً بعد عودة الاتصال.

### البطارية والاتصال الدائم

- **اتصال دائم** (مفعّل افتراضياً): يُبقي التطبيق اتصالاً مباشراً بالخادم فتصل التنبيهات فوراً، ويظهر إشعار صغير دائم «تنبيهات ETS متصل».
- عند إيقافه يتحقق التطبيق من التنبيهات كل 15 دقيقة تقريباً.
- لضمان وصول التنبيهات اضغط **إعدادات تحسين البطارية** واجعل التطبيق «غير محسَّن» أو «غير مقيّد».
- في هواتف Samsung وXiaomi وHuawei وغيرها أضف التطبيق أيضاً إلى قائمة التطبيقات المستثناة من «النوم» أو «التشغيل التلقائي».
- يعيد التطبيق التشغيل تلقائياً بعد إعادة تشغيل الهاتف.

### إنشاء مفتاح التوقيع وإضافة الأسرار (للمسؤول، مرة واحدة)

```bash
keytool -genkeypair -v -keystore ets-alerts-release.jks -alias ets-alerts \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 ets-alerts-release.jks > ets-alerts-release.jks.b64
```

أضف الأسرار الأربعة في **Settings ← Secrets and variables ← Actions** في المستودع:

| السر | القيمة |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | محتوى `ets-alerts-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | كلمة مرور ملف المفاتيح |
| `ANDROID_KEY_ALIAS` | `ets-alerts` |
| `ANDROID_KEY_PASSWORD` | كلمة مرور المفتاح |

أو باستخدام `gh`:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < ets-alerts-release.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body ets-alerts
gh secret set ANDROID_KEY_PASSWORD
```

احفظ ملف `.jks` وكلمات المرور في مكان آمن خارج المستودع. **فقدانها يعني أن الهواتف لن تقبل تحديثات التطبيق**، وسيلزم حذف التطبيق وتثبيته من جديد.

### إصدار نسخة جديدة

1. حدّث `android/CHANGELOG.md`.
2. أنشئ وسماً بالشكل `android-vX.Y.Z` وادفعه:

   ```bash
   git tag android-v1.0.0
   git push origin android-v1.0.0
   ```

3. سيبني GitHub Actions نسخة موقَّعة وينشر **Release** يحتوي ملف APK.
   - يُؤخذ `versionName` من الوسم (`1.0.0`).
   - ويُحسب `versionCode` على النحو `X*10000 + Y*100 + Z`.

---

## English

### What the app does

- Pairs the phone with your ETS account via a QR code from **Profile → My devices (أجهزتي)**.
- Receives ETS alerts and shows them as phone notifications, in three channels by severity: **critical**, **warning** and **info**.
- Tapping a notification opens the alert's page in the browser and marks it read.
- The main screen lists the last 50 alerts with severity colour, time and read state.
- No analytics and no Google services. The app talks only to the paired ETS server.
- The lock screen shows only "New ETS alert", never the title or body.

### Download the APK

**Signed release (recommended):**

1. Open the repository on GitHub and go to **Releases**.
2. Download `ets-alerts-<version>.apk` from the latest `android-v…` release.

**Debug build of any commit:**

1. Go to **Actions → Android (ETS Alerts)** and open the latest green run.
2. Under **Artifacts**, download `ets-alerts-debug-<sha>`. It is a zip containing `app-debug.apk`.

> Each debug build is signed with a throw-away CI key, so Android may refuse to update one debug build with another. If that happens, uninstall the old one first. Signed releases update in place.

### Install

1. Copy the APK to the phone, or download it directly in the phone's browser.
2. Open it. Android asks you to allow **Install unknown apps** for the app that opened it (the browser or file manager). Allow it, go back and tap **Install**.
3. Requires Android 8.0 or newer.

### Pair

1. On a computer, open ETS, go to **Profile → My devices (أجهزتي)** and create a pairing QR code.
2. On the phone, open **ETS Alerts** and tap **Scan QR code**. Allow camera access.
3. If scanning is not possible, copy the JSON shown under the QR code, paste it into the field and tap **Pair**.
4. Check the server address and certificate fingerprint, then confirm. Your name appears once pairing succeeds.
5. Allow notifications when asked (Android 13+).

**Unpairing:** tap **Unpair (فصل)** on the *Device & pairing* screen, and also remove the device under **My devices** on the web.

**Revoked on the web:** if the device is revoked there, the app wipes its data automatically and shows "Device unpaired".

### VPN

The ETS server is internal. **The phone must be connected to the company VPN** to reach it, both for pairing and for receiving alerts. While the VPN is down, alerts are delayed. They arrive automatically once it reconnects.

### Battery and persistent connection

- **Persistent connection** (on by default) keeps a live connection, so alerts arrive instantly. A small permanent "ETS Alerts is connected" notification is shown while it runs.
- When it is off, the app checks for alerts about every 15 minutes.
- For reliable delivery, tap **Battery optimisation settings** and set ETS Alerts to *Not optimised* / *Unrestricted*.
- On Samsung, Xiaomi, Huawei and similar phones, also exclude the app from "sleeping apps" or auto-start restrictions.
- Delivery restarts automatically after a reboot.

### Create the signing keystore and add the secrets (admin, once)

```bash
keytool -genkeypair -v -keystore ets-alerts-release.jks -alias ets-alerts \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 ets-alerts-release.jks > ets-alerts-release.jks.b64
```

Add four repository secrets under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | contents of `ets-alerts-release.jks.b64` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `ets-alerts` |
| `ANDROID_KEY_PASSWORD` | key password |

Or with `gh`:

```bash
gh secret set ANDROID_KEYSTORE_BASE64 < ets-alerts-release.jks.b64
gh secret set ANDROID_KEYSTORE_PASSWORD
gh secret set ANDROID_KEY_ALIAS --body ets-alerts
gh secret set ANDROID_KEY_PASSWORD
```

Keep the `.jks` file and its passwords somewhere safe, outside the repository. **If they are lost, installed phones will not accept updates**: the app must be uninstalled and installed again.

### Cut a release

1. Update `android/CHANGELOG.md`.
2. Create and push a tag of the form `android-vX.Y.Z`:

   ```bash
   git tag android-v1.0.0
   git push origin android-v1.0.0
   ```

3. GitHub Actions builds a signed APK and publishes a **Release** with the APK attached.
   - `versionName` is taken from the tag (`1.0.0`).
   - `versionCode` is `X*10000 + Y*100 + Z`.

A tag build fails clearly if the signing secrets are missing.

---

## Developer notes

### Build

Prerequisites: JDK 17 and the Android SDK (platform 34).

```bash
cd android
./gradlew assembleDebug testDebugUnitTest lintDebug
```

All versions are in `gradle/libs.versions.toml`:

| Component | Version |
|---|---|
| AGP | 8.5.2 |
| Kotlin | 1.9.24 |
| Gradle | 8.7 |
| compileSdk / targetSdk | 34 |
| minSdk | 26 |
| core-ktx | 1.13.1 |
| appcompat | 1.7.0 |
| work-runtime-ktx | 2.9.1 |
| OkHttp + okhttp-sse | 4.12.0 |
| zxing-android-embedded | 4.3.0 |

`versionCode` and `versionName` come from the `ETS_VERSION_CODE` and `ETS_VERSION_NAME` environment variables (default 1 / 1.0.0).

**Release signing** is enabled only when all four of these are set:

- `ANDROID_KEYSTORE_PATH`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Otherwise `assembleRelease` produces an unsigned APK.

Debug builds use the application id `ly.ets.alerts.debug`, so they install side by side with the release (`ly.ets.alerts`).

### Server contract used

| Call | Notes |
|---|---|
| `POST /api/devices/pair` | `{code, device_name, platform:"android", app_version}` → `{device_id, token, user:{full_name, lang}}` |
| `GET /api/m/me` | → `{full_name, lang, server_version}` |
| `GET /api/m/notifications?after_id=N&limit=50` | → `{items:[…], unread}` |
| `POST /api/m/notifications/{id}/read` | → 204 |
| `GET /api/m/events` | Server-Sent Events. Must answer `Content-Type: text/event-stream`. Events: `notification` `{id}`, `unread` `{unread}`. Comment heartbeat every 25 s; the client read timeout is 75 s. |

- Every call except pairing sends `Authorization: Bearer <token>`.
- A 401 from any call except pairing unpairs the device.
- Ids may be JSON numbers or numeric strings.
- `created_at` is ISO-8601. A value with no offset is read as UTC.
- `link` must be a same-origin path such as `/app/123`. Anything else opens the server root instead.

### Delivery

| Path | When it runs | What it does |
|---|---|---|
| Foreground service (`dataSync`) | While **Persistent connection** is on | Holds the SSE stream. Reconnects with backoff from 2 s up to 5 min (±20% jitter), and immediately when a network or VPN becomes available. |
| WorkManager periodic job | Always while paired, every 15 min | Runs the same incremental sync. |

- **Incremental sync:**
  1. Fetches `after_id = last seen id`, paging while full pages return.
  2. Notifies at most 10 new unread alerts per sync.
  3. The first sync after pairing only records a baseline and does not ring the phone.
- **Refresh button:** also re-reads the cached range, so read flags changed on the web show up.
- **Notification taps** go through a non-exported trampoline activity, as Android 12+ requires. It opens `{url}{link}` with `ACTION_VIEW` and queues `POST …/read` through WorkManager, which retries while offline.

### TLS and storage

- **Pairing URL:** only `https://` is accepted. Cleartext is also disabled by `network_security_config.xml` and by OkHttp `MODERN_TLS`. Redirects are not followed.
- **With `cert_sha256` in the QR:** OkHttp uses a custom `X509TrustManager` that accepts only a leaf certificate whose SHA-256 over its DER encoding equals the pin. No CA store is consulted.
- **Hostname check (pinned):** it first runs the normal SAN check. If the certificate has no matching SAN (for example it is reached by a VPN IP), the connection is accepted *only because the leaf is the pinned certificate*. See `net/Tls.kt`.
- **Expiry (pinned):** not enforced, because the pin identifies the exact certificate. Re-pair after the server certificate changes.
- **Without a pin:** the system trust store plus user-installed CAs, so that a corporate CA installed by MDM works. There is no trust-all code path.
- **Computing the pin on the server:**

  ```bash
  openssl x509 -in cert.pem -outform der | sha256sum
  ```

- **Token storage:** the token is encrypted with an AES-256-GCM key held in the Android Keystore. Only the ciphertext is stored in private SharedPreferences. The token is never logged.
- **Backups:** `allowBackup="false"`, and data-extraction rules exclude everything.

### Tests

Run them with `./gradlew testDebugUnitTest`. They run on the JVM and cover:

- payload parsing and validation
- URL and link rules
- fingerprint matching
- backoff
- alert parsing
- MockWebServer tests of the real TLS pinning, the hostname fallback and the 401 handling, against self-signed certificates

### Platform notes

The app targets SDK 34. Android 15 limits `dataSync` foreground services to 6 h per day, but only for apps targeting SDK 35. Before raising `targetSdk`, revisit the service type: for example, rely on the WorkManager path, or use the `remoteMessaging` type.
