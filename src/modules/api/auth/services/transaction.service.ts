import { Injectable, Logger, HttpStatus, Inject } from "@nestjs/common";
import {
    User,
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
} from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { CoinCapService } from "@/modules/factory/trading/providers/coincap/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { EmailService } from "@/modules/core/email/services";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import { randomUUID } from "node:crypto";
import { COMPANY_NAME, mailConfig, emailTemplateConfig } from "@/config";
import { SupportedAssets } from "@/modules/api/trade/interfaces/trade";
import { TierService, TierInfo } from "./tier.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import {
    TIER_DAILY_LIMITS,
    BUSINESS_DAILY_LIMITS,
    getOperationKey,
    TierLevel,
    OperationLimits,
} from "@/modules/shared/tier-limits";

interface RedisLimitCheckOptions {
    user: User;
    amount: number;
    currency: string;
    amountUSD: number;
    key: string;
    limit: number;
    tierInfo: TierInfo;
    path: string;
    operationLabel: string;
}

@Injectable()
export class TransactionService {
    private readonly logger = new Logger(TransactionService.name);

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.LIVECOINWATCH)
        private readonly liveCoinWatchService: LiveCoinWatchService,
        @Inject(TradingInjectionToken.COINCAP)
        private readonly coinCapService: CoinCapService,
        private readonly emailService: EmailService,
        private readonly tierService: TierService,
        private readonly redisCacheService: RedisCacheService,
    ) {}

    /** Sum order amounts in USD, optionally filtering by a cutoff date. */
    private sumOrdersInUsd(
        orders: Array<{
            amount: number | null;
            currency: string | null;
            createdAt: Date;
        }>,
        since: Date | null,
        rateCache: Record<string, number>,
    ): number {
        let total = 0;
        for (const order of orders) {
            if (!order.amount || !order.currency) continue;
            if (since && order.createdAt < since) continue;
            total += order.amount * (rateCache[order.currency] || 0);
        }
        return total;
    }

    async validateTransaction(
        user: User,
        amount: number,
        currency: string,
        orderCategory: OrderCategory,
        path: string,
    ): Promise<void> {
        this.logger.log(
            `validateTransaction called with user: ${user.id}, currency: ${currency}, amount: ${amount}, path: ${path}`,
        );

        // Check flagged status
        const flagged = await this.prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            const transactionId = randomUUID();
            await this.recordFailedTransaction(
                user,
                amount,
                currency,
                flagged.reason,
                path,
                transactionId,
            );
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN,
            );
        }

        await this.validateTransactionLimits(
            user,
            amount,
            currency,
            orderCategory,
            path,
        );
    }

    async validateTransactionLimits(
        user: User,
        amount: number,
        currency: string,
        orderCategory: OrderCategory,
        path: string,
    ): Promise<void> {
        this.logger.log(
            `validateTransactionLimits called with currency: ${currency}, amount: ${amount}, category: ${orderCategory}, path: ${path}`,
        );

        // Validate currency
        const allowedCurrencies = Object.values(SupportedAssets);
        if (
            !currency ||
            typeof currency !== "string" ||
            !allowedCurrencies.some(
                (ac) => ac.toLowerCase() === currency.toLowerCase(),
            )
        ) {
            const transactionId = randomUUID();
            const reason = `Invalid currency: ${currency || "null"}. Must be one of ${allowedCurrencies.join(", ")}.`;
            await this.recordFailedTransaction(
                user,
                amount,
                currency || "UNKNOWN",
                reason,
                path,
                transactionId,
            );
            throw new GeneralTransactionException(
                reason,
                HttpStatus.BAD_REQUEST,
            );
        }

        // Normalize currency to lowercase for USD conversion
        const normalizedCurrency = currency.toLowerCase() as SupportedAssets;

        const amountInUSD = await this.getAmountInUSD(
            normalizedCurrency,
            amount,
        );
        if (!amountInUSD?.amount) {
            const transactionId = randomUUID();
            const reason = `Failed to convert ${amount} ${currency} to USD. Please try again later.`;
            await this.recordFailedTransaction(
                user,
                amount,
                currency,
                reason,
                path,
                transactionId,
            );
            throw new GeneralTransactionException(
                reason,
                HttpStatus.INTERNAL_SERVER_ERROR,
            );
        }

        // Use DB-stored tier as single source of truth
        const userTier = (user as any).tier ?? 0;
        const isBusiness = user.userType === "BUSINESS";

        // Resolve per-operation limit
        const opKey = getOperationKey(orderCategory);
        const operationLabel = opKey.charAt(0).toUpperCase() + opKey.slice(1); // "Buy", "Sell", etc.
        const businessTier = Math.min(userTier, 1) as 0 | 1;
        const tierLimits: OperationLimits = isBusiness
            ? BUSINESS_DAILY_LIMITS[businessTier]
            : TIER_DAILY_LIMITS[userTier as TierLevel];
        const operationLimit = tierLimits[opKey];

        const tierInfo: TierInfo = {
            tier: userTier,
            withdrawalLimit: operationLimit,
            dailyLimits: tierLimits,
            canTransact: userTier > 0,
        };

        // Tier 0 users cannot transact at all
        if (!tierInfo.canTransact) {
            const transactionId = randomUUID();
            const reason = `Transaction blocked: Complete KYC verification to unlock transactions. Current tier: ${tierInfo.tier}`;
            await this.recordFailedTransaction(
                user,
                amount,
                currency,
                reason,
                path,
                transactionId,
            );
            throw new GeneralTransactionException(
                "Complete KYC verification to unlock transactions. Visit your profile to verify your identity.",
                HttpStatus.FORBIDDEN,
            );
        }

        // Determine if this operation has unlimited limit
        let dailyLimit = operationLimit;
        let hasUnlimited = dailyLimit === "unlimited";

        // ==================== ADMIN LIMIT OVERRIDE ====================
        // Admin override replaces the per-operation limit for each op type.
        const override = await this.getActiveLimitOverride(user.id);
        if (override && override.dailyLimitUSD !== null) {
            this.logger.log(
                `Active limit override for user ${user.id}: daily=${override.dailyLimitUSD} per operation`,
            );
            dailyLimit = override.dailyLimitUSD;
            hasUnlimited = false;
        }

        // ==================== ATOMIC REDIS LIMIT CHECK ====================
        // Per-operation Redis keys enforce separate limits for buy/sell/swap/send
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const dailyKey = `limits:user:${user.id}:daily:${opKey}:${dateStr}`;
        const amountUSD = amountInUSD.amount;

        let usedRedis = false;

        if (!hasUnlimited) {
            const numericLimit = dailyLimit as number;
            const consumed = await this.checkRedisDailyLimit({
                user,
                amount,
                currency,
                amountUSD,
                key: dailyKey,
                limit: numericLimit,
                tierInfo,
                path,
                operationLabel,
            });
            if (consumed) usedRedis = true;
        }

        // ==================== DB FALLBACK (if Redis unavailable) ====================
        if (!usedRedis && !hasUnlimited) {
            this.logger.warn(
                `Redis unavailable for user ${user.id} - using DB fallback for limit check`,
            );
            await this.validateLimitsWithDbFallback({
                user,
                amount,
                currency,
                amountUSD,
                tierInfo,
                hasUnlimited,
                dailyLimit: dailyLimit as number,
                orderCategory,
                operationLabel,
                path,
            });
        }
    }

    /** Atomic Redis daily limit check per operation. Returns true if Redis responded. */
    private async checkRedisDailyLimit(
        opts: RedisLimitCheckOptions,
    ): Promise<boolean> {
        const {
            user,
            amount,
            currency,
            amountUSD,
            key: dailyKey,
            limit: dailyLimit,
            tierInfo,
            path,
            operationLabel,
        } = opts;
        const newDailyTotal = await this.redisCacheService.incrbyfloat(
            dailyKey,
            amountUSD,
            86400,
        );
        if (newDailyTotal === null) return false;

        if (newDailyTotal > dailyLimit) {
            await this.redisCacheService.decrbyfloat(dailyKey, amountUSD);
            const transactionId = randomUUID();
            const reason = `Daily ${operationLabel.toLowerCase()} limit exceeded for Tier ${tierInfo.tier}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal.toFixed(2)} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(
                user,
                amount,
                currency,
                reason,
                path,
                transactionId,
            );
            await this.sendFlaggedEmail(user, reason, transactionId);
            throw new GeneralTransactionException(
                `Daily ${operationLabel.toLowerCase()} limit of $${dailyLimit.toLocaleString()} exceeded. Upgrade your verification tier to increase limits.`,
                HttpStatus.FORBIDDEN,
            );
        }
        this.logger.debug(
            `Redis daily ${operationLabel.toLowerCase()} limit check passed: ${newDailyTotal.toFixed(2)}/${dailyLimit}`,
        );
        return true;
    }

    /**
     * Fallback limit validation using database queries (per-operation).
     * Used when Redis is unavailable.
     * Wraps in a Prisma transaction with SELECT FOR UPDATE to serialize
     * concurrent limit checks for the same user, preventing race conditions.
     */
    private async validateLimitsWithDbFallback(opts: {
        user: User;
        amount: number;
        currency: string;
        amountUSD: number;
        tierInfo: TierInfo;
        hasUnlimited: boolean;
        dailyLimit: number;
        orderCategory: OrderCategory;
        operationLabel: string;
        path: string;
    }): Promise<void> {
        const {
            user,
            amount,
            currency,
            amountUSD,
            tierInfo,
            hasUnlimited,
            dailyLimit,
            orderCategory,
            operationLabel,
            path,
        } = opts;
        if (hasUnlimited) return;

        await this.prisma.$transaction(
            async (tx) => {
                // Acquire row-level lock on user to serialize concurrent limit checks
                await tx.$queryRaw`SELECT id FROM "Users" WHERE id = ${user.id} FOR UPDATE`;

                const now = new Date();
                // Use calendar-day boundary (midnight UTC) to match Redis key behavior
                const startOfToday = new Date(
                    Date.UTC(
                        now.getUTCFullYear(),
                        now.getUTCMonth(),
                        now.getUTCDate(),
                    ),
                );

                // Fetch today's orders for this specific operation type
                const orders = await tx.order.findMany({
                    where: {
                        userId: user.id,
                        createdAt: { gte: startOfToday },
                        orderCategory,
                        status: {
                            in: [
                                OrderStatus.filled,
                                OrderStatus.completed,
                                OrderStatus.done,
                            ],
                        },
                    },
                    select: { amount: true, currency: true, createdAt: true },
                });

                const rateCache = await this.buildRateCache(tx, orders);

                const newDailyTotal =
                    this.sumOrdersInUsd(orders, null, rateCache) + amountUSD;
                if (newDailyTotal > dailyLimit) {
                    const transactionId = randomUUID();
                    const reason = `Daily ${operationLabel.toLowerCase()} limit exceeded for Tier ${tierInfo.tier}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal.toFixed(2)}`;
                    await this.recordFailedTransaction(
                        user,
                        amount,
                        currency,
                        reason,
                        path,
                        transactionId,
                    );
                    await this.sendFlaggedEmail(user, reason, transactionId);
                    throw new GeneralTransactionException(
                        `Daily ${operationLabel.toLowerCase()} limit of $${dailyLimit.toLocaleString()} exceeded. Upgrade your verification tier to increase limits.`,
                        HttpStatus.FORBIDDEN,
                    );
                }
            },
            { timeout: 10000 },
        );
    }

    /** Build a currency→USD-rate cache for a set of orders within a transaction. */
    private async buildRateCache(
        tx: any,
        orders: Array<{ currency: string | null }>,
    ): Promise<Record<string, number>> {
        const usdtRate = await tx.cryptoRate.findUnique({
            where: { currency: "USDT" },
        });
        const ngnToUsd =
            usdtRate && usdtRate.sellRate > 0 ? 1 / usdtRate.sellRate : 0;

        const uniqueCurrencies = [...new Set(orders.map((o) => o.currency))];
        const rateCache: Record<string, number> = {};

        for (const curr of uniqueCurrencies) {
            if (!curr) continue;
            const cryptoRate = await tx.cryptoRate.findUnique({
                where: { currency: curr.toUpperCase() },
            });
            rateCache[curr] =
                cryptoRate && cryptoRate.sellRate > 0 && ngnToUsd > 0
                    ? cryptoRate.sellRate * ngnToUsd
                    : 0;
        }

        return rateCache;
    }

    /**
     * Get active (non-expired) limit override for a user.
     * Returns null if no override exists, it has expired, or the table is unavailable.
     */
    private async getActiveLimitOverride(userId: number) {
        try {
            const override = await this.prisma.limitOverride.findUnique({
                where: { userId },
            });
            if (!override) return null;
            // Check expiration
            if (override.expiresAt && override.expiresAt < new Date()) {
                this.logger.debug(
                    `Limit override for user ${userId} has expired (${override.expiresAt.toISOString()})`,
                );
                return null;
            }
            return override;
        } catch (error: unknown) {
            const msg =
                error instanceof Error ? error.message : JSON.stringify(error);
            this.logger.warn(
                `Failed to fetch limit override for user ${userId}, proceeding with tier defaults: ${msg}`,
            );
            return null;
        }
    }

    private async getAmountInUSD(
        asset: string,
        amount: number,
    ): Promise<{ amount?: number; rate?: number } | null> {
        if (!asset || typeof asset !== "string") {
            this.logger.error(
                `Invalid asset provided to getAmountInUSD: ${asset}`,
            );
            return null;
        }

        const normalizedAsset = asset.toUpperCase();

        // Primary: Use in-house CryptoRate table (rates are in NGN)
        try {
            const [cryptoRate, usdtRate] = await Promise.all([
                this.prisma.cryptoRate.findUnique({
                    where: { currency: normalizedAsset },
                }),
                this.prisma.cryptoRate.findUnique({
                    where: { currency: "USDT" },
                }),
            ]);

            if (
                cryptoRate &&
                cryptoRate.sellRate > 0 &&
                usdtRate &&
                usdtRate.sellRate > 0
            ) {
                // Convert crypto to NGN, then NGN to USD using USDT rate (USDT ≈ $1)
                const amountInNGN = amount * cryptoRate.sellRate;
                const usdRate = cryptoRate.sellRate / usdtRate.sellRate;
                const amountInUSD = amountInNGN / usdtRate.sellRate;

                this.logger.log(
                    `In-house rate for ${asset}: ${cryptoRate.sellRate} NGN, USD equivalent: $${usdRate.toFixed(2)}`,
                );
                return {
                    amount: amountInUSD,
                    rate: usdRate,
                };
            }
        } catch (error) {
            this.logger.warn(
                `In-house rate lookup failed for ${asset}: ${error.message}, falling back to external APIs`,
            );
        }

        // Fallback: Try LiveCoinWatch
        try {
            const rate = await this.liveCoinWatchService.getPriceInUSD(
                normalizedAsset.toLowerCase(),
            );
            if (rate) {
                this.logger.log(`LiveCoinWatch price for ${asset}: $${rate}`);
                return {
                    amount: amount * rate,
                    rate,
                };
            }
        } catch (error) {
            this.logger.warn(
                `LiveCoinWatch failed for ${asset}: ${error.message}, falling back to CoinCap`,
            );
        }

        // Backup: Fall back to CoinCap
        try {
            const rate = await this.coinCapService.getPriceInUSD(
                normalizedAsset.toLowerCase(),
            );
            if (rate) {
                this.logger.log(
                    `CoinCap fallback price for ${asset}: $${rate}`,
                );
                return {
                    amount: amount * rate,
                    rate,
                };
            }
        } catch (error) {
            this.logger.error(
                `CoinCap fallback also failed for ${asset}: ${error.message}`,
            );
        }

        this.logger.error(`All price sources failed for ${asset}`);
        return null;
    }

    async recordFailedTransaction(
        user: User,
        amount: number,
        currency: string,
        reason: string,
        path: string,
        transactionId: string,
        tx: any = this.prisma,
    ): Promise<void> {
        let orderCategory: OrderCategory;
        if (path.includes("buy/order") || path.includes("buy/quote")) {
            orderCategory = OrderCategory.BUY;
        } else if (path.includes("sell/order") || path.includes("sell/quote")) {
            orderCategory = OrderCategory.SELL;
        } else if (
            path.includes("request-instant-swap-quote") ||
            path.includes("refresh-instant-swap-quote")
        ) {
            orderCategory = OrderCategory.SWAP;
        } else if (path.includes("withdrawer-request")) {
            orderCategory = OrderCategory.SEND;
        } else {
            throw new Error(`Invalid path for order category: ${path}`);
        }

        await tx.order.create({
            data: {
                userId: user.id,
                orderCategory,
                currency: currency || "UNKNOWN",
                amount,
                transactionId,
                status: OrderStatus.failed,
                streamlinedStatus: OrderStreamlinedStatus.failed,
                reason,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        });
    }

    async releaseDailyLimitReservationForOrder(order: {
        userId: number;
        orderCategory: OrderCategory;
        currency: string | null;
        amount: number | null;
        createdAt: Date | null;
    }): Promise<void> {
        if (!order.currency || !order.amount || !order.createdAt) {
            return;
        }

        const amountInUSD = await this.getAmountInUSD(
            order.currency,
            Number(order.amount),
        );
        if (!amountInUSD?.amount) {
            this.logger.warn(
                `Unable to release reserved ${order.orderCategory.toLowerCase()} limit for user ${order.userId}: USD conversion failed`,
            );
            return;
        }

        const opKey = getOperationKey(order.orderCategory);
        const dateStr = order.createdAt.toISOString().slice(0, 10);
        const dailyKey = `limits:user:${order.userId}:daily:${opKey}:${dateStr}`;
        const currentDailyTotal =
            await this.redisCacheService.getCounter(dailyKey);

        if (currentDailyTotal === null) {
            this.logger.warn(
                `Redis unavailable while reading reserved ${opKey} limit for user ${order.userId}`,
            );
            return;
        }

        if (currentDailyTotal <= 0) {
            return;
        }

        const decrement = Math.min(currentDailyTotal, amountInUSD.amount);
        const newDailyTotal = await this.redisCacheService.decrbyfloat(
            dailyKey,
            decrement,
        );

        if (newDailyTotal === null) {
            this.logger.warn(
                `Redis unavailable while releasing reserved ${opKey} limit for user ${order.userId}`,
            );
            return;
        }

        if (newDailyTotal < 0) {
            const endOfDay = new Date(order.createdAt);
            endOfDay.setUTCHours(23, 59, 59, 999);
            const ttlSeconds = Math.max(
                1,
                Math.ceil((endOfDay.getTime() - Date.now()) / 1000),
            );
            await this.redisCacheService.set(dailyKey, 0, ttlSeconds);
        }

        this.logger.debug(
            `Released reserved daily ${opKey} limit for user ${order.userId}: ${decrement.toFixed(2)} USD, new total ${Math.max(newDailyTotal, 0).toFixed(2)}`,
        );
    }

    private async sendFlaggedEmail(
        user: User,
        reason: string,
        transactionId: string,
    ): Promise<void> {
        const team = COMPANY_NAME;

        await this.emailService.sendMailWithTemplate({
            from: { address: mailConfig.senderMail },
            to: [{ email_address: { address: user.email } }],
            template_key: emailTemplateConfig.transaction_failed,
            merge_info: {
                name:
                    `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
                    "User",
                transactionId,
                team,
                reason,
            },
        });
    }
}
