
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpStatus,
    Injectable,
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
import { Status, OrderCategory } from "@prisma/client";
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
import {
    InvalidTransactionAmountException,
} from "@/modules/api/trade/errors";
import { TransactionService } from "../services/transaction.service";
import { authenticator } from "otplib";
import {
    blockedCountries,
    isProduction,
    jwtSecret,
    paystackSecretKey,
    quidaxConfig,
} from "@/config";

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

interface TransactionRouteConfig {
    patterns: string[];
    category: OrderCategory;
    getAmount: (body: any) => number | undefined;
    getCurrency: (body: any) => string | undefined;
}

const TRANSACTION_ROUTE_CONFIGS: TransactionRouteConfig[] = [
    {
        patterns: ["buy/order", "buy/quote"],
        category: OrderCategory.BUY,
        getAmount: (body) => body.amount,
        getCurrency: (body) => body.asset?.toUpperCase(),
    },
    {
        patterns: ["sell/order", "sell/quote"],
        category: OrderCategory.SELL,
        getAmount: (body) => body.amount,
        getCurrency: (body) => body.asset?.toUpperCase(),
    },
    {
        patterns: ["request-instant-swap-quote", "refresh-instant-swap-quote"],
        category: OrderCategory.SWAP,
        getAmount: (body) => body.from_amount || body.to_amount,
        getCurrency: (body) =>
            body.from_amount
                ? body.from_currency?.toUpperCase()
                : body.to_currency?.toUpperCase(),
    },
    {
        patterns: ["withdrawer-request"],
        category: OrderCategory.SEND,
        getAmount: (body) => body.amount,
        getCurrency: (body) => body.currency?.toUpperCase(),
    },
];

@Injectable()
export class TransactionAmountGuard implements CanActivate {
    constructor(
        private readonly transactionService: TransactionService
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user = request.user;

        if (!user) {
            throw new InvalidAuthTokenException(
                "User not found in request",
                HttpStatus.UNAUTHORIZED
            );
        }

        const { body, path } = request;
        const transactionData = this.extractTransactionData(body, path);

        if (!transactionData) {
            throw new InvalidTransactionAmountException(
                `Missing amount, currency, or invalid path at ${path}`,
                HttpStatus.BAD_REQUEST
            );
        }

        await this.transactionService.validateTransaction(
            user,
            transactionData.amount,
            transactionData.currency,
            transactionData.category,
            path
        );

        return true;
    }

    private extractTransactionData(
        body: any,
        path: string
    ): { amount: number; currency: string; category: OrderCategory } | null {
        const config = TRANSACTION_ROUTE_CONFIGS.find((cfg) =>
            cfg.patterns.some((pattern) => path.includes(pattern))
        );

        if (!config) return null;

        const amount = config.getAmount(body);
        const currency = config.getCurrency(body);

        if (!amount || !currency) return null;

        return { amount, currency, category: config.category };
    }
}

@Injectable()
export class TwoFactorGuard implements CanActivate {
    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user = request.user;

        if (!user) {
            throw new InvalidAuthTokenException(
                "User not found in request",
                HttpStatus.UNAUTHORIZED
            );
        }

        // Check if user has 2FA enabled
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
            select: { twoFactorSecret: true, isTwoFactorEnabled: true },
        });

        if (!userData?.isTwoFactorEnabled || !userData?.twoFactorSecret) {
            throw new UserForbiddenException(
                "Two-factor authentication must be enabled to perform this action",
                HttpStatus.FORBIDDEN
            );
        }

        // Get 2FA code from request body or header
        const code = request.body?.twoFactorCode || request.headers["x-2fa-code"];

        if (!code) {
            throw new UserForbiddenException(
                "Two-factor authentication code is required for this transaction",
                HttpStatus.FORBIDDEN
            );
        }

        const isValid = authenticator.verify({
            token: code,
            secret: userData.twoFactorSecret,
        });

        if (!isValid) {
            throw new UserForbiddenException(
                "Invalid two-factor authentication code",
                HttpStatus.FORBIDDEN
            );
        }

        return true;
    }
}
