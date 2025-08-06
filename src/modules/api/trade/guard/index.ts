
import {
    CanActivate,
    ExecutionContext,
    HttpStatus,
    Injectable,
    Logger,
} from "@nestjs/common";
import { PrismaService } from "../../../core/prisma/services";
import { Inject } from "@nestjs/common";
import { User } from "@prisma/client";
import { RequestWithUser } from "../../auth/interfaces";
import {
    GeneralTransactionException,
    InvalidTransactionAmountException,
} from "../../../api/trade/errors";
import { UserNotFoundException } from "../../../api/user";
import axios from "axios";
import { EmailService } from "@/modules/core/email/services";
import { COMPANY_NAME, mailConfig, emailTemplateConfig } from "@/config";
import { OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import { customAlphabet } from "nanoid";

// Injection token for CoinGeckoService
export const TradingInjectionToken = {
    COINGECKO: Symbol("COINGECKO"),
};

@Injectable()
export class CoinGeckoService {

    async getPriceInUSD(asset: string): Promise<number> {
        const coinGeckoIdMap: { [key: string]: string } = {
            btc: "bitcoin",
            eth: "ethereum",
            usdt: "tether",
            bnb: "binancecoin",
        };
        const coinGeckoId = coinGeckoIdMap[asset.toLowerCase()] || asset.toLowerCase();

        try {
            const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                params: {
                    ids: coinGeckoId,
                    vs_currencies: "usd",
                },
            });

            const rate = response.data[coinGeckoId]?.usd;
            if (!rate) throw new Error(`No price data for ${asset}`);
            return rate;
        } catch (error) {
            throw new GeneralTransactionException(
                `Failed to fetch USD rate for ${asset}: ${error.message}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }
    }
}

@Injectable()
export class TransactionAmountGuard implements CanActivate {
    private readonly logger = new Logger(TransactionAmountGuard.name);

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.COINGECKO)
        private readonly coinGeckoService: CoinGeckoService,
        private readonly emailService: EmailService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user: User = request.user;
        const body = request.body;
        const path = request.path;

        if (!user) {
            throw new UserNotFoundException("User not found", HttpStatus.UNAUTHORIZED);
        }

        // Check if user is already flagged
        const flagged = await this.prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            await this.recordFailedTransaction(user, body.amount, body.currency, flagged.reason, path, transactionId);
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            throw new GeneralTransactionException(
                `Something went wrong. Kindly contact support for further assistance.`,
                HttpStatus.FORBIDDEN
            );
        }

        let amount: number | undefined;
        let currency: string | undefined;
        let orderCategory: OrderCategory | undefined;

        // Extract amount, currency, and order category based on request path
        if (path.includes("buy/order") || path.includes("buy/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
            orderCategory = OrderCategory.BUY;
        } else if (path.includes("sell/order") || path.includes("sell/quote")) {
            amount = body.amount;
            currency = body.asset?.toUpperCase();
            orderCategory = OrderCategory.SELL;
        } else if (path.includes("request-instant-swap-quote") || path.includes("refresh-instant-swap-quote")) {
            amount = body.from_amount || body.to_amount;
            currency = body.from_amount ? body.from_currency?.toUpperCase() : body.to_currency?.toUpperCase();
            orderCategory = OrderCategory.SWAP;
        } else if (path.includes("withdrawer-request")) {
            amount = body.amount;
            currency = body.currency?.toUpperCase();
            orderCategory = OrderCategory.SEND;
        }

        if (!amount || !currency || !orderCategory) {
            throw new InvalidTransactionAmountException(
                `Missing amount, currency, or invalid path at ${path}`,
                HttpStatus.BAD_REQUEST
            );
        }

        const amountInUSD = await this.getAmountInUSD(currency, amount);

        if (!amountInUSD || !amountInUSD.amount) {
            throw new GeneralTransactionException(
                `Conversion failed for ${amount} ${currency}`,
                HttpStatus.INTERNAL_SERVER_ERROR
            );
        }

        // Define daily and monthly limits
        const dailyLimit = user.userType === "INDIVIDUAL" ? 5000 : 10000;
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;

        // Get current date components
        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1; // JavaScript months are 0-based, Prisma expects 1-based
        const currentDay = now.getDate();

        // Check daily transaction total
        const dailyTransaction = await this.prisma.dailyTransaction.findUnique({
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
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Daily transaction limit exceeded for ${user.userType}. Limit: $${dailyLimit}, Attempted: $${newDailyTotal} (Current: $${currentDailyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;

            // Record failed transaction without flagging
            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);

            throw new GeneralTransactionException(
                `Transaction failed: Daily limit of $${dailyLimit} exceeded for ${user.userType} (Current: $${currentDailyTotal}, Attempted: $${amountInUSD.amount})`,
                HttpStatus.FORBIDDEN
            );
        }

        // Check monthly transaction total
        const monthlyTransaction = await this.prisma.monthlyTransaction.findUnique({
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

        if (newMonthlyTotal > monthlyLimit) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Monthly transaction limit exceeded for ${user.userType}. Limit: $${monthlyLimit}, Attempted: $${newMonthlyTotal} (Current: $${currentMonthlyTotal}, This transaction: $${amountInUSD.amount}) - Transaction ID: ${transactionId}`;

            await this.prisma.$transaction(async (tx) => {
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

                // Record failed transaction
                await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId, tx);
            });

            // Send email notification
            await this.sendFlaggedEmail(user, reason, transactionId);

            throw new GeneralTransactionException(
                `Transaction failed: Monthly limit of $${monthlyLimit} exceeded for ${user.userType} (Current: $${currentMonthlyTotal}, Attempted: $${amountInUSD.amount})`,
                HttpStatus.FORBIDDEN
            );
        }

        // Update daily and monthly transaction totals (for allowed transactions)
        await this.prisma.$transaction(async (tx) => {
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
        });

        return true;
    }

    async getAmountInUSD(asset: string, amount: number): Promise<{ amount?: number; rate?: number } | null> {
        const rate = await this.coinGeckoService.getPriceInUSD(asset);
        return {
            amount: amount * rate,
            rate,
        };
    }

    private async recordFailedTransaction(
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
            },
        });
    }
}