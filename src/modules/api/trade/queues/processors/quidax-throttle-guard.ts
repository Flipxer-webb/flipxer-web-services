import { Logger } from "@nestjs/common";
import { Queue } from "bull";
import { isQuidaxThrottleError } from "@/libs/quidax";

type QueueThrottleState = {
    consecutiveThrottleCount: number;
    pausedUntil: number;
    resumeTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Default cooldown applied to a Bull queue when Quidax responds with a
 * throttling status. 30s gives the provider headroom while the queue's
 * exponential backoff handles per-job retries.
 */
const DEFAULT_THROTTLE_PAUSE_MS = 30_000;
const MAX_THROTTLE_PAUSE_MS = 5 * 60_000;
const queueThrottleStates = new Map<string, QueueThrottleState>();

/**
 * Returns true when the given error originated from a Quidax throttling
 * response (HTTP 429/444). Matches both the raw QuidaxLib errors and the
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
    pauseMs: number = DEFAULT_THROTTLE_PAUSE_MS,
): Promise<T> {
    try {
        const result = await handler();
        resetQueueThrottleState(queue.name);
        return result;
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
    pauseMs: number,
): Promise<void> {
    const state = getQueueThrottleState(queue.name);
    state.consecutiveThrottleCount += 1;
    const throttlePauseMs = getThrottlePauseMs(
        state.consecutiveThrottleCount,
        pauseMs,
    );
    const desiredResumeAt = Date.now() + throttlePauseMs;

    try {
        const alreadyPaused = await queue.isPaused();
        state.pausedUntil = Math.max(state.pausedUntil, desiredResumeAt);

        if (alreadyPaused) {
            logger.warn(
                `[QUIDAX THROTTLE] Extending queue "${queue.name}" cooldown to ${Math.max(0, state.pausedUntil - Date.now())}ms after ${state.consecutiveThrottleCount} consecutive Quidax throttling response(s)`,
            );
            scheduleQueueResume(queue, logger, state);
            return;
        }

        await queue.pause(/* isLocal */ true);
        logger.warn(
            `[QUIDAX THROTTLE] Pausing queue "${queue.name}" for ${throttlePauseMs}ms after ${state.consecutiveThrottleCount} consecutive Quidax throttling response(s)`,
        );

        scheduleQueueResume(queue, logger, state);
    } catch (pauseError) {
        // Pausing is best-effort — never let a guard failure mask the
        // original Quidax error.
        logger.error(
            `[QUIDAX THROTTLE] Failed to pause queue "${queue.name}": ${pauseError?.message}`,
        );
    }
}

function getQueueThrottleState(queueName: string): QueueThrottleState {
    let state = queueThrottleStates.get(queueName);

    if (!state) {
        state = {
            consecutiveThrottleCount: 0,
            pausedUntil: 0,
            resumeTimer: null,
        };
        queueThrottleStates.set(queueName, state);
    }

    return state;
}

function resetQueueThrottleState(queueName: string): void {
    const state = queueThrottleStates.get(queueName);

    if (!state) {
        return;
    }

    state.consecutiveThrottleCount = 0;
    state.pausedUntil = 0;

    if (state.resumeTimer) {
        clearTimeout(state.resumeTimer);
        state.resumeTimer = null;
    }
}

function getThrottlePauseMs(
    consecutiveThrottleCount: number,
    basePauseMs: number,
): number {
    const backoffMultiplier = Math.max(0, consecutiveThrottleCount - 1);

    return Math.min(
        basePauseMs * 2 ** backoffMultiplier,
        MAX_THROTTLE_PAUSE_MS,
    );
}

function scheduleQueueResume(
    queue: Queue,
    logger: Logger,
    state: QueueThrottleState,
): void {
    if (state.resumeTimer) {
        clearTimeout(state.resumeTimer);
    }

    const delayMs = Math.max(0, state.pausedUntil - Date.now());
    state.resumeTimer = setTimeout(async () => {
        const remainingPauseMs = state.pausedUntil - Date.now();

        if (remainingPauseMs > 0) {
            scheduleQueueResume(queue, logger, state);
            return;
        }

        try {
            await queue.resume(/* isLocal */ true);
            logger.log(
                `[QUIDAX THROTTLE] Resumed queue "${queue.name}" after cooldown`,
            );
        } catch (resumeError) {
            logger.error(
                `[QUIDAX THROTTLE] Failed to resume queue "${queue.name}": ${resumeError?.message}`,
            );
        } finally {
            state.pausedUntil = 0;
            state.resumeTimer = null;
        }
    }, delayMs);
    state.resumeTimer.unref?.();
}
