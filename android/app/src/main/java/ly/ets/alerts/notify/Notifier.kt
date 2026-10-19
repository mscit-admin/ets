package ly.ets.alerts.notify

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import ly.ets.alerts.R
import ly.ets.alerts.core.Alert
import ly.ets.alerts.core.Severity
import ly.ets.alerts.ui.MainActivity
import ly.ets.alerts.ui.OpenAlertActivity

object Notifier {
    const val CHANNEL_CRITICAL = "alerts_critical"
    const val CHANNEL_WARNING = "alerts_warning"
    const val CHANNEL_INFO = "alerts_info"
    const val CHANNEL_SERVICE = "connection"
    const val CHANNEL_ACCOUNT = "account"

    const val SERVICE_NOTIFICATION_ID = 1
    private const val REVOKED_NOTIFICATION_ID = 2
    private const val TAG_ALERT = "alert"

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val channels = listOf(
            NotificationChannel(
                CHANNEL_CRITICAL,
                context.getString(R.string.channel_critical),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.channel_critical_desc)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                enableVibration(true)
            },
            NotificationChannel(
                CHANNEL_WARNING,
                context.getString(R.string.channel_warning),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.channel_warning_desc)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
            NotificationChannel(
                CHANNEL_INFO,
                context.getString(R.string.channel_info),
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = context.getString(R.string.channel_info_desc)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
            NotificationChannel(
                CHANNEL_SERVICE,
                context.getString(R.string.channel_service),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                description = context.getString(R.string.channel_service_desc)
                setShowBadge(false)
            },
            NotificationChannel(
                CHANNEL_ACCOUNT,
                context.getString(R.string.channel_account),
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
        nm.createNotificationChannels(channels)
    }

    private fun canPost(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun post(context: Context, tag: String?, id: Int, notification: Notification) {
        if (!canPost(context)) return
        try {
            NotificationManagerCompat.from(context).notify(tag, id, notification)
        } catch (e: SecurityException) {
            // Permission revoked between the check and the call.
        }
    }

    private fun notificationId(alertId: Long): Int = (alertId % Int.MAX_VALUE).toInt()

    fun severityColor(context: Context, severity: Severity): Int = ContextCompat.getColor(
        context,
        when (severity) {
            Severity.CRITICAL -> R.color.severity_critical
            Severity.WARNING -> R.color.severity_warning
            Severity.INFO -> R.color.severity_info
        },
    )

    fun showAlert(context: Context, alert: Alert) {
        val channel = when (alert.severity) {
            Severity.CRITICAL -> CHANNEL_CRITICAL
            Severity.WARNING -> CHANNEL_WARNING
            Severity.INFO -> CHANNEL_INFO
        }
        val priority = when (alert.severity) {
            Severity.CRITICAL -> NotificationCompat.PRIORITY_HIGH
            Severity.WARNING -> NotificationCompat.PRIORITY_DEFAULT
            Severity.INFO -> NotificationCompat.PRIORITY_LOW
        }
        val color = severityColor(context, alert.severity)
        val title = alert.title.ifBlank { context.getString(R.string.public_alert_title) }

        // What the lock screen shows instead of the title/body.
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_ets)
            .setColor(color)
            .setContentTitle(context.getString(R.string.public_alert_title))
            .build()

        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_ets)
            .setColor(color)
            .setContentTitle(title)
            .setContentText(alert.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body))
            .setPriority(priority)
            .setWhen(alert.createdAtMillis() ?: System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setContentIntent(OpenAlertActivity.pendingIntent(context, alert.id, alert.link))
            .build()

        post(context, TAG_ALERT, notificationId(alert.id), notification)
    }

    fun cancelAlert(context: Context, alertId: Long) {
        NotificationManagerCompat.from(context).cancel(TAG_ALERT, notificationId(alertId))
    }

    /** Clears alert notifications (the service notification is owned by the service). */
    fun cancelAllAlerts(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        nm.activeNotifications
            .filter { it.tag == TAG_ALERT }
            .forEach { nm.cancel(it.tag, it.id) }
    }

    fun showRevoked(context: Context) {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ACCOUNT)
            .setSmallIcon(R.drawable.ic_stat_ets)
            .setColor(ContextCompat.getColor(context, R.color.ets_navy))
            .setContentTitle(context.getString(R.string.revoked_title))
            .setContentText(context.getString(R.string.revoked_body))
            .setAutoCancel(true)
            .setContentIntent(open)
            .build()
        post(context, null, REVOKED_NOTIFICATION_ID, notification)
    }

    fun serviceNotification(context: Context): Notification {
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_ets)
            .setColor(ContextCompat.getColor(context, R.color.ets_navy))
            .setContentTitle(context.getString(R.string.service_title))
            .setContentText(context.getString(R.string.service_text))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }
}
