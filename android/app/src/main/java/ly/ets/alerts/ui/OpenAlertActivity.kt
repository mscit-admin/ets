package ly.ets.alerts.ui

import android.app.Activity
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import ly.ets.alerts.core.UrlRules
import ly.ets.alerts.data.Settings
import ly.ets.alerts.sync.Sync
import ly.ets.alerts.work.MarkReadWorker

/**
 * Invisible, non-exported trampoline for notification taps. Android 12+ forbids starting
 * activities from receivers or services after a notification tap, so the tap lands here,
 * opens `{url}{link}` in the app's own WebView (1.1.0; the default browser before) and queues the
 * mark-read call.
 */
class OpenAlertActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getLongExtra(EXTRA_ID, -1L)
        val link = intent.getStringExtra(EXTRA_LINK)
        openAlert(this, id, link)
        finish()
    }

    companion object {
        private const val EXTRA_ID = "alert_id"
        private const val EXTRA_LINK = "alert_link"

        fun pendingIntent(context: Context, id: Long, link: String?): PendingIntent {
            val intent = Intent(context, OpenAlertActivity::class.java)
                .putExtra(EXTRA_ID, id)
                .putExtra(EXTRA_LINK, link)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_HISTORY)
            return PendingIntent.getActivity(
                context,
                (id % Int.MAX_VALUE).toInt(),
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        /**
         * Opens the alert's page in the app's WebView and marks it read (locally now, on the server when
         * reachable). The link never leaves the paired server ([UrlRules.resolveLink] falls back to its root).
         */
        fun openAlert(context: Context, id: Long, link: String?) {
            val base = Settings.get(context).baseUrl ?: return
            WebActivity.open(context, UrlRules.resolveLink(base, link))
            if (id > 0) {
                Sync.markReadLocally(context, id)
                MarkReadWorker.enqueue(context, id)
            }
        }
    }
}
