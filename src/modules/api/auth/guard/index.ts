
import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    HttpStatus,
    Injectable,
    Logger,
    Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Request } from "express";
import {
    AccountDeletedException,
    UserNotFoundException,
} from "@/modules/api/user/errors";
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
import { createHmac, timingSafeEqual } from "node:crypto";
import * as requestIp from "request-ip";
import { GeoIPService } from "@/modules/core/geoip/geoip.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { decryptField } from "@/utils";
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
import { isTwoFactorRequiredForTransaction, convertToNGN } from "../utils/tier-threshold.util";
import {
    blockedCountries,
    isProduction,
    jwtSecret,
    quidaxConfig,
} from "@/config";
import { SessionService } from "@/modules/api/session/services";
import { PaymentWebhookVerifier } from "@/modules/factory/bank/services/payment-webhook-verifier";

type GuardActivationResult = boolean | Promise<boolean> | Observable<boolean>;

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
        private readonly sessionService: SessionService
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const token = this.extractTokenFromHeader(request);

        if (!token) {
            throw new InvalidAuthTokenException(
                "Authorization header is missing",
                HttpStatus.UNAUTHORIZED
            );
        }

        try {
            const { user, payload } = await this.verifyAndFetchUser(token);
            request.user = user;
            request.sessionId = payload.sessionId;
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

        // Backward compatibility: legacy tokens may not include sessionId.
        if (payload.sessionId) {
            const isSessionValid = await this.sessionService.validateSession(
                payload.sessionId
            );

            if (!isSessionValid) {
                throw new InvalidAuthTokenException(
                    "Your session is unauthorized or expired",
                    HttpStatus.UNAUTHORIZED
                );
            }

            await this.sessionService.touchSessionActivity(payload.sessionId);
        }

        return { user, payload };
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
    private readonly TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

    canActivate(
        context: ExecutionContext
    ): GuardActivationResult {
        const request = context.switchToHttp().getRequest<RequestFromQuidax>();

        if (!quidaxConfig.webhook_key) {
            this.logger.error("[WEBHOOK AUTH] SECURITY: QUIDAX_WEBHOOK_KEY not configured - rejecting all webhooks");
            return false;
        }

        const quidaxSignatureHeader = request.headers["quidax-signature"];
        const quidaxSignature = Array.isArray(quidaxSignatureHeader)
            ? quidaxSignatureHeader[0]
            : quidaxSignatureHeader;

        if (!quidaxSignature) {
            this.logger.error("[WEBHOOK AUTH] Missing quidax-signature header");
            this.logger.debug(`[WEBHOOK AUTH] Headers: ${JSON.stringify(request.headers)}`);
            return false;
        }

        // SECURITY: Reject simple signature format - require HMAC
        if (!quidaxSignature.includes(",")) {
            this.logger.error("[WEBHOOK AUTH] SECURITY: Rejected simple signature format - HMAC required");
            this.logger.warn(`[WEBHOOK AUTH] Received non-HMAC signature for event: ${request.body?.event}`);
            return false;
        }

        // HMAC format: t=<timestamp>,v=<signature>
        // HMAC format: t=<timestamp>,s=<signature> (order independent)
        const parts = quidaxSignature.split(",");
        const timestampPart = parts.find(p => p.trim().startsWith("t="));
        const signaturePart = parts.find(p => p.trim().startsWith("s="));

        if (!timestampPart || !signaturePart) {
            this.logger.error(`[WEBHOOK AUTH] Invalid signature format - missing t= or s= components. Received: ${quidaxSignature}`);
            return false;
        }

        const timestamp = timestampPart.trim().substring(2);
        const signature = signaturePart.trim().substring(2);

        if (!timestamp || !signature) {
            this.logger.error(`[WEBHOOK AUTH] Invalid signature format - empty timestamp or signature. Received: ${quidaxSignature}`);
            return false;
        }

        // SECURITY: Validate timestamp to prevent replay attacks
        const webhookTimestamp = Number.parseInt(timestamp, 10);
        const now = Math.floor(Date.now() / 1000);
        const timeDifference = Math.abs(now - webhookTimestamp);

        if (timeDifference > this.TIMESTAMP_TOLERANCE_SECONDS) {
            this.logger.error(`[WEBHOOK AUTH] SECURITY: Timestamp too old/future (${timeDifference}s difference)`);
            this.logger.warn(`[WEBHOOK AUTH] Possible replay attack for event: ${request.body?.event}`);
            return false;
        }

        // Use raw body if available (NestJS rawBody:true provides a Buffer), otherwise fallback
        const rawBuf = (request as any).rawBody;
        let requestBody: string;
        if (rawBuf) {
            requestBody = Buffer.isBuffer(rawBuf) ? rawBuf.toString() : rawBuf;
        } else {
            requestBody = JSON.stringify(request.body);
        }
        const payload = `${timestamp}.${requestBody}`;

        const expectedSignature = createHmac("sha256", quidaxConfig.webhook_key)
            .update(payload)
            .digest("hex");

        // SECURITY: Use timing-safe comparison to prevent timing attacks
        try {
            const signatureBuffer = Buffer.from(signature, 'utf8');
            const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

            if (signatureBuffer.length !== expectedBuffer.length) {
                this.logger.error(`[WEBHOOK AUTH] Signature length mismatch for event: ${request.body?.event}`);
                return false;
            }

            const isValid = timingSafeEqual(signatureBuffer, expectedBuffer);

            if (isValid) {
                this.logger.log(`[WEBHOOK AUTH] Signature verified for event: ${request.body?.event}`);
                return true;
            } else {
                this.logger.error(`[WEBHOOK AUTH] Signature mismatch for event: ${request.body?.event}`);
                return false;
            }
        } catch (error) {
            this.logger.error(`[WEBHOOK AUTH] Error verifying signature: ${error}`);
            return false;
        }
    }
}


@Injectable()
export class FincraWebhookGuard implements CanActivate {
    private readonly logger = new Logger('FincraWebhookGuard');

    canActivate(
        context: ExecutionContext
    ): GuardActivationResult {
        const request = context
            .switchToHttp()
            .getRequest<Request>();
        const webhookEvent = getWebhookEventName(request.body);

        this.logger.log(`Received Fincra webhook request`);
        this.logger.debug(`Event: ${webhookEvent ?? "unknown"}`);

        return PaymentWebhookVerifier.verifyFincraRequest(request, this.logger);
    }
}

@Injectable()
export class NombaWebhookGuard implements CanActivate {
    private readonly logger = new Logger("NombaWebhookGuard");

    canActivate(
        context: ExecutionContext,
    ): GuardActivationResult {
        const request = context
            .switchToHttp()
            .getRequest<Request>();
        const webhookEvent = getWebhookEventName(request.body);

        this.logger.log("Received Nomba webhook request");
        this.logger.debug(`Event: ${webhookEvent ?? "unknown"}`);

        return PaymentWebhookVerifier.verifyNombaRequest(
            request.body,
            request.headers,
            this.logger,
        );
    }
}


// In-memory cache for GeoIP lookups to reduce Redis load
const geoIpMemoryCache = new Map<string, { countryCode: string; expiresAt: number }>();
const GEOIP_MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in memory
const GEOIP_MEMORY_CACHE_MAX_SIZE = 500;

const getWebhookEventName = (body: unknown): string | undefined => {
    if (!body || typeof body !== "object") {
        return undefined;
    }

    const eventType = (body as { event_type?: unknown }).event_type;
    if (typeof eventType === "string") {
        return eventType;
    }

    const event = (body as { event?: unknown }).event;
    return typeof event === "string" ? event : undefined;
};

@Injectable()
export class CountryBlockGuard implements CanActivate {
    constructor(
        private readonly geoIPService: GeoIPService,
        private readonly redisCacheService: RedisCacheService
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest();
        const clientIp = requestIp.getClientIp(req) ?? "";

        if (!clientIp) {
            if (isProduction) {
                throw new ForbiddenException("Access denied: IP not found");
            }
            return true;
        }

        // Check in-memory cache first (avoid Redis call)
        const now = Date.now();
        const memCached = geoIpMemoryCache.get(clientIp);
        if (memCached && memCached.expiresAt > now) {
            const countryCode = memCached.countryCode;
            if (countryCode && blockedCountries.includes(countryCode)) {
                throw new ForbiddenException(
                    `Access denied from your country: ${countryCode}`
                );
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

        // Store in memory cache
        if (geoIpMemoryCache.size >= GEOIP_MEMORY_CACHE_MAX_SIZE) {
            // Clear oldest entries
            const keysToDelete = Array.from(geoIpMemoryCache.keys()).slice(0, 100);
            keysToDelete.forEach(k => geoIpMemoryCache.delete(k));
        }
        geoIpMemoryCache.set(clientIp, {
            countryCode: countryCode ?? "",
            expiresAt: now + GEOIP_MEMORY_CACHE_TTL
        });

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
        private readonly jwtService: JwtService,
        private readonly prisma: PrismaService,
        private readonly sessionService: SessionService
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const client: Socket = context.switchToWs().getClient<Socket>();
        await this.authenticateClient(client);
        return true;
    }

    async authenticateClient(client: Socket): Promise<void> {
        const token = this.extractTokenFromHandshake(client);

        if (!token) {
            throw new WsMissingAuthorizationToken(
                "Your session is unauthorized"
            );
        }

        try {
            const payload: DataStoredInToken =
                await this.jwtService.verifyAsync(token, {
                    secret: jwtSecret,
                });

            const user = await this.prisma.user.findUnique({
                where: { id: +payload.sub },
                include: { role: { select: { name: true, slug: true } } },
            });

            if (!user || user.isDeleted) {
                throw new WsUserNotFoundException(
                    "Your session is unauthorized"
                );
            }

            if (payload.sessionId) {
                const isSessionValid = await this.sessionService.validateSession(
                    payload.sessionId
                );

                if (!isSessionValid) {
                    throw new WsAuthTokenValidationException(
                        "Your session is unauthorized or expired"
                    );
                }

                await this.sessionService.touchSessionActivity(payload.sessionId);
            }

            client.data.user = user;
            client.data.sessionId = payload.sessionId;
        } catch (error) {
            this.handleSocketAuthError(error);
        }
    }

    private extractTokenFromHandshake(client: Socket): string | undefined {
        const token = client.handshake.query.token as string;
        return token;
    }

    private handleSocketAuthError(error: any): never {
        if (
            error instanceof WsMissingAuthorizationToken ||
            error instanceof WsAuthTokenValidationException ||
            error instanceof WsUserNotFoundException ||
            error instanceof WsPrismaNetworkException
        ) {
            throw error;
        }

        if (error.name === "PrismaClientKnownRequestError") {
            throw new WsPrismaNetworkException(
                "Unable to process request. Please try again"
            );
        }

        throw new WsAuthTokenValidationException(
            "Your session is unauthorized"
        );
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
        patterns: ["request-instant-swap-quote", "refresh-instant-swap-quote", "estimate-swap"],
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

function extractTransactionDataFromRoute(
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

@Injectable()
export class TransactionAmountGuard implements CanActivate {
    constructor(
        private readonly transactionService: TransactionService
    ) { }

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
        const transactionData = extractTransactionDataFromRoute(body, path);

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
}

/**
 * Interface for security methods stored in user preferences
 */
interface SecurityMethods {
    sms?: boolean;
    email?: boolean;
    authenticator?: boolean;
    tradingPassword?: boolean;
    biometric?: boolean;
}

/**
 * Enhanced TwoFactorGuard that supports multi-factor security preferences.
 * 
 * The guard checks if the user has any security methods enabled and validates
 * that a verification token is present. The frontend obtains this token by
 * completing verification via the /settings/verify-security-method endpoint.
 * 
 * Supported verification methods:
 * - Authenticator (TOTP)
 * - Trading Password
 * - SMS OTP
 * - Email OTP
 * - Backup Codes (universal fallback)
 * 
 * The verification token is passed via:
 * - x-security-token header (preferred)
 * - verificationToken in request body
 * - twoFactorCode in body (legacy, for direct TOTP verification)
 */
@Injectable()
export class TwoFactorGuard implements CanActivate {
    private readonly logger = new Logger('TwoFactorGuard');

    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        @Optional() private readonly twoFactorRateLimitService?: any,
        @Optional() private readonly settingService?: any
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest<RequestWithUser>();
        const user = request.user;

        if (!user) {
            throw new InvalidAuthTokenException(
                "User not found in request",
                HttpStatus.UNAUTHORIZED
            );
        }

        const userData = await this.fetchUserSecurityData(user.id);
        const securityMethods = this.parseSecurityMethods(userData?.securityMethods);
        const hasSecurityMethodsEnabled = this.hasAnySecurityMethod(securityMethods);
        const hasLegacy2FA = !!(userData?.isTwoFactorEnabled && userData?.twoFactorSecret);

        if (!hasSecurityMethodsEnabled && !hasLegacy2FA) {
            return true;
        }

        const isVerificationRequired = await this.checkVerificationRequired(
            request, userData, hasLegacy2FA
        );
        if (!isVerificationRequired) {
            return true;
        }

        if (await this.tryValidateSecurityCredentials(request, user.id, userData)) {
            return true;
        }

        const availableMethods = this.getAvailableMethods(securityMethods, userData);
        throw new UserForbiddenException(
            JSON.stringify({
                code: "SECURITY_VERIFICATION_REQUIRED",
                message: "Security verification is required for this transaction",
                availableMethods,
                requiredCount: userData?.requiredMethodCount || 1,
            }),
            HttpStatus.FORBIDDEN
        );
    }

    private async fetchUserSecurityData(userId: number) {
        return this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                twoFactorSecret: true,
                isTwoFactorEnabled: true,
                tier: true,
                securityMethods: true,
                requiredMethodCount: true,
                tradingPassword: true,
                isPhoneVerified: true,
                isEmailVerified: true,
            },
        });
    }

    /**
     * Check if verification is required based on transaction data and tier
     */
    private async checkVerificationRequired(
        request: RequestWithUser,
        userData: any,
        hasLegacy2FA: boolean | null | undefined
    ): Promise<boolean> {
        const { body, path } = request;
        const transactionData = extractTransactionDataFromRoute(body, path);

        if (transactionData && hasLegacy2FA) {
            return this.isTransactionVerificationRequired(transactionData, userData);
        }
        return true;
    }

    /**
     * Try to validate security credentials from the request
     */
    private async tryValidateSecurityCredentials(
        request: RequestWithUser,
        userId: number,
        userData: any
    ): Promise<boolean> {
        const verificationToken = this.extractVerificationToken(request);
        const legacyCode = this.extractLegacyCode(request);
        const routeTemplate = this.getRequestRouteTemplate(request);

        const isMultiFactorValid = await this.verifyMultiFactorTokens(
            userId,
            verificationToken ?? "",
            userData,
            routeTemplate,
        );
        if (isMultiFactorValid) return true;

        const isLegacyValid = await this.verifyLegacyTransactionCode(userId, legacyCode, userData);
        if (isLegacyValid) {
            this.logger.debug(`User ${userId}: Valid legacy 2FA code, allowing transaction`);
            return true;
        }

        return false;
    }

    /**
     * Extract verification token from request
     */
    private extractVerificationToken(request: RequestWithUser): string | null {
        // Check header first (preferred)
        const headerToken = request.headers["x-security-token"] as string;
        if (headerToken) return headerToken;

        // Check body
        if (request.body?.verificationToken) return request.body.verificationToken;

        return null;
    }

    private extractLegacyCode(request: RequestWithUser): string | null {
        const bodyCode = request.body?.twoFactorCode;
        if (typeof bodyCode === "string") {
            return bodyCode;
        }

        const headerCode = request.headers["x-2fa-code"];
        if (typeof headerCode === "string") {
            return headerCode;
        }

        return null;
    }

    private async verifyLegacyTransactionCode(
        userId: number,
        legacyCode: string | null,
        userData: any,
    ): Promise<boolean> {
        if (!legacyCode || legacyCode.length > 6 || !userData?.twoFactorSecret) {
            return false;
        }

        const isValidLegacy = await this.validateLegacyTwoFactor(userId, legacyCode, userData.twoFactorSecret);
        const requiredCount = userData?.requiredMethodCount || 1;
        return isValidLegacy && requiredCount <= 1;
    }

    private async isTransactionVerificationRequired(
        transactionData: { amount: number; currency: string },
        userData: { tier: number; isTwoFactorEnabled: boolean },
    ): Promise<boolean> {
        const rate = await this.getCryptoRateToNGN(transactionData.currency);
        if (!rate) return true;

        const amountNGN = convertToNGN(transactionData.amount, rate);
        return isTwoFactorRequiredForTransaction(
            userData.tier,
            amountNGN,
            userData.isTwoFactorEnabled,
        );
    }

    private async verifyMultiFactorTokens(
        userId: number,
        verificationToken: string,
        userData: { requiredMethodCount?: number },
        routeTemplate: string,
    ): Promise<boolean> {
        const tokens = verificationToken.split(',');
        const verifiedMethods = new Set<string>();

        for (const token of tokens) {
            if (!token.trim()) continue;

            const method = await this.validateVerificationTokenAndGetMethod(userId, token.trim());
            if (!method) {
                this.logger.warn(`User ${userId}: Invalid verification token(s) provided`);
                return false;
            }

            verifiedMethods.add(method);
        }

        const requiredCount = userData?.requiredMethodCount || 1;

        if (verifiedMethods.size >= requiredCount) {
            this.logger.debug(`User ${userId}: Verified ${verifiedMethods.size}/${requiredCount} methods (${Array.from(verifiedMethods).join(', ')}), allowing transaction`);
            return true;
        }

        this.logger.warn(`User ${userId}: Insufficient methods verified. Got ${verifiedMethods.size}, required ${requiredCount}`);
        return false;
    }

    private getRequestRouteTemplate(request: RequestWithUser): string {
        const routePath = request.route?.path;
        if (typeof routePath === "string") {
            return routePath;
        }

        if (Array.isArray(routePath)) {
            const firstPath = routePath.find((path) => typeof path === "string");
            if (firstPath) {
                return firstPath;
            }
        }

        return request.path ?? "";
    }

    /**
     * Validate a verification token and return the method used
     */
    private async validateVerificationTokenAndGetMethod(userId: number, token: string): Promise<string | null> {
        try {
            const payload = await this.jwtService.verifyAsync(token, {
                secret: jwtSecret,
            });

            // Check that token is for the correct user
            if (payload.userId !== userId) {
                this.logger.warn(`Token userId ${payload.userId} does not match request userId ${userId}`);
                return null;
            }

            // Check token type
            if (payload.type !== "transaction_verification") {
                this.logger.warn(`Invalid token type: ${payload.type}`);
                return null;
            }

            // Check expiry
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                this.logger.warn(`Token expired at ${payload.exp}, current time ${now}`);
                return null;
            }

            this.logger.debug(`Valid verification token for user ${userId}, method: ${payload.method}`);
            return payload.method;
        } catch (error) {
            this.logger.warn(`Token validation error: ${error.message}`);
            return null;
        }
    }

    /**
     * Validate legacy TOTP code (backward compatibility)
     */
    private async validateLegacyTwoFactor(userId: number, code: string, secret: string): Promise<boolean> {
        // Check rate limit if service available
        if (this.twoFactorRateLimitService) {
            const rateLimitResult = await this.twoFactorRateLimitService.checkAttempt(
                userId.toString(),
                'transaction'
            );

            if (!rateLimitResult.allowed) {
                throw new UserForbiddenException(
                    `Too many failed 2FA attempts. Account locked for ${rateLimitResult.lockoutDuration} seconds.`,
                    HttpStatus.TOO_MANY_REQUESTS
                );
            }
        }

        // Try TOTP code first
        let isValid = authenticator.verify({
            token: code,
            secret: decryptField(secret),
        });

        // If TOTP fails and settingService available, try backup code
        if (!isValid && this.settingService) {
            isValid = await this.settingService.verifyBackupCode(userId, code);
        }

        if (!isValid) {
            // Record failed attempt if service available
            if (this.twoFactorRateLimitService) {
                const failedResult = await this.twoFactorRateLimitService.recordFailedAttempt(
                    userId.toString(),
                    'transaction'
                );

                if (failedResult.lockoutEndsAt) {
                    throw new UserForbiddenException(
                        `Invalid 2FA code. Account locked for ${failedResult.lockoutDuration} seconds.`,
                        HttpStatus.TOO_MANY_REQUESTS
                    );
                }
            }
            return false;
        }

        // Record successful attempt if service available
        if (this.twoFactorRateLimitService) {
            await this.twoFactorRateLimitService.recordSuccessfulAttempt(
                userId.toString(),
                'transaction'
            );
        }

        return true;
    }

    /**
     * Parse security methods from database (stored as JSON)
     */
    private parseSecurityMethods(methods: any): SecurityMethods {
        if (!methods) return {};
        if (typeof methods === 'string') {
            try {
                return JSON.parse(methods);
            } catch {
                return {};
            }
        }
        return methods as SecurityMethods;
    }

    /**
     * Check if user has any security methods enabled
     */
    private hasAnySecurityMethod(methods: SecurityMethods): boolean {
        return methods.sms || methods.email || methods.authenticator || methods.tradingPassword || methods.biometric || false;
    }

    /**
     * Get list of available methods for user based on their setup
     */
    private getAvailableMethods(methods: SecurityMethods, userData: any): string[] {
        const available: string[] = [];

        if (methods.sms && userData?.isPhoneVerified) {
            available.push('sms');
        }
        if (methods.email && userData?.isEmailVerified) {
            available.push('email');
        }
        if (methods.authenticator && userData?.twoFactorSecret) {
            available.push('authenticator');
        }
        if (methods.tradingPassword && userData?.tradingPassword) {
            available.push('tradingPassword');
        }
        if (methods.biometric) {
            // Biometric is available if the user has it enabled in preferences
            // The frontend handles checking if the device actually supports it
            available.push('biometric');
        }

        // Backup codes are always available if any method is set up
        if (available.length > 0) {
            available.push('backupCode');
        }

        return available;
    }
    private async getCryptoRateToNGN(currency: string): Promise<number | null> {
        try {
            const rate = await this.prisma.cryptoRate.findFirst({
                where: {
                    currency: currency,
                },
                select: { buyRate: true },
                orderBy: { createdAt: 'desc' },
            });

            return rate?.buyRate || null;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(`Failed to load crypto rate for ${currency}: ${errorMessage}`);
            return null;
        }
    }
}
