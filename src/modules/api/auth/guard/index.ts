
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpStatus,
    Injectable,
    Logger,
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
            const user = await this.verifyAndFetchUser(token);
            request.user = user;
            return true;
        } catch (error) {
            this.handleAuthError(error);
        }
    }

    private async verifyAndFetchUser(token: string) {
        const payload: DataStoredInToken = await this.jwtService.verifyAsync(
            token,
            { secret: jwtSecret }
        );

        const user = await this.prisma.user.findUnique({
            where: { id: +payload.sub },
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

        return user;
    }

    private handleAuthError(error: any): never {
        logger.error(error);

        if (
            error instanceof UserNotFoundException ||
            error instanceof AccountDeletedException ||
            error instanceof UserForbiddenException
        ) {
            throw error;
        }

        if (error.name === "PrismaClientKnownRequestError") {
            throw new PrismaNetworkException(
                "Unable to process request. Please try again",
                HttpStatus.SERVICE_UNAVAILABLE
            );
        }

        throw new AuthTokenValidationException(
            "Your session is unauthorized or expired",
            HttpStatus.UNAUTHORIZED
        );
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
    private readonly logger = new Logger("QuidaxWebhookGuard");

    canActivate(
        context: ExecutionContext
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as RequestFromQuidax;

        const quidaxSignature = request.headers["quidax-signature"];
        
        if (!quidaxSignature) {
            this.logger.error("[WEBHOOK AUTH] Missing quidax-signature header");
            this.logger.debug(`[WEBHOOK AUTH] Headers: ${JSON.stringify(request.headers)}`);
            return false;
        }

        const [timestampSection, signatureSection] = quidaxSignature.split(",");

        if (!timestampSection || !signatureSection) {
            this.logger.error(`[WEBHOOK AUTH] Invalid signature format: ${quidaxSignature}`);
            return false;
        }

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
            this.logger.log(`[WEBHOOK AUTH] Signature verified for event: ${request.body?.event}`);
            return true;
        } else {
            this.logger.error(`[WEBHOOK AUTH] Signature mismatch for event: ${request.body?.event}`);
            this.logger.debug(`[WEBHOOK AUTH] Expected: ${created_signature}, Received: ${signature}`);
            return false;
        }
    }
}

@Injectable()
export class FincraWebhookGuard implements CanActivate {
    canActivate(
        context: ExecutionContext
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as Request;

        const signature = request.headers["x-fincra-signature"] as string;
        const secret = process.env.FINCRA_WEBHOOK_SECRET;

        if (!signature || !secret) {
            return false;
        }

        const computed = createHmac("sha512", secret)
            .update(JSON.stringify(request.body))
            .digest("hex");

        return computed === signature;
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

        // IMPORTANT: 2FA is optional for transactions
        // If user has 2FA enabled, verify the code
        // If 2FA is not enabled, allow the transaction
        if (userData?.isTwoFactorEnabled && userData?.twoFactorSecret) {
            // Get 2FA code from request body or header
            const code = request.body?.twoFactorCode || request.headers["x-2fa-code"];

            if (!code) {
                throw new UserForbiddenException(
                    "Two-factor authentication code is required. You have 2FA enabled on your account.",
                    HttpStatus.FORBIDDEN
                );
            }

            // Verify with time window for clock skew tolerance
            const isValid = authenticator.verify({
                token: code,
                secret: userData.twoFactorSecret,
                window: 1, // Allow 30 seconds time skew
            });

            if (!isValid) {
                throw new UserForbiddenException(
                    "Invalid 2FA code. Please enter the current code from your authenticator app.",
                    HttpStatus.FORBIDDEN
                );
            }
        }

        // Allow transaction if:
        // 1. User doesn't have 2FA enabled (optional security feature)
        // 2. User has 2FA and provided valid code
        return true;
    }
}
