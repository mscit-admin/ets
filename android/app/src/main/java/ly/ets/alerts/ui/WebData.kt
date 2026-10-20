package ly.ets.alerts.ui

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView

/** The in-app browser's data: the ETS session cookie, web storage and cache. Wiped when the phone is unpaired. */
object WebData {
    fun clear(context: Context) {
        val app = context.applicationContext
        val wipe = Runnable {
            try {
                val cookies = CookieManager.getInstance()
                cookies.removeAllCookies(null)
                cookies.flush()
                WebStorage.getInstance().deleteAllData()
                WebView(app).apply {
                    clearCache(true)
                    clearHistory()
                    destroy()
                }
            } catch (e: Exception) {
                // No WebView provider (or it is being updated): there is nothing of ours to wipe in it.
            }
        }
        // WebView objects belong to the main thread; unpair() runs on a worker.
        if (Looper.myLooper() == Looper.getMainLooper()) wipe.run() else Handler(Looper.getMainLooper()).post(wipe)
    }
}
