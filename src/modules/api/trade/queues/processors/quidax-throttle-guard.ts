import { Logger } from "@nestjs/common";
import { Queue } from "bull";
import { isQuidaxThrottleError } from "@/libs/quidax";

/**
 * Default cooldown applied to a Bull queue when Quidax responds with a
 * throttling status (HTTP 429 or 444). 30s gives the provider headroom while
 * the queue's exponential backoff handles per-job retries.
 */
const DEFAULT_THROTTLE_PAUSE_MS = 30_000;

/**
 * Returns true when the given error originated from a Quidax throttling
 * response (HTTP 429 or 444). Matches both the raw QuidaxLib error and the
 * QuidaxException wrapper produced by the provider's error handler.
 */
export function isQuidaxThrottlingError(error: unknown): boolean {
    return isQuidaxThrottleError(error);
}

/**
 * Pause the queue for `pauseMs` whenever the underlying job handler throws a
 * Quidax throttling error. The error is re-thrown so Bull's retry/backoff
 * still applies to the individual job, but no other jobs in the queue make
 * additional Quidax calls during the cooldown window.
 *
 * Multiple concurrent throttle errors collapse into a single pause window —
 * the helper checks `queue.isPaused()` before scheduling another resume so we
 * never extend the cooldown unintentionally.
 */
export async function withQuidaxThrottleGuard<T>(
    queue: Queue,
    logger: Logger,
    handler: () => Promise<T>,
    pauseMs: number = DEFAULT_THROTTLE_PAUSE_MS
): Promise<T> {
    try {
        return await handler();
    } catch (error) {
        if (isQuidaxThrottlingError(error)) {
            await pauseQueueForCooldown(queue, logger, pauseMs);
        }
        throw error;
    }
}

async function pauseQueueForCooldown(
    queue: Queue,
    logger: Logger,
    pauseMs: number
): Promise<void> {
    try {
        const alreadyPaused = await queue.isPaused();
        if (alreadyPaused) {
            return;
        }

        await queue.pause(/* isLocal */ true);
        logger.warn(
            `[QUIDAX THROTTLE] Pausing queue "${queue.name}" for ${pauseMs}ms after Quidax throttling response`
        );

        setTimeout(async () => {
            try {
                await queue.resume(/* isLocal */ true);
                logger.log(
                    `[QUIDAX THROTTLE] Resumed queue "${queue.name}" after cooldown`
                );
            } catch (resumeError) {
                logger.error(
                    `[QUIDAX THROTTLE] Failed to resume queue "${queue.name}": ${resumeError?.message}`
                );
            }
        }, pauseMs).unref?.();
    } catch (pauseError) {
        // Pausing is best-effort — never let a guard failure mask the
        // original Quidax error.
        logger.error(
            `[QUIDAX THROTTLE] Failed to pause queue "${queue.name}": ${pauseError?.message}`
        );
    }
}
