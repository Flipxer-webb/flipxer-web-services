import {
    Injectable,
    Logger,
    HttpStatus,
} from "@nestjs/common";
import { PrismaClient, User, OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import { CoinGeckoCacheService } from "@/modules/core/redisCache/services/coingecko-cache.service";
import { EmailService } from "@/modules/core/email/services";
import {
    GeneralTransactionException,
} from "@/modules/api/trade/errors";
import { customAlphabet } from "nanoid";
import { COMPANY_NAME, mailConfig, emailTemplateConfig } from "@/config";

const prisma = new PrismaClient();

@Injectable()
export class TransactionService {
    private readonly logger = new Logger(TransactionService.name);

    constructor(
        private readonly coinGeckoCacheService: CoinGeckoCacheService,
        private readonly emailService: EmailService
    ) {}

    async validateTransaction(
        user: User,
        amount: number,
        currency: string,
        orderCategory: OrderCategory,
        path: string
    ): Promise<void> {
        // Check flagged status
        const flagged = await prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
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
        // Validate currency
        if (!currency || !["BTC", "ETH", "USDT"].includes(currency.toUpperCase())) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Unsupported currency ${currency} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const amountInUSD = await this.getAmountInUSD(currency, amount);
        if (!amountInUSD || !amountInUSD.amount) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Conversion failed for ${amount} ${currency} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        const dailyLimit = user.userType === "INDIVIDUAL" ? 5000 : 10000;
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;
        const now = new Date(); // 2025-08-25 22:54:00 WAT (UTC+1)
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 2025-08-24 22:54:00 WAT
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // 2025-07-26 22:54:00 WAT

        let transactionId: string | undefined;
        let reason: string | undefined;

        // Fetch all relevant orders once
        const orders = await prisma.order.findMany({
            where: {
                userId: user.id,
                createdAt: { gte: thirtyDaysAgo },
                status: { in: [OrderStatus.filled, OrderStatus.completed, OrderStatus.done] },
            },
            select: { amount: true, currency: true, createdAt: true, rateAtConversion: true },
        });

        // Batch fetch USD rates for unique currencies
        const uniqueCurrencies = [...new Set(orders.map(order => order.currency).concat(currency))];
        const rateCache: { [key: string]: number } = {};
        for (const curr of uniqueCurrencies) {
            const rate = await this.coinGeckoCacheService.getPriceInUSD(curr);
            if (rate) {
                rateCache[curr] = rate;
            } else {
                this.logger.warn(`Using fallback rate for ${curr}`);
                rateCache[curr] = 0; // Handle gracefully or throw error
            }
        }

        // Calculate daily total (last 24 hours)
        let currentDailyTotal = 0;
        for (const order of orders) {
            if (order.createdAt >= oneDayAgo && order.amount) {
                const usdAmount = order.rateAtConversion
                    ? order.amount * order.rateAtConversion
                    : order.amount * rateCache[order.currency];
                currentDailyTotal += usdAmount || 0;
            }
        }
        const newDailyTotal = currentDailyTotal + amountInUSD.amount;

        if (newDailyTotal > dailyLimit) {
            transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            reason = `Daily transaction limit exceeded for ${user.userType}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal} (Current: $${currentDailyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            await this.sendFlaggedEmail(user, reason, transactionId);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }

        // Calculate monthly total (last 30 days)
        let currentMonthlyTotal = 0;
        for (const order of orders) {
            if (order.amount) {
                const usdAmount = order.rateAtConversion
                    ? order.amount * order.rateAtConversion
                    : order.amount * rateCache[order.currency];
                currentMonthlyTotal += usdAmount || 0;
            }
        }
        const newMonthlyTotal = currentMonthlyTotal + amountInUSD.amount;

        if (newMonthlyTotal > monthlyLimit) {
            transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal} (Current: $${currentMonthlyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);

            // Flag user for monthly limit violation
            const flaggedRecord = await prisma.flagged.upsert({
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
            const verifiedFlagged = await prisma.flagged.findUnique({
                where: { userId: user.id },
            });
            if (!verifiedFlagged || !verifiedFlagged.flagged || verifiedFlagged.reason !== reason) {
                throw new Error(`Failed to update flagged record for user ${user.id}`);
            }

            // Update user.flaggedId
            await prisma.user.update({
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

        // No updates to DailyTransaction or MonthlyTransaction
    }

    private async getAmountInUSD(asset: string, amount: number): Promise<{ amount?: number; rate?: number } | null> {
        const rate = await this.coinGeckoCacheService.getPriceInUSD(asset);
        if (!rate) {
            this.logger.error(`Failed to fetch USD price for ${asset}`);
            return null;
        }
        return {
            amount: amount * rate,
            rate,
        };
    }

    async recordFailedTransaction(
        user: User,
        amount: number,
        currency: string,
        reason: string,
        path: string,
        transactionId: string,
        tx: any = prisma
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
                currency,
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
