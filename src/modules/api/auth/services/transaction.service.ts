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
import { TierService } from "./tier.service";

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
        private readonly tierService: TierService
    ) { }

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

        // Get tier info for the user
        const tierInfo = this.tierService.getTierInfo(user);

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

        // Fall back to monthly limits for overall transaction control
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        let transactionId: string | undefined;
        let reason: string | undefined;

        // Fetch all relevant orders once
        const orders = await this.prisma.order.findMany({
            where: {
                userId: user.id,
                createdAt: { gte: thirtyDaysAgo },
                status: { in: [OrderStatus.filled, OrderStatus.completed, OrderStatus.done] },
            },
            select: { amount: true, currency: true, createdAt: true, rateAtConversion: true },
        });

        // Batch fetch USD rates for unique currencies using in-house rates
        const uniqueCurrencies = [...new Set(orders.map(order => order.currency).concat(normalizedCurrency))];
        const rateCache: { [key: string]: number } = {};

        // Get USDT rate for NGN to USD conversion
        const usdtRate = await this.prisma.cryptoRate.findUnique({ where: { currency: 'USDT' } });
        const ngnToUsd = usdtRate && usdtRate.sellRate > 0 ? 1 / usdtRate.sellRate : 0;

        for (const curr of uniqueCurrencies) {
            if (!curr || typeof curr !== 'string') {
                this.logger.warn(`Skipping invalid currency in rate cache: ${curr}`);
                rateCache[curr] = 0;
                continue;
            }

            // Primary: Use in-house CryptoRate
            const cryptoRate = await this.prisma.cryptoRate.findUnique({ 
                where: { currency: curr.toUpperCase() } 
            });

            if (cryptoRate && cryptoRate.sellRate > 0 && ngnToUsd > 0) {
                // Convert NGN rate to USD rate
                rateCache[curr] = cryptoRate.sellRate * ngnToUsd;
                continue;
            }

            // Fallback: Try external APIs
            let rate: number | null = null;
            try {
                rate = await this.liveCoinWatchService.getPriceInUSD(curr.toLowerCase());
            } catch (lcwErr) {
                this.logger.warn(`LCW failed for ${curr}, trying CoinCap`);
                try {
                    rate = await this.coinCapService.getPriceInUSD(curr.toLowerCase());
                } catch (ccErr) {
                    this.logger.warn(`CoinCap also failed for ${curr}`);
                }
            }
            if (rate) {
                rateCache[curr] = rate;
            } else {
                this.logger.warn(`Using fallback rate for ${curr}`);
                rateCache[curr] = 0;
            }
        }

        // Calculate daily total (last 24 hours)
        // NOTE: rateAtConversion is stored in NGN (Naira), NOT USD!
        // We must use the current USD rate from rateCache instead
        let currentDailyTotal = 0;
        for (const order of orders) {
            if (order.createdAt >= oneDayAgo && order.amount && order.currency) {
                // Always use current USD rate - rateAtConversion is in NGN!
                const usdRate = rateCache[order.currency] || 0;
                const usdAmount = order.amount * usdRate;
                currentDailyTotal += usdAmount || 0;
            }
        }
        const newDailyTotal = currentDailyTotal + amountInUSD.amount;

        // Check tier-based daily withdrawal limit (only if not unlimited)
        if (!hasUnlimitedWithdrawal) {
            const dailyLimit = tierWithdrawalLimit as number;
            if (newDailyTotal > dailyLimit) {
                transactionId = uuidv4();
                reason = `Daily withdrawal limit exceeded for Tier ${tierInfo.tier}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal.toFixed(2)} (Current: $${currentDailyTotal.toFixed(2)}, This transaction: $${amountInUSD.amount.toFixed(2)}) - Transaction ID: ${transactionId}`;
                await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
                await this.sendFlaggedEmail(user, reason, transactionId);
                throw new GeneralTransactionException(
                    `Daily withdrawal limit of $${dailyLimit.toLocaleString()} exceeded. Upgrade your verification tier to increase limits.`,
                    HttpStatus.FORBIDDEN
                );
            }
        }

        // Calculate monthly total (last 30 days)
        // NOTE: rateAtConversion is stored in NGN (Naira), NOT USD!
        let currentMonthlyTotal = 0;
        for (const order of orders) {
            if (order.amount && order.currency) {
                // Always use current USD rate - rateAtConversion is in NGN!
                const usdRate = rateCache[order.currency] || 0;
                const usdAmount = order.amount * usdRate;
                currentMonthlyTotal += usdAmount || 0;
            }
        }
        const newMonthlyTotal = currentMonthlyTotal + amountInUSD.amount;

        if (newMonthlyTotal > monthlyLimit) {
            transactionId = uuidv4();
            reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal} (Current: $${currentMonthlyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);

            // Flag user for monthly limit violation
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

            // Verify flagged record
            const verifiedFlagged = await this.prisma.flagged.findUnique({
                where: { userId: user.id },
            });
            if (!verifiedFlagged || !verifiedFlagged.flagged || verifiedFlagged.reason !== reason) {
                throw new Error(`Failed to update flagged record for user ${user.id}`);
            }

            // Update user.flaggedId
            await this.prisma.user.update({
                where: { id: user.id },
                data: { flaggedId: flaggedRecord.id },
                select: { id: true, flaggedId: true },
            });

            await this.sendFlaggedEmail(user, reason, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }
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
