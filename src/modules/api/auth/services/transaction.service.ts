import {
    Injectable,
    Logger,
    HttpStatus,
    Inject,
} from "@nestjs/common";
import { User, OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { LiveCoinWatchService } from "@/modules/factory/trading/providers/livecoinwatch/services";
import { CoinCapService } from "@/modules/factory/trading/providers/coincap/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { EmailService } from "@/modules/core/email/services";
import { GeneralTransactionException } from "@/modules/api/trade/errors";
import { v4 as uuidv4 } from "uuid";
import { COMPANY_NAME, mailConfig, emailTemplateConfig } from "@/config";
import { SupportedAssets } from "@/modules/api/trade/interfaces/trade";
import { TierService, TierInfo } from "./tier.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";

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
    ) { }

    /** Sum order amounts in USD, optionally filtering by a cutoff date. */
    private sumOrdersInUsd(
        orders: Array<{ amount: number | null; currency: string | null; createdAt: Date }>,
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
        path: string
    ): Promise<void> {
        this.logger.log(`validateTransaction called with user: ${user.id}, currency: ${currency}, amount: ${amount}, path: ${path}`);

        // Check flagged status
        const flagged = await this.prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            const transactionId = uuidv4();
            await this.recordFailedTransaction(user, amount, currency, flagged.reason, path, transactionId);
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }

        await this.validateTransactionLimits(user, amount, currency, orderCategory, path);
    }

    async validateTransactionLimits(
        user: User,
        amount: number,
        currency: string,
        orderCategory: OrderCategory,
        path: string
    ): Promise<void> {
        this.logger.log(`validateTransactionLimits called with currency: ${currency}, amount: ${amount}, path: ${path}`);

        // Validate currency
        const allowedCurrencies = Object.values(SupportedAssets) as string[];
        if (!currency || typeof currency !== 'string' || !allowedCurrencies.some(ac => ac.toLowerCase() === currency.toLowerCase())) {
            const transactionId = uuidv4();
            const reason = `Invalid currency: ${currency || 'null'}. Must be one of ${allowedCurrencies.join(', ')}.`;
            await this.recordFailedTransaction(user, amount, currency || 'UNKNOWN', reason, path, transactionId);
            throw new GeneralTransactionException(
                reason,
                HttpStatus.BAD_REQUEST
            );
        }

        // Normalize currency to lowercase for USD conversion
        const normalizedCurrency = currency.toLowerCase() as SupportedAssets;

        const amountInUSD = await this.getAmountInUSD(normalizedCurrency, amount);
        if (!amountInUSD || !amountInUSD.amount) {
            const transactionId = uuidv4();
            const reason = `Failed to convert ${amount} ${currency} to USD. Please try again later.`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            throw new GeneralTransactionException(
                reason,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        // Use DB-stored tier as single source of truth
        const userTier = (user as any).tier ?? 0;
        const tierInfo: TierInfo = {
            tier: userTier,
            withdrawalLimit: this.tierService.getWithdrawalLimit(userTier),
            canTransact: userTier > 0,
        };

        // Tier 0 users cannot transact at all
        if (!tierInfo.canTransact) {
            const transactionId = uuidv4();
            const reason = `Transaction blocked: Complete KYC verification to unlock transactions. Current tier: ${tierInfo.tier}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            throw new GeneralTransactionException(
                "Complete KYC verification to unlock transactions. Visit your profile to verify your identity.",
                HttpStatus.FORBIDDEN
            );
        }

        // Get tier-based daily limit (unlimited = -1 or "unlimited")
        const tierWithdrawalLimit = tierInfo.withdrawalLimit;
        const hasUnlimitedWithdrawal = tierWithdrawalLimit === "unlimited";
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;

        // ==================== ATOMIC REDIS LIMIT CHECK ====================
        // Use Redis for atomic rate limiting to prevent race conditions
        // If Redis unavailable, fall back to DB-based check (less atomic but functional)

        const now = new Date();
        const dailyKey = `limits:user:${user.id}:daily:${now.toISOString().slice(0, 10)}`; // YYYY-MM-DD
        const monthlyKey = `limits:user:${user.id}:monthly:${now.toISOString().slice(0, 7)}`; // YYYY-MM
        const amountUSD = amountInUSD.amount;

        let usedRedis = false;

        // Try atomic Redis increment for daily limit
        if (!hasUnlimitedWithdrawal) {
            const dailyLimit = tierWithdrawalLimit as number;
            const consumed = await this.checkRedisDailyLimit(user, amount, currency, amountUSD, dailyKey, dailyLimit, tierInfo, path);
            if (consumed) usedRedis = true;
        }

        // Try atomic Redis increment for monthly limit
        const monthlyConsumed = await this.checkRedisMonthlyLimit(
            user, amount, currency, amountUSD, monthlyKey, monthlyLimit,
            hasUnlimitedWithdrawal ? null : dailyKey, path
        );
        if (monthlyConsumed) usedRedis = true;

        // ==================== DB FALLBACK (if Redis unavailable) ====================
        if (!usedRedis) {
            this.logger.warn(`Redis unavailable for user ${user.id} - using DB fallback for limit check`);
            await this.validateLimitsWithDbFallback(user, amount, currency, amountUSD, tierInfo, hasUnlimitedWithdrawal, monthlyLimit, path);
        }
    }

    /** Atomic Redis daily limit check. Returns true if Redis responded (regardless of pass/fail). */
    private async checkRedisDailyLimit(
        user: User, amount: number, currency: string, amountUSD: number,
        dailyKey: string, dailyLimit: number, tierInfo: TierInfo, path: string,
    ): Promise<boolean> {
        const newDailyTotal = await this.redisCacheService.incrbyfloat(dailyKey, amountUSD, 86400);
        if (newDailyTotal === null) return false;

        if (newDailyTotal > dailyLimit) {
            await this.redisCacheService.decrbyfloat(dailyKey, amountUSD);
            const transactionId = uuidv4();
            const reason = `Daily withdrawal limit exceeded for Tier ${tierInfo.tier}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal.toFixed(2)} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            await this.sendFlaggedEmail(user, reason, transactionId);
            throw new GeneralTransactionException(
                `Daily withdrawal limit of $${dailyLimit.toLocaleString()} exceeded. Upgrade your verification tier to increase limits.`,
                HttpStatus.FORBIDDEN
            );
        }
        this.logger.debug(`Redis daily limit check passed: ${newDailyTotal.toFixed(2)}/${dailyLimit}`);
        return true;
    }

    /** Atomic Redis monthly limit check. Returns true if Redis responded. */
    private async checkRedisMonthlyLimit(
        user: User, amount: number, currency: string, amountUSD: number,
        monthlyKey: string, monthlyLimit: number, dailyKey: string | null, path: string,
    ): Promise<boolean> {
        const newMonthlyTotal = await this.redisCacheService.incrbyfloat(monthlyKey, amountUSD, 2678400);
        if (newMonthlyTotal === null) return false;

        if (newMonthlyTotal > monthlyLimit) {
            await this.redisCacheService.decrbyfloat(monthlyKey, amountUSD);
            if (dailyKey) {
                await this.redisCacheService.decrbyfloat(dailyKey, amountUSD);
            }
            const transactionId = uuidv4();
            const reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal.toFixed(2)} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            await this.flagUserForLimitViolation(user, reason);
            await this.sendFlaggedEmail(user, reason, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }
        this.logger.debug(`Redis monthly limit check passed: ${newMonthlyTotal.toFixed(2)}/${monthlyLimit}`);
        return true;
    }

    /**
     * Fallback limit validation using database queries.
     * Used when Redis is unavailable.
     * Wraps in a Prisma transaction with SELECT FOR UPDATE to serialize
     * concurrent limit checks for the same user, preventing race conditions.
     */
    private async validateLimitsWithDbFallback(
        user: User,
        amount: number,
        currency: string,
        amountUSD: number,
        tierInfo: TierInfo,
        hasUnlimitedWithdrawal: boolean,
        monthlyLimit: number,
        path: string
    ): Promise<void> {
        await this.prisma.$transaction(async (tx) => {
            // Acquire row-level lock on user to serialize concurrent limit checks
            await tx.$queryRaw`SELECT id FROM "Users" WHERE id = ${user.id} FOR UPDATE`;

            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

            // Fetch all relevant orders
            const orders = await tx.order.findMany({
                where: {
                    userId: user.id,
                    createdAt: { gte: thirtyDaysAgo },
                    status: { in: [OrderStatus.filled, OrderStatus.completed, OrderStatus.done] },
                },
                select: { amount: true, currency: true, createdAt: true },
            });

            const rateCache = await this.buildRateCache(tx, orders);

            // Check daily limit
            if (!hasUnlimitedWithdrawal) {
                const dailyLimit = tierInfo.withdrawalLimit as number;
                const newDailyTotal = this.sumOrdersInUsd(orders, oneDayAgo, rateCache) + amountUSD;
                if (newDailyTotal > dailyLimit) {
                    const transactionId = uuidv4();
                    const reason = `Daily withdrawal limit exceeded for Tier ${tierInfo.tier}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal.toFixed(2)}`;
                    await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
                    await this.sendFlaggedEmail(user, reason, transactionId);
                    throw new GeneralTransactionException(
                        `Daily withdrawal limit of $${dailyLimit.toLocaleString()} exceeded. Upgrade your verification tier to increase limits.`,
                        HttpStatus.FORBIDDEN
                    );
                }
            }

            // Check monthly limit
            const newMonthlyTotal = this.sumOrdersInUsd(orders, null, rateCache) + amountUSD;
            if (newMonthlyTotal > monthlyLimit) {
                const transactionId = uuidv4();
                const reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal.toFixed(2)}`;
                await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
                await this.flagUserForLimitViolation(user, reason);
                await this.sendFlaggedEmail(user, reason, transactionId);
                throw new GeneralTransactionException(
                    `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                    HttpStatus.FORBIDDEN
                );
            }
        }, { timeout: 10000 });
    }

    /** Build a currency→USD-rate cache for a set of orders within a transaction. */
    private async buildRateCache(
        tx: any,
        orders: Array<{ currency: string | null }>,
    ): Promise<Record<string, number>> {
        const usdtRate = await tx.cryptoRate.findUnique({ where: { currency: 'USDT' } });
        const ngnToUsd = usdtRate && usdtRate.sellRate > 0 ? 1 / usdtRate.sellRate : 0;

        const uniqueCurrencies = [...new Set(orders.map(o => o.currency))];
        const rateCache: Record<string, number> = {};

        for (const curr of uniqueCurrencies) {
            if (!curr) continue;
            const cryptoRate = await tx.cryptoRate.findUnique({
                where: { currency: curr.toUpperCase() },
            });
            rateCache[curr] = cryptoRate && cryptoRate.sellRate > 0 && ngnToUsd > 0
                ? cryptoRate.sellRate * ngnToUsd
                : 0;
        }

        return rateCache;
    }

    /**
     * Flag user for limit violation.
     */
    private async flagUserForLimitViolation(user: User, reason: string): Promise<void> {
        const flaggedRecord = await this.prisma.flagged.upsert({
            where: { userId: user.id },
            create: {
                userId: user.id,
                flagged: true,
                reason,
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            update: {
                flagged: true,
                reason,
                updatedAt: new Date(),
            },
        });

        await this.prisma.user.update({
            where: { id: user.id },
            data: { flaggedId: flaggedRecord.id },
        });
    }

    private async getAmountInUSD(asset: string, amount: number): Promise<{ amount?: number; rate?: number } | null> {
        if (!asset || typeof asset !== 'string') {
            this.logger.error(`Invalid asset provided to getAmountInUSD: ${asset}`);
            return null;
        }

        const normalizedAsset = asset.toUpperCase();

        // Primary: Use in-house CryptoRate table (rates are in NGN)
        try {
            const [cryptoRate, usdtRate] = await Promise.all([
                this.prisma.cryptoRate.findUnique({ where: { currency: normalizedAsset } }),
                this.prisma.cryptoRate.findUnique({ where: { currency: 'USDT' } }),
            ]);

            if (cryptoRate && cryptoRate.sellRate > 0 && usdtRate && usdtRate.sellRate > 0) {
                // Convert crypto to NGN, then NGN to USD using USDT rate (USDT ≈ $1)
                const amountInNGN = amount * cryptoRate.sellRate;
                const usdRate = cryptoRate.sellRate / usdtRate.sellRate;
                const amountInUSD = amountInNGN / usdtRate.sellRate;

                this.logger.log(`In-house rate for ${asset}: ${cryptoRate.sellRate} NGN, USD equivalent: $${usdRate.toFixed(2)}`);
                return {
                    amount: amountInUSD,
                    rate: usdRate,
                };
            }
        } catch (error) {
            this.logger.warn(`In-house rate lookup failed for ${asset}: ${error.message}, falling back to external APIs`);
        }

        // Fallback: Try LiveCoinWatch
        try {
            const rate = await this.liveCoinWatchService.getPriceInUSD(normalizedAsset.toLowerCase());
            if (rate) {
                this.logger.log(`LiveCoinWatch price for ${asset}: $${rate}`);
                return {
                    amount: amount * rate,
                    rate,
                };
            }
        } catch (error) {
            this.logger.warn(`LiveCoinWatch failed for ${asset}: ${error.message}, falling back to CoinCap`);
        }

        // Backup: Fall back to CoinCap
        try {
            const rate = await this.coinCapService.getPriceInUSD(normalizedAsset.toLowerCase());
            if (rate) {
                this.logger.log(`CoinCap fallback price for ${asset}: $${rate}`);
                return {
                    amount: amount * rate,
                    rate,
                };
            }
        } catch (error) {
            this.logger.error(`CoinCap fallback also failed for ${asset}: ${error.message}`);
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
        tx: any = this.prisma
    ): Promise<void> {
        let orderCategory: OrderCategory;
        if (path.includes("buy/order") || path.includes("buy/quote")) {
            orderCategory = OrderCategory.BUY;
        } else if (path.includes("sell/order") || path.includes("sell/quote")) {
            orderCategory = OrderCategory.SELL;
        } else if (path.includes("request-instant-swap-quote") || path.includes("refresh-instant-swap-quote")) {
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
                currency: currency || 'UNKNOWN',
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

    private async sendFlaggedEmail(user: User, reason: string, transactionId: string): Promise<void> {
        const team = COMPANY_NAME;

        await this.emailService.sendMailWithTemplate({
            from: { address: mailConfig.senderMail },
            to: [{ email_address: { address: user.email } }],
            template_key: emailTemplateConfig.transaction_failed,
            merge_info: {
                name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User",
                transactionId,
                team,
                reason
            },
        });
    }
}
