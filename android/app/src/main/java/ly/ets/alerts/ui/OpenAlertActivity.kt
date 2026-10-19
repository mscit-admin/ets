package ly.ets.alerts.ui

import android.app.Activity
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import ly.ets.alerts.R
import ly.ets.alerts.core.UrlRules
import ly.ets.alerts.data.Settings
import ly.ets.alerts.sync.Sync
import ly.ets.alerts.work.MarkReadWorker

/**
 * Invisible, non-exported trampoline for notification taps. Android 12+ forbids starting
 * activities from receivers or services after a notification tap, so the tap lands here,
 * opens `{url}{link}` in the default browser and queues the mark-read call.
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

        /** Opens the alert in the browser and marks it read (locally now, on the server when reachable). */
        fun openAlert(context: Context, id: Long, link: String?) {
            val base = Settings.get(context).baseUrl ?: return
            val url = UrlRules.resolveLink(base, link)
            val view = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addCategory(Intent.CATEGORY_BROWSABLE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(view)
            } catch (e: ActivityNotFoundException) {
                Toast.makeText(context, R.string.no_browser, Toast.LENGTH_LONG).show()
            }
            if (id > 0) {
                Sync.markReadLocally(context, id)
                MarkReadWorker.enqueue(context, id)
            }
        }
    }
}
