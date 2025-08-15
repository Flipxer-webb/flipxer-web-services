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

        await this.validateAndUpdateTransactionLimits(user, amount, currency, orderCategory, path);
    }

    async validateAndUpdateTransactionLimits(
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
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();

        let currentMonthlyTotal: number | undefined;
        let newMonthlyTotal: number | undefined;
        let transactionId: string | undefined;
        let reason: string | undefined;

        try {
            await prisma.$transaction(async (tx) => {
                // Check monthly limit
                const monthlyTransaction = await tx.monthlyTransaction.findUnique({
                    where: {
                        userId_year_month: {
                            userId: user.id,
                            year: currentYear,
                            month: currentMonth,
                        },
                    },
                });

                currentMonthlyTotal = monthlyTransaction?.totalUSD || 0;
                newMonthlyTotal = currentMonthlyTotal + amountInUSD.amount;

                if (newMonthlyTotal > monthlyLimit) {
                    transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
                    reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal} (Current: $${currentMonthlyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
                    throw new GeneralTransactionException(
                        `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                        HttpStatus.FORBIDDEN
                    );
                }

                // Check daily limit
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

                if (newDailyTotal > dailyLimit) {
                    transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
                    reason = `Daily transaction limit exceeded for ${user.userType}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal} (Current: $${currentDailyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
                    await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId, tx);
                    throw new GeneralTransactionException(
                        `Transaction is pending. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
                        HttpStatus.FORBIDDEN
                    );
                }

                // Update transaction totals
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

            }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        } catch (error) {
            if (error instanceof GeneralTransactionException && transactionId && reason) {
                // Log current flagged record state
                const existingFlagged = await prisma.flagged.findUnique({
                    where: { userId: user.id },
                });

                // Update flagged record outside transaction
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


                // Verify flagged record in database
                const verifiedFlagged = await prisma.flagged.findUnique({
                    where: { userId: user.id },
                });
                if (!verifiedFlagged || !verifiedFlagged.flagged || verifiedFlagged.reason !== reason) {
                    throw new Error(`Failed to update flagged record for user ${user.id}`);
                }

                // Update user.flaggedId
                const updatedUser = await prisma.user.update({
                    where: { id: user.id },
                    data: { flaggedId: flaggedRecord.id },
                    select: { id: true, flaggedId: true },
                });

                // Record failed transaction and send email
                await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);
                await this.sendFlaggedEmail(user, reason, transactionId);
            }
            throw error;
        }
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