package ly.ets.alerts.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import ly.ets.alerts.Session

/**
 * Restarts delivery after a reboot or an app update. Both broadcasts are protected
 * (only the system can send them) and both are exempt from Android 12's background
 * foreground-service start restriction.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> Session.ensureRunning(context)
        }
    }
}
