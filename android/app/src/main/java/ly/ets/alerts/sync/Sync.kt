package ly.ets.alerts.sync

import android.content.Context
import ly.ets.alerts.AlertsBus
import ly.ets.alerts.Session
import ly.ets.alerts.core.Alert
import ly.ets.alerts.core.mergeRecent
import ly.ets.alerts.core.selectToNotify
import ly.ets.alerts.data.Settings
import ly.ets.alerts.net.EtsApi
import ly.ets.alerts.net.UnauthorizedException
import ly.ets.alerts.notify.Notifier
import java.io.IOException

/**
 * Fetches new alerts and posts system notifications. Used by the SSE service (on each
 * `notification` event), the 15-minute WorkManager poll, and the refresh button.
 * Runs one sync at a time per process.
 */
object Sync {
    sealed class Result {
        data class Ok(val newAlerts: Int) : Result()
        object NotPaired : Result()
        object Revoked : Result()
        data class Failed(val error: IOException) : Result()
    }

    private const val MAX_PAGES = 20
    private val lock = Any()

    /**
     * @param refreshCached also re-reads the alerts already in the local list so read
     *   flags changed on the web are reflected (used by the refresh button).
     */
    fun run(context: Context, refreshCached: Boolean = false): Result = synchronized(lock) {
        val app = context.applicationContext
        val settings = Settings.get(app)
        val api = Session.api(app) ?: return Result.NotPaired
        try {
            val fetched = ArrayList<Alert>()
            var unread: Int? = null
            val cached = settings.recent

            if (refreshCached && cached.isNotEmpty()) {
                val page = api.notifications(cached.minOf { it.id } - 1)
                fetched += page.items
                unread = page.unread
            }

            val previousCursor = settings.lastNotifiedId
            var cursor = maxOf(previousCursor, cached.maxOfOrNull { it.id } ?: 0L)
            for (i in 0 until MAX_PAGES) {
                val page = api.notifications(cursor)
                unread = page.unread
                if (page.items.isEmpty()) break
                fetched += page.items
                val pageMax = page.items.maxOf { it.id }
                if (pageMax <= cursor) break
                cursor = pageMax
                if (page.items.size < EtsApi.PAGE_SIZE) break
            }

            // The first sync after pairing only records a baseline: older alerts appear in
            // the list but do not ring the phone.
            val toNotify = if (settings.baselineDone) selectToNotify(fetched, previousCursor) else emptyList()
            settings.recent = mergeRecent(cached, fetched)
            settings.lastNotifiedId = cursor
            settings.baselineDone = true
            unread?.let { settings.unread = it }

            toNotify.sortedBy { it.id }.forEach { Notifier.showAlert(app, it) }
            AlertsBus.changed()
            Result.Ok(toNotify.size)
        } catch (e: UnauthorizedException) {
            Session.revoked(app)
            Result.Revoked
        } catch (e: IOException) {
            Result.Failed(e)
        }
    }

    /** Marks an alert read on the server. Returns false if it should be retried later. */
    fun markRead(context: Context, id: Long): Boolean {
        val app = context.applicationContext
        val api = Session.api(app) ?: return true
        return try {
            api.markRead(id)
            true
        } catch (e: UnauthorizedException) {
            Session.revoked(app)
            true
        } catch (e: IOException) {
            false
        }
    }

    /** Optimistically flags an alert read in the local list and clears its notification. */
    fun markReadLocally(context: Context, id: Long) {
        val app = context.applicationContext
        synchronized(lock) {
            val settings = Settings.get(app)
            val list = settings.recent
            if (list.any { it.id == id && !it.read }) {
                settings.recent = list.map { if (it.id == id) it.copy(read = true) else it }
                settings.unread = (settings.unread - 1).coerceAtLeast(0)
            }
        }
        Notifier.cancelAlert(app, id)
        AlertsBus.changed()
    }
}
