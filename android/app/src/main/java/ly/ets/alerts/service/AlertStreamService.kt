package ly.ets.alerts.service

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ServiceCompat
import ly.ets.alerts.AlertsBus
import ly.ets.alerts.Session
import ly.ets.alerts.core.Backoff
import ly.ets.alerts.core.Json
import ly.ets.alerts.data.Settings
import ly.ets.alerts.net.Http
import ly.ets.alerts.notify.Notifier
import ly.ets.alerts.sync.Sync
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.random.Random

/**
 * «اتصال دائم»: a dataSync foreground service holding `GET /api/m/events` (SSE) open.
 * On a `notification` event it runs [Sync]; on failure it reconnects with 2 s -> 5 min
 * backoff, and immediately when the network (e.g. the VPN) comes back. A 401 unpairs.
 *
 * All connection state is touched on the main thread; network work runs on [worker].
 */
class AlertStreamService : Service() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var worker: ExecutorService
    private val backoff = Backoff()
    private var source: EventSource? = null
    private var stopped = false
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    private val reconnect = Runnable { connect() }

    override fun onCreate() {
        super.onCreate()
        worker = Executors.newSingleThreadExecutor()
        goForeground()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Must be called promptly after startForegroundService(), even if we stop right away.
        goForeground()
        val settings = Settings.get(this)
        if (!settings.isPaired || !settings.persistentConnection) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (source == null) {
            main.removeCallbacks(reconnect)
            connect()
        }
        return START_STICKY
    }

    private fun goForeground() {
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, Notifier.SERVICE_NOTIFICATION_ID, Notifier.serviceNotification(this), type)
    }

    private fun connect() {
        if (stopped || source != null) return
        val settings = Settings.get(this)
        val pairing = settings.pairing()
        if (pairing == null || !settings.persistentConnection) {
            stopSelf()
            return
        }
        val api = Session.api(this) ?: run { stopSelf(); return }
        val client = Http.streamClient(pairing.certSha256)
        source = EventSources.createFactory(client).newEventSource(api.eventsRequest(), listener)
    }

    private val listener = object : EventSourceListener() {
        override fun onOpen(eventSource: EventSource, response: Response) {
            main.post { if (eventSource === source) backoff.reset() }
            // Catch up on anything missed while disconnected.
            submitSync()
        }

        override fun onEvent(eventSource: EventSource, id: String?, type: String?, data: String) {
            when (type) {
                "notification" -> submitSync()
                "unread" -> {
                    val count = try {
                        Json.optLongOrNull(JSONObject(data), "unread")
                    } catch (e: Exception) {
                        null
                    }
                    if (count != null) {
                        Settings.get(this@AlertStreamService).unread = count.toInt().coerceAtLeast(0)
                        AlertsBus.changed()
                    }
                }
            }
        }

        override fun onClosed(eventSource: EventSource) {
            main.post { onDisconnected(eventSource) }
        }

        override fun onFailure(eventSource: EventSource, t: Throwable?, response: Response?) {
            if (response?.code == 401) {
                main.post {
                    if (!stopped) worker.execute { Session.revoked(applicationContext) }
                }
                return
            }
            main.post { onDisconnected(eventSource) }
        }
    }

    private fun onDisconnected(eventSource: EventSource) {
        if (eventSource !== source) return
        source = null
        if (stopped) return
        main.removeCallbacks(reconnect)
        main.postDelayed(reconnect, backoff.withJitter(backoff.next(), Random.nextDouble()))
    }

    private fun submitSync() {
        main.post {
            if (!stopped) worker.execute { Sync.run(applicationContext) }
        }
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    // Network (or VPN) is back: skip the remaining backoff.
                    if (!stopped && source == null) {
                        main.removeCallbacks(reconnect)
                        backoff.reset()
                        connect()
                    }
                }
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: RuntimeException) {
            // Too many callbacks or a restricted profile; backoff alone still reconnects.
        }
    }

    override fun onDestroy() {
        stopped = true
        main.removeCallbacks(reconnect)
        source?.cancel()
        source = null
        networkCallback?.let {
            try {
                getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(it)
            } catch (e: RuntimeException) {
                // Already unregistered.
            }
        }
        worker.shutdown()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
