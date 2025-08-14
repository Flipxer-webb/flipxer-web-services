import {
    Injectable,
    Logger,
    HttpStatus,
} from "@nestjs/common";
import { PrismaClient, User, OrderCategory, OrderStatus, OrderStreamlinedStatus, Prisma } from "@prisma/client";
import { CoinGeckoCacheService } from "@/modules/core/redisCache/services/coingecko-cache.service";
import { EmailService } from "@/modules/core/email/services";
import {
    GeneralTransactionException,
} from "@/modules/api/trade/errors";
import { customAlphabet } from "nanoid";
import { COMPANY_NAME, mailConfig, emailTemplateConfig } from "@/config";
import { getTriggeredTime } from "@/modules/scheduler/services/utils";

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
        this.logger.debug(`Validating transaction for user ${user.id} (${user.userType}) for ${amount} ${currency} at ${getTriggeredTime()}`);

        // Check flagged status
        const flagged = await prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            await this.recordFailedTransaction(user, amount, currency, flagged.reason, path, transactionId);
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            this.logger.warn(`Transaction blocked for flagged user ${user.id}: ${flagged.reason}`);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }

        await this.validateAndUpdateTransactionLimits(user, amount, currency, orderCategory, path);
    }

    async validateAndUpdateTransactionLimits(
        user: User,
        amount: number,
        currency: string,
        orderCategory: OrderCategory,
        path: string
    ): Promise<void> {
        this.logger.debug(`Validating transaction limits for user ${user.id} (${user.userType}) for ${amount} ${currency} at ${getTriggeredTime()}`);

        // Validate currency
        if (!currency || !["BTC", "ETH", "USDT"].includes(currency.toUpperCase())) { // Example supported currencies
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Unsupported currency ${currency} - Transaction ID: ${transactionId}`;
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
            this.logger.error(`Transaction failed for user ${user.id} due to unsupported currency: ${currency}`);
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
            this.logger.error(`Transaction failed for user ${user.id} due to price conversion failure for ${currency}`);
            throw new GeneralTransactionException(
                `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        this.logger.debug(`Converted ${amount} ${currency} to $${amountInUSD.amount} USD for user ${user.id}`);

        const dailyLimit = user.userType === "INDIVIDUAL" ? 5000 : 10000;
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();

        try {
            await prisma.$transaction(async (tx) => {
                // Check monthly limit first
                const monthlyTransaction = await tx.monthlyTransaction.findUnique({
                    where: {
                        userId_year_month: {
                            userId: user.id,
                            year: currentYear,
                            month: currentMonth,
                        },
                    },
                });

                const currentMonthlyTotal = monthlyTransaction?.totalUSD || 0;
                const newMonthlyTotal = currentMonthlyTotal + amountInUSD.amount;

                this.logger.debug(`Monthly check for user ${user.id}: Current $${currentMonthlyTotal}, Attempted $${newMonthlyTotal}, Limit $${monthlyLimit}`);

                if (newMonthlyTotal > monthlyLimit) {
                    const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
                    const reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal} (Current: $${currentMonthlyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;

                    // Flag the user
                    const flaggedRecord = await tx.flagged.upsert({
                        where: { userId: user.id },
                        create: {
                            userId: user.id,
                            flagged: true,
                            reason,
                            updatedAt: new Date(),
                        },
                        update: {
                            flagged: true,
                            reason,
                            updatedAt: new Date(),
                        },
                    });

                    await tx.user.update({
                        where: { id: user.id },
                        data: { flaggedId: flaggedRecord.id },
                    });

                    await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId, tx);
                    await this.sendFlaggedEmail(user, reason, transactionId);

                    this.logger.warn(`User ${user.id} flagged for exceeding monthly limit: ${reason}`);

                    throw new GeneralTransactionException(
                        `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                        HttpStatus.FORBIDDEN
                    );
                }

                // Check daily limit only if monthly limit is not exceeded
                const dailyTransaction = await tx.dailyTransaction.findUnique({
                    where: {
                        userId_year_month_day: {
                            userId: user.id,
                            year: currentYear,
                            month: currentMonth,
                            day: currentDay,
                        },
                    },
                });

                const currentDailyTotal = dailyTransaction?.totalUSD || 0;
                const newDailyTotal = currentDailyTotal + amountInUSD.amount;

                this.logger.debug(`Daily check for user ${user.id}: Current $${currentDailyTotal}, Attempted $${newDailyTotal}, Limit $${dailyLimit}`);

                if (newDailyTotal > dailyLimit) {
                    const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
                    const reason = `Daily transaction limit exceeded for ${user.userType}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal} (Current: $${currentDailyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
                    // Do not flag the user, just block the transaction
                    await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId, tx);
                    this.logger.warn(`Transaction blocked for user ${user.id} due to daily limit: ${reason}`);
                    throw new GeneralTransactionException(
                        `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                        HttpStatus.FORBIDDEN
                    );
                }

                // Update transaction totals only if both limits are valid
                await tx.monthlyTransaction.upsert({
                    where: {
                        userId_year_month: {
                            userId: user.id,
                            year: currentYear,
                            month: currentMonth,
                        },
                    },
                    create: {
                        userId: user.id,
                        year: currentYear,
                        month: currentMonth,
                        totalUSD: amountInUSD.amount,
                    },
                    update: {
                        totalUSD: { increment: amountInUSD.amount },
                        updatedAt: new Date(),
                    },
                });

                await tx.dailyTransaction.upsert({
                    where: {
                        userId_year_month_day: {
                            userId: user.id,
                            year: currentYear,
                            month: currentMonth,
                            day: currentDay,
                        },
                    },
                    create: {
                        userId: user.id,
                        year: currentYear,
                        month: currentMonth,
                        day: currentDay,
                        totalUSD: amountInUSD.amount,
                    },
                    update: {
                        totalUSD: { increment: amountInUSD.amount },
                        updatedAt: new Date(),
                    },
                });

                this.logger.debug(`Transaction limits updated for user ${user.id}: Monthly total $${newMonthlyTotal}, Daily total $${newDailyTotal}`);
            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
            this.logger.error(`Transaction processing failed for user ${user.id}: ${error.message}`);
            throw error; // Re-throw to ensure the error is propagated
        }
    }

    private async getAmountInUSD(asset: string, amount: number): Promise<{ amount?: number; rate?: number } | null> {
        const rate = await this.coinGeckoCacheService.getPriceInUSD(asset);
        if (!rate) {
            this.logger.error(`Failed to fetch USD price for ${asset}`);
            return null;
        }
        this.logger.debug(`Fetched USD price for ${asset}: $${rate}`);
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

        try {
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
            this.logger.debug(`Recorded failed transaction for user ${user.id}: ${reason}`);
        } catch (error) {
            this.logger.error(`Failed to record transaction for user ${user.id}: ${error.message}`);
            throw error;
        }
    }

    private async sendFlaggedEmail(user: User, reason: string, transactionId: string): Promise<void> {
        const team = COMPANY_NAME;

        try {
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
            this.logger.debug(`Sent flagged email to user ${user.id} for transaction ${transactionId}`);
        } catch (error) {
            this.logger.error(`Failed to send flagged email to user ${user.id}: ${error.message}`);
        }
    }
}