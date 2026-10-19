package ly.ets.alerts.core

/** Reconnect delays for the event stream: 2 s doubling up to 5 min. */
class Backoff(
    private val initialMs: Long = 2_000L,
    private val maxMs: Long = 300_000L,
) {
    private var attempt = 0

    /** Delay before the next attempt; each call advances the sequence. */
    fun next(): Long {
        val shift = attempt.coerceAtMost(20)
        attempt++
        val delay = initialMs shl shift
        return if (delay <= 0 || delay > maxMs) maxMs else delay
    }

    fun reset() {
        attempt = 0
    }

    /** Adds up to +/-20% jitter so many phones do not reconnect in lockstep. */
    fun withJitter(delayMs: Long, random: Double): Long {
        val factor = 0.8 + 0.4 * random.coerceIn(0.0, 1.0)
        return (delayMs * factor).toLong().coerceIn(initialMs / 2, maxMs)
    }
}
