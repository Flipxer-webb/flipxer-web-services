import {
    blockedCountries,
    isProdEnvironment,
    isProduction,
    jwtSecret,
    paystackSecretKey,
    quidaxConfig,
    COMPANY_NAME,
    mailConfig,
    emailTemplateConfig
} from "@/config";
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpStatus,
    Injectable,
    Inject,
    Logger
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import {
    AccountDeletedException,
    UserNotFoundException,
} from "@/modules/api/user";
import {
    AuthTokenValidationException,
    InvalidAuthTokenException,
    PrismaNetworkException,
    UserAccountDisabledException,
    UserForbiddenException,
} from "../errors";
import {
    DataStoredInToken,
    RequestFromPaystack,
    RequestFromQuidax,
    RequestWithUser,
} from "../interfaces";
import logger from "moment-logger";
import { Status } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { Observable } from "rxjs";
import * as crypto from "crypto";
import { createHmac } from "crypto";
import * as requestIp from "request-ip";
import { GeoIPService } from "@/modules/core/geoip/geoip.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { Socket } from "socket.io";
import {
    WsAuthTokenValidationException,
    WsMissingAuthorizationToken,
    WsPrismaNetworkException,
    WsUserNotFoundException,
} from "../errors/ws";
import { EmailService } from "@/modules/core/email/services";
import { OrderCategory, OrderStatus, OrderStreamlinedStatus } from "@prisma/client";
import {
    GeneralTransactionException,
    InvalidTransactionAmountException,
} from "@/modules/api/trade/errors";
import axios from "axios";
import { customAlphabet } from "nanoid";
import { User } from "@prisma/client";
import { setTimeout } from "timers/promises";

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest() as RequestWithUser;
        const token = this.extractTokenFromHeader(request);
        if (!token) {
            throw new InvalidAuthTokenException(
                "Authorization header is missing",
                HttpStatus.UNAUTHORIZED
            );
        }
        try {
            const payload: DataStoredInToken =
                await this.jwtService.verifyAsync(token, {
                    secret: jwtSecret,
                });

            const user = await this.prisma.user.findUnique({
                where: {
                    id: +payload.sub,
                },
                include: { role: { select: { name: true, slug: true } } },
            });
            if (!user) {
                throw new UserNotFoundException(
                    "Your session is unauthorized",
                    HttpStatus.UNAUTHORIZED
                );
            }

            if (user.isDeleted) {
                throw new AccountDeletedException(
                    "Account not found",
                    HttpStatus.UNAUTHORIZED
                );
            }

            request.user = user;
        } catch (error) {
            logger.error(error);
            switch (true) {
                case error instanceof UserNotFoundException: {
                    throw error;
                }

                case error instanceof AccountDeletedException: {
                    throw error;
                }

                case error instanceof UserForbiddenException: {
                    throw error;
                }

                case error.name == "PrismaClientKnownRequestError": {
                    throw new PrismaNetworkException(
                        "Unable to process request. Please try again",
                        HttpStatus.SERVICE_UNAVAILABLE
                    );
                }

                default: {
                    throw new AuthTokenValidationException(
                        "Your session is unauthorized or expired",
                        HttpStatus.UNAUTHORIZED
                    );
                }
            }
        }
        return true;
    }

    private extractTokenFromHeader(request: Request): string | undefined {
        const [type, token] = request.headers.authorization?.split(" ") ?? [];
        return type === "Bearer" ? token : undefined;
    }
}

@Injectable()
export class EnabledAccountGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const user = request.user;
        if (user && user.accountStatus !== Status.BLOCKED) {
            return true;
        }
        throw new UserAccountDisabledException(
            "Account is blocked. Kindly contact customer support",
            HttpStatus.BAD_REQUEST
        );
    }
}

@Injectable()
export class QuidaxWebhookGuard implements CanActivate {
    canActivate(
        context: ExecutionContext
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as RequestFromQuidax;
        const [timestampSection, signatureSection] =
            request.headers["quidax-signature"].split(",");

        const [timestampPrefix, timestamp] = timestampSection.split("=");

        const [signaturePrefix, signature] = signatureSection.split("=");

        const requestBody = JSON.stringify(request.body);

        const payload = `${timestamp}.${requestBody}`;

        const created_signature = crypto
            .createHmac("sha256", quidaxConfig.webhook_key)
            .update(payload)
            .digest()
            .toString("hex");

        if (signature === created_signature) {
            return true;
        } else {
            return false;
        }
    }
}

@Injectable()
export class PaystackWebhookGuard implements CanActivate {
    canActivate(
        context: ExecutionContext
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as RequestFromPaystack;

        const hash = createHmac("sha512", paystackSecretKey)
            .update(JSON.stringify(request.body))
            .digest("hex");

        if (hash == request.headers["x-paystack-signature"]) {
            return true;
        } else {
            return false;
        }
    }
}

@Injectable()
export class CountryBlockGuard implements CanActivate {
    constructor(
        private readonly geoIPService: GeoIPService,
        private readonly redisCacheService: RedisCacheService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const clientIp = requestIp.getClientIp(req) ?? "";

        if (!clientIp) {
            if (isProduction) {
                throw new ForbiddenException("Access denied: IP not found");
            }
            return true;
        }

        const redisKey = `geoip:${clientIp}`;
        let countryCode = await this.redisCacheService.get<string>(redisKey);

        if (!countryCode) {
            countryCode = this.geoIPService.getCountryCode(clientIp);
            await this.redisCacheService.set(
                redisKey,
                countryCode ?? "",
                60 * 60
            ); // 1 hour
        }

        if (countryCode && blockedCountries.includes(countryCode)) {
            throw new ForbiddenException(
                `Access denied from your country: ${countryCode}`
            );
        }

        if (!countryCode && isProduction) {
            throw new ForbiddenException(
                "Access denied: could not determine your country"
            );
        }

        return true;
    }
}

@Injectable()
export class SocketAuthGuard implements CanActivate {
    constructor(
        private jwtService: JwtService,
        private prisma: PrismaService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const client: Socket = context.switchToWs().getClient<Socket>();
        const token = this.extractTokenFromHandshake(client);

        if (!token) {
            throw new WsMissingAuthorizationToken(
                "Your Session is unauthorized"
            );
        }

        try {
            const payload: DataStoredInToken =
                await this.jwtService.verifyAsync(token, {
                    secret: process.env.JWT_SECRET,
                });

            const user = await this.prisma.user.findUnique({
                where: { id: +payload.sub },
            });

            if (!user) {
                throw new WsUserNotFoundException(
                    "Your session is unauthorized"
                );
            }

            client.data.user = user;
        } catch (error) {
            if (error instanceof WsUserNotFoundException) {
                throw error;
            } else if (error.name === "PrismaClientKnownRequestError") {
                throw new WsPrismaNetworkException(
                    "Unable to process request. Please try again"
                );
            } else {
                throw new WsAuthTokenValidationException(
                    "Your session is unauthorized"
                );
            }
        }
        return true;
    }

    private extractTokenFromHandshake(client: Socket): string | undefined {
        const token = client.handshake.query.token as string;
        return token;
    }
}

export const TradingInjectionToken = {
    COINGECKO: Symbol("COINGECKO"),
};

@Injectable()
export class CoinGeckoService {
    constructor(private readonly redisCacheService: RedisCacheService) {}

    async getPriceInUSD(asset: string, retries = 3, delay = 1000): Promise<number> {
        const cacheKey = `coingecko:price:${asset.toLowerCase()}:usd`;
        const cachedPrice = await this.redisCacheService.get<number>(cacheKey);
        if (cachedPrice) return cachedPrice;

        const coinGeckoIdMap: { [key: string]: string } = {
            btc: "bitcoin",
            eth: "ethereum",
            usdt: "tether",
            usdc: "usd-coin",
            bnb: "binancecoin",
            ada: "cardano",
            sol: "solana",
            xrp: "ripple",
            dot: "polkadot",
            doge: "dogecoin",
            matic: "matic-network",
            avax: "avalanche-2",
            shib: "shiba-inu",
            ltc: "litecoin",
            link: "chainlink",
            bch: "bitcoin-cash",
            xlm: "stellar",
            algo: "algorand",
            atom: "cosmos",
            dai: "dai"
        };
        const coinGeckoId = coinGeckoIdMap[asset.toLowerCase()] || asset.toLowerCase();

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
                    params: { ids: coinGeckoId, vs_currencies: "usd" },
                });
                const rate = response.data[coinGeckoId]?.usd;
                if (!rate) throw new Error(`No price data for ${asset} (ID: ${coinGeckoId})`);
                await this.redisCacheService.set(cacheKey, rate, 5 * 60); // Cache for 5 minutes
                return rate;
            } catch (error) {
                console.error(`Attempt ${attempt} failed for ${asset}:`, {
                    message: error.message,
                    status: error.response?.status,
                    data: error.response?.data,
                });
                if (attempt === retries) {
                    throw new GeneralTransactionException(
                        `Failed to fetch USD rate for ${asset} after ${retries} attempts: ${error.message}`,
                        HttpStatus.INTERNAL_SERVER_ERROR
                    );
                }
                await setTimeout(delay * attempt);
            }
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
            const transactionId = customAlphabet("1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10)();
            await this.recordFailedTransaction(user, body.amount, body.currency, flagged.reason, path, transactionId);
            await this.sendFlaggedEmail(user, flagged.reason, transactionId);
            throw new GeneralTransactionException(
                `Something went wrong. Kindly contact support for further assistance. Transaction ID: ${transactionId}`,
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

        const dailyLimit = user.userType === "INDIVIDUAL" ? 5000 : 10000;
        const monthlyLimit = user.userType === "INDIVIDUAL" ? 100000 : 500000;

        const now = new Date();
        const currentYear = now.getFullYear();
        const currentMonth = now.getMonth() + 1;
        const currentDay = now.getDate();

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

            await this.recordFailedTransaction(user, amount, currency, reason, path, transactionId);

            throw new GeneralTransactionException(
                `Transaction failed: Daily limit of $${dailyLimit} exceeded for ${user.userType} (Current: $${currentDailyTotal}, Attempted: $${amountInUSD.amount}). Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }

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
            });

            await this.sendFlaggedEmail(user, reason, transactionId);

            throw new GeneralTransactionException(
                `Transaction failed: Monthly limit of $${monthlyLimit} exceeded for ${user.userType} (Current: $${currentMonthlyTotal}, Attempted: $${amountInUSD.amount}). Transaction ID: ${transactionId}`,
                HttpStatus.FORBIDDEN
            );
        }

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
                reason // Include reason in email payload
            },
        });
    }
}