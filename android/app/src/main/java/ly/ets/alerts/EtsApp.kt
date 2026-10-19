package ly.ets.alerts

import android.app.Application
import ly.ets.alerts.notify.Notifier

class EtsApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
    }
}
