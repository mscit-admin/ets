package ly.ets.alerts

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import ly.ets.alerts.data.Settings
import ly.ets.alerts.net.EtsApi
import ly.ets.alerts.net.Http
import ly.ets.alerts.net.RemoteUnpair
import ly.ets.alerts.notify.Notifier
import ly.ets.alerts.service.AlertStreamService
import ly.ets.alerts.work.PollWorker
import java.util.concurrent.TimeUnit

/** Lifecycle of a pairing: start/stop delivery, unpair, and react to revocation. */
object Session {
    private const val WORK_PERIODIC = "ets-poll-periodic"
    private const val WORK_NOW = "ets-poll-now"

    fun userAgent(): String =
        "ETS-Alerts/${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE}; ${BuildConfig.APPLICATION_ID})"

    /** API client for the current pairing, or null when not paired. */
    fun api(context: Context): EtsApi? {
        val p = Settings.get(context).pairing() ?: return null
        return EtsApi(p.baseUrl, Http.client(p.certSha256), p.token, userAgent())
    }

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    /**
     * Makes sure delivery runs as configured: the 15-minute WorkManager poll always,
     * plus the foreground SSE service when «اتصال دائم» is on. Safe to call repeatedly.
     */
    fun ensureRunning(context: Context) {
        val settings = Settings.get(context)
        if (!settings.isPaired) {
            stopDelivery(context)
            return
        }
        val periodic = PeriodicWorkRequestBuilder<PollWorker>(15, TimeUnit.MINUTES)
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(WORK_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic)

        if (settings.persistentConnection) startStream(context) else stopStream(context)
    }

    /** One-off sync as soon as the network allows (used after pairing and on manual refresh fallback). */
    fun syncSoon(context: Context) {
        val req = OneTimeWorkRequestBuilder<PollWorker>()
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NOW, ExistingWorkPolicy.REPLACE, req)
    }

    private fun startStream(context: Context) {
        try {
            ContextCompat.startForegroundService(context, Intent(context, AlertStreamService::class.java))
        } catch (e: IllegalStateException) {
            // Android 12+ refuses to start a foreground service from the background
            // (ForegroundServiceStartNotAllowedException). The periodic poll still delivers;
            // the service starts next time the app is opened or the phone reboots.
        } catch (e: SecurityException) {
            // Same fallback.
        }
    }

    private fun stopStream(context: Context) {
        context.stopService(Intent(context, AlertStreamService::class.java))
    }

    private fun stopDelivery(context: Context) {
        stopStream(context)
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(WORK_PERIODIC)
        wm.cancelUniqueWork(WORK_NOW)
    }

    /**
     * User pressed «فصل». Blocking (call off the main thread): asks the server to revoke this
     * device (best effort, short timeout), then ALWAYS wipes locally.
     * @return true if the server could not confirm, so the user should also remove the
     *   device under أجهزتي on the web. 401 counts as already gone.
     */
    fun unpair(context: Context): Boolean {
        val app = context.applicationContext
        userUnpairing = true
        try {
            // Stop delivery first so the stream/poll do not race the DELETE and report a 401
            // as a revocation (which would post «تم إلغاء ربط الجهاز» for a deliberate unpair).
            val api = api(app)
            stopDelivery(app)
            val remote = api?.unregisterDevice() ?: RemoteUnpair.ALREADY_GONE
            Settings.get(app).clearPairing()
            Notifier.cancelAllAlerts(app)
            AlertsBus.changed()
            return remote == RemoteUnpair.FAILED
        } finally {
            userUnpairing = false
        }
    }

    @Volatile
    private var userUnpairing = false

    /** Server answered 401: the device was revoked. Wipe, stop, and tell the user once. */
    @Synchronized
    fun revoked(context: Context) {
        val app = context.applicationContext
        stopDelivery(app)
        val hadPairing = Settings.get(app).clearPairing()
        Notifier.cancelAllAlerts(app)
        if (hadPairing && !userUnpairing) Notifier.showRevoked(app)
        AlertsBus.changed()
    }
}
