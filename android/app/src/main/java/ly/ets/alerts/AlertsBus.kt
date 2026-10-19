package ly.ets.alerts

import android.os.Handler
import android.os.Looper
import java.util.concurrent.CopyOnWriteArraySet

/** In-process "data changed" signal so open screens refresh after a sync or revocation. */
object AlertsBus {
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<() -> Unit>()

    fun register(listener: () -> Unit) {
        listeners += listener
    }

    fun unregister(listener: () -> Unit) {
        listeners -= listener
    }

    /** Callable from any thread; listeners run on the main thread. */
    fun changed() {
        main.post { listeners.forEach { it() } }
    }
}
