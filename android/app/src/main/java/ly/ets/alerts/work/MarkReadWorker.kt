package ly.ets.alerts.work

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import ly.ets.alerts.sync.Sync
import java.util.concurrent.TimeUnit

/** Delivers `POST /api/m/notifications/{id}/read`, retrying while the server is unreachable. */
class MarkReadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val id = inputData.getLong(KEY_ID, -1L)
        if (id <= 0) return Result.success()
        return when {
            Sync.markRead(applicationContext, id) -> Result.success()
            runAttemptCount < 10 -> Result.retry()
            else -> Result.success()
        }
    }

    companion object {
        private const val KEY_ID = "alert_id"

        fun enqueue(context: Context, id: Long) {
            val req = OneTimeWorkRequestBuilder<MarkReadWorker>()
                .setInputData(workDataOf(KEY_ID to id))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork("ets-read-$id", ExistingWorkPolicy.KEEP, req)
        }
    }
}
