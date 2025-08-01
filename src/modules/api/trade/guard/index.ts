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
    private readonly logger = new Logger(CoinGeckoService.name);

    async getPriceInUSD(asset: string): Promise<number> {
        const coinGeckoIdMap: { [key: string]: string } = {
            btc: "bitcoin",
            eth: "ethereum",
            usdt: "tether",
            bnb: "binancecoin",
        };
        const coinGeckoId = coinGeckoIdMap[asset.toLowerCase()] || asset.toLowerCase();

        this.logger.log(`Fetching USD price for asset: ${asset} (ID: ${coinGeckoId})`);

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
            this.logger.error(`CoinGecko error: ${error.message}`);
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

        const flagged = await this.prisma.flagged.findUnique({
            where: { userId: user.id },
        });

        if (flagged?.flagged) {
            // Record failed transaction and get transactionId
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            await this.recordFailedTransaction(user, body.amount, body.currency, flagged.reason, path, transactionId);
            // Send email with transactionId
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            throw new GeneralTransactionException(
                `Something went wrong. Kindly contact support for further assistance.`,
                HttpStatus.FORBIDDEN
            );
        }

        let amount: number | undefined;
        let currency: string | undefined;
        let orderCategory: OrderCategory | undefined;

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

        const threshold = user.userType === "INDIVIDUAL" ? 10000 : 20000;

        if (amountInUSD.amount > threshold) {
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            const reason = `Amount exceeds $${threshold} for ${user.userType} ($${amountInUSD.amount}) - Transaction ID: ${transactionId}`;
            await this.prisma.$transaction(async (tx) => {
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

                // Record failed transaction with transactionId
                await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId, tx);
            });

            // Send email with transactionId
            await this.sendFlaggedEmail(user, reason, transactionId);

            throw new GeneralTransactionException(
                `Transaction failed for ${user.userType} ($${amountInUSD.amount})`,
                HttpStatus.FORBIDDEN
            );
        }

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
        tx: any = this.prisma // Use passed transaction or default to prisma
    ): Promise<void> {
        try {
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

            this.logger.log(`Recorded failed transaction for user ${user.id} with transactionId ${transactionId}`);
        } catch (error) {
            this.logger.error(`Failed to record transaction for user ${user.id}: ${error.message}`);
        }
    }

    private async sendFlaggedEmail(user: User, reason: string, transactionId: string): Promise<void> {
        try {
            const team = COMPANY_NAME;

            await this.emailService.sendMailWithTemplate({
                from: { address: mailConfig.senderMail },
                to: [{ email_address: { address: user.email } }],
                template_key: emailTemplateConfig.transaction_failed,
                merge_info: {
                    name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || "User",
                    transactionId, // Changed from amount to transactionId
                    team,
                },
            });

        } catch (error) {
            this.logger.error(`Failed to send flagged email to ${user.email}: ${error.message}`);
        }
    }
}