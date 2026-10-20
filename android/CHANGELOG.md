# Changelog: ETS Alerts (Android)

All notable changes to the Android app are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses [Semantic Versioning](https://semver.org/).
Releases are tagged `android-vX.Y.Z`.

## [Unreleased]

## [1.1.0] - 2026-10-20

Needs ETS server 1.11.0 or newer (read-only sessions). On an older server the pages still open, but the
session is an ordinary browser session: the server does not limit it to viewing.

### Added

**ETS inside the app**
- The main screen is now the ETS web application of the paired server in a WebView: the same pages as in the
  browser — the ERP wheel and overall progress, the alerts right below it, a module's department page, an
  application's rings and its items — each user seeing only what their permissions and scope allow.
- Sign in inside the app with the normal ETS sign-in (username or e-mail, password, 2FA). The session cookie is
  kept by the WebView, so the app does not ask again until the session ends under the server's usual rules
  (idle timeout, absolute lifetime, sign-out, password change).
- **View only:** the WebView adds `ETSAlerts/<version> (Android)` to its User-Agent; the server then makes the
  session read-only (it refuses every change with `403 readonly_session`) and the pages hide their editing
  controls and show «وضع العرض فقط». Edits and approvals are made in a browser.
- Toolbar: refresh, ETS home, the native alerts list and «الجهاز والربط»; the back button goes back through the
  pages; a progress bar while a page loads; an error screen with «إعادة المحاولة» and a VPN hint when the server
  cannot be reached.

### Changed

- Tapping a notification opens its page (`{url}{link}`) inside the app instead of the external browser, and
  still marks the alert read.
- The native list of the last 50 alerts moved to the toolbar menu («قائمة التنبيهات»); pairing opens ETS when done.
- Unpairing (or a revocation by the server) also clears the in-app browser's cookies, web storage and cache.
- CI: build workflow actions updated to their Node 24 majors; runner pinned to `ubuntu-24.04`.

### Security

- Only the paired origin (https, host, port and ETS path) loads in the WebView; any other link opens in the
  external browser. File and content access are off, there is no JavaScript interface, mixed content and new
  windows are refused, third-party cookies are off.
- TLS: with a pinned pairing (`cert_sha256`), a certificate error is overridden only when the failing URL is on
  the paired host and port AND the SHA-256 of the leaf certificate's DER encoding equals the pin
  (`SslCertificate.getX509Certificate()` on Android 10+, the certificate's saved state on Android 8–9);
  everything else is refused. A page served with a certificate the system trusts is still compared with the pin
  once loaded. Without a pin the system trust decides, with no override.
- Excel exports (made in the page as a download) are not saved inside the app; the app says to export from a
  browser.

## [1.0.0] - 2026-10-19

### Added

**Pairing**
- Scan the QR from ETS Profile → My devices (أجهزتي) with the embedded zxing scanner, or paste the pairing JSON instead.
- A confirmation dialog shows the server and the certificate fingerprint before pairing.
- The pairing screen shows the server URL, the user's full name, the server version and «فصل» (unpair).

**TLS**
- Only `https://` server URLs are accepted.
- When the QR carries `cert_sha256`, the app trusts only the leaf certificate with that SHA-256. The hostname check falls back to the pin when the SAN does not match, for example on a VPN IP.
- Without a pin, the app uses the system trust store plus user (MDM) CAs.
- There is no trust-all path, cleartext is disabled, and redirects are not followed.

**Token storage**
- The device token is wrapped with an Android Keystore AES-GCM key and is never logged.

**Delivery**
- «اتصال دائم»: a `dataSync` foreground service holds the SSE stream (`/api/m/events`). It reconnects with backoff from 2 s to 5 min and immediately when the network or VPN comes back.
- A WorkManager job polls every 15 minutes as a fallback and is the only path when the persistent connection is off.
- Delivery restarts after a reboot or an app update.

**Notifications**
- Three channels by severity: critical (high importance), warning and info.
- Title and body are shown, and the lock screen shows only «تنبيه جديد من ETS».
- Tapping a notification opens `{url}{link}` in the default browser and marks the alert read, retrying while offline.

**Revocation**
- A 401 wipes the pairing, stops delivery and posts «تم إلغاء ربط الجهاز».
- «فصل» calls `DELETE /api/m/device` (best effort, 5 s timeout), then always wipes locally. 401 or success needs no further action. On a network error or other status, the app asks the user to also remove the device under أجهزتي.

**Main screen and languages**
- The main screen lists the last 50 alerts with severity colour, time and read state, and has a refresh button.
- Arabic and English UI, RTL support, and a navy/blue corporate theme.

**Security**
- `allowBackup=false`, data-extraction rules exclude everything, and exported components are kept to a minimum.
- There are no analytics or Google services.
- R8 minification and resource shrinking are enabled for release builds.

**CI**
- The GitHub Actions workflow builds the debug APK, runs the unit tests and lint, and uploads artifacts.
- When signing secrets are configured, it also builds a signed release APK.
- On `android-v*` tags, it creates a GitHub Release.

[Unreleased]: https://github.com/mscit-admin/ets/compare/android-v1.1.0...HEAD
[1.1.0]: https://github.com/mscit-admin/ets/compare/android-v1.0.0...android-v1.1.0
[1.0.0]: https://github.com/mscit-admin/ets/releases/tag/android-v1.0.0
