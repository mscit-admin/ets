# Changelog: ETS Alerts (Android)

All notable changes to the Android app are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the app uses [Semantic Versioning](https://semver.org/).
Releases are tagged `android-vX.Y.Z`.

## [Unreleased]

### Changed

- CI: build workflow actions updated to their Node 24 majors; runner pinned to `ubuntu-24.04`. No app change.

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

[Unreleased]: https://github.com/mscit-admin/ets/compare/android-v1.0.0...HEAD
[1.0.0]: https://github.com/mscit-admin/ets/releases/tag/android-v1.0.0
