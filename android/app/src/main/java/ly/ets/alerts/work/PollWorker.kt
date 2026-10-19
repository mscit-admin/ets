package ly.ets.alerts.work

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import ly.ets.alerts.sync.Sync

/**
 * Fallback delivery: runs every 15 minutes (WorkManager minimum) whether or not the
 * foreground service is alive, so alerts still arrive if the system kills the service
 * or «اتصال دائم» is off.
 */
class PollWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = when (Sync.run(applicationContext)) {
        is Sync.Result.Ok, Sync.Result.NotPaired, Sync.Result.Revoked -> Result.success()
        // The next periodic run retries anyway; a short retry helps one-off syncs over a flaky VPN.
        is Sync.Result.Failed -> if (runAttemptCount < 3) Result.retry() else Result.success()
    }
}
