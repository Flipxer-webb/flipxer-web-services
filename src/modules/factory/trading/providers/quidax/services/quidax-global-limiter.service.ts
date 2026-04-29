import { Injectable, Logger } from "@nestjs/common";
import { QuidaxTooManyRequestError, type QuidaxRequestBudget, type QuidaxRequestBudgetBucket } from "@/libs/quidax";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { RateLimiterService } from "@/modules/core/rate-limit/services/rate-limiter.service";

type QuidaxCooldownState = {
    consecutiveThrottleCount: number;
    cooldownUntil: number;
};

const MAIN_BUCKET_LIMIT = 240;
const MAIN_BUCKET_WINDOW_SECONDS = 60;
const WALLET_ADDRESS_BUCKET_LIMIT = 15;
const WALLET_ADDRESS_BUCKET_WINDOW_SECONDS = 1;
const BASE_COOLDOWN_SECONDS = 120;
const MAX_COOLDOWN_SECONDS = 300;

@Injectable()
export class QuidaxGlobalLimiterService implements QuidaxRequestBudget {
    private readonly logger = new Logger(QuidaxGlobalLimiterService.name);

    constructor(
        private readonly rateLimiterService: RateLimiterService,
        private readonly redisCacheService: RedisCacheService,
    ) {}

    async assertAllowed(bucket: QuidaxRequestBudgetBucket): Promise<void> {
        const activeCooldown = await this.getActiveCooldown(bucket);

        if (activeCooldown) {
            throw this.buildRateLimitError(activeCooldown.retryAfterSeconds, "provider cooldown active");
        }

        const budgetConfig = this.getBucketConfig(bucket);
        const result = await this.rateLimiterService.checkLimit("shared", {
            limit: budgetConfig.limit,
            windowSeconds: budgetConfig.windowSeconds,
            keyPrefix: `quidax:budget:${bucket}:`,
        });

        if (result.allowed) {
            return;
        }

        const retryAfterSeconds = Math.max(
            1,
            Math.ceil(
                result.retryAfter ??
                    Math.max(0, (result.resetTime - Date.now()) / 1000),
            ),
        );

        await this.setCooldown(bucket, {
            consecutiveThrottleCount: 0,
            cooldownUntil: Date.now() + retryAfterSeconds * 1000,
        }, retryAfterSeconds);

        this.logger.warn(
            `[QUIDAX LIMITER] Blocking ${bucket} requests for ${retryAfterSeconds}s after shared budget exhaustion`
        );

        throw this.buildRateLimitError(retryAfterSeconds, "shared budget exhausted");
    }

    async noteThrottle(bucket: QuidaxRequestBudgetBucket): Promise<void> {
        const now = Date.now();
        const existingCooldown = await this.redisCacheService.get<QuidaxCooldownState>(this.getCooldownKey(bucket));
        const nextCount = (existingCooldown?.consecutiveThrottleCount ?? 0) + 1;
        const computedCooldownSeconds = Math.min(
            BASE_COOLDOWN_SECONDS * 2 ** Math.max(0, nextCount - 1),
            MAX_COOLDOWN_SECONDS,
        );
        const existingRemainingSeconds = existingCooldown?.cooldownUntil
            ? Math.max(0, Math.ceil((existingCooldown.cooldownUntil - now) / 1000))
            : 0;
        const cooldownSeconds = Math.max(computedCooldownSeconds, existingRemainingSeconds);

        await this.setCooldown(bucket, {
            consecutiveThrottleCount: nextCount,
            cooldownUntil: now + cooldownSeconds * 1000,
        }, cooldownSeconds);

        this.logger.warn(
            `[QUIDAX LIMITER] Applied ${cooldownSeconds}s cooldown for ${bucket} after throttle/block event #${nextCount}`
        );
    }

    private getBucketConfig(bucket: QuidaxRequestBudgetBucket): { limit: number; windowSeconds: number } {
        if (bucket === "wallet-address") {
            return {
                limit: WALLET_ADDRESS_BUCKET_LIMIT,
                windowSeconds: WALLET_ADDRESS_BUCKET_WINDOW_SECONDS,
            };
        }

        return {
            limit: MAIN_BUCKET_LIMIT,
            windowSeconds: MAIN_BUCKET_WINDOW_SECONDS,
        };
    }

    private async getActiveCooldown(bucket: QuidaxRequestBudgetBucket): Promise<{ retryAfterSeconds: number } | null> {
        const cooldown = await this.redisCacheService.get<QuidaxCooldownState>(this.getCooldownKey(bucket));

        if (!cooldown?.cooldownUntil) {
            return null;
        }

        const retryAfterSeconds = Math.max(0, Math.ceil((cooldown.cooldownUntil - Date.now()) / 1000));

        if (retryAfterSeconds <= 0) {
            return null;
        }

        return { retryAfterSeconds };
    }

    private async setCooldown(
        bucket: QuidaxRequestBudgetBucket,
        state: QuidaxCooldownState,
        ttlSeconds: number,
    ): Promise<void> {
        await this.redisCacheService.set(
            this.getCooldownKey(bucket),
            state,
            Math.max(1, ttlSeconds),
        );
    }

    private getCooldownKey(bucket: QuidaxRequestBudgetBucket): string {
        return `quidax:cooldown:${bucket}`;
    }

    private buildRateLimitError(retryAfterSeconds: number, reason: string): QuidaxTooManyRequestError {
        return new QuidaxTooManyRequestError(
            `Quidax requests are temporarily throttled (${reason}). Retry in ${retryAfterSeconds} seconds.`,
        );
    }
}