
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
import { createHmac, timingSafeEqual } from "crypto";
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
import { isTwoFactorRequiredForTransaction, convertToNGN } from "../utils/tier-threshold.util";
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
    ) { }

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
    private readonly TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

    canActivate(
        context: ExecutionContext
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as RequestFromQuidax;

        const quidaxSignature = request.headers["quidax-signature"] as string;

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
        const webhookTimestamp = parseInt(timestamp, 10);
        const now = Math.floor(Date.now() / 1000);
        const timeDifference = Math.abs(now - webhookTimestamp);

        if (timeDifference > this.TIMESTAMP_TOLERANCE_SECONDS) {
            this.logger.error(`[WEBHOOK AUTH] SECURITY: Timestamp too old/future (${timeDifference}s difference)`);
            this.logger.warn(`[WEBHOOK AUTH] Possible replay attack for event: ${request.body?.event}`);
            return false;
        }

        // Use raw body if available (NestJS rawBody:true provides a Buffer), otherwise fallback
        const rawBuf = (request as any).rawBody;
        const requestBody = rawBuf ? (Buffer.isBuffer(rawBuf) ? rawBuf.toString() : rawBuf) : JSON.stringify(request.body);
        const payload = `${timestamp}.${requestBody}`;

        const expectedSignature = crypto
            .createHmac("sha256", quidaxConfig.webhook_key)
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

            const isValid = crypto.timingSafeEqual(signatureBuffer, expectedBuffer);

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
    ): boolean | Promise<boolean> | Observable<boolean> {
        const request = context
            .switchToHttp()
            .getRequest() as Request;
        // Fincra uses "signature" header (per their documentation), not "x-fincra-signature"
        const signature = (request.headers["signature"] || request.headers["x-fincra-signature"]) as string;
        const secret = process.env.FINCRA_WEBHOOK_SECRET;

        this.logger.log(`Received Fincra webhook request`);
        this.logger.debug(`Event: ${(request.body as any)?.event}`);

        // Require signature for security
        if (!signature) {
            this.logger.error('SECURITY: Fincra webhook rejected - no signature header');
            return false;
        }

        // Require secret to be configured
        if (!secret) {
            this.logger.error('SECURITY: FINCRA_WEBHOOK_SECRET not configured - rejecting webhook');
            return false;
        }

        const computed = createHmac("sha512", secret)
            .update(JSON.stringify(request.body))
            .digest("hex");

        // Use timing-safe comparison to prevent timing attacks
        let isValid = false;
        try {
            // Both strings must be same length for timingSafeEqual
            if (computed.length === signature.length) {
                isValid = timingSafeEqual(
                    Buffer.from(computed, 'utf8'),
                    Buffer.from(signature, 'utf8')
                );
            }
        } catch {
            isValid = false;
        }

        if (isValid) {
            this.logger.log(`Signature verified for event: ${(request.body as any)?.event}`);
        } else {
            this.logger.error(`SECURITY: Fincra webhook rejected - invalid signature`);
        }

        return isValid;
    }
}


// In-memory cache for GeoIP lookups to reduce Redis load
const geoIpMemoryCache = new Map<string, { countryCode: string; expiresAt: number }>();
const GEOIP_MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in memory
const GEOIP_MEMORY_CACHE_MAX_SIZE = 500;

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
        private jwtService: JwtService,
        private prisma: PrismaService
    ) { }

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
        patterns: ["request-instant-swap-quote", "refresh-instant-swap-quote", "estimate-swap"],
        category: OrderCategory.SWAP,
        getAmount: (body) => body.from_amount || body.to_amount,
        getCurrency: (body) =>
            body.from_amount
                ? body.from_currency?.toUpperCase()
                : body.to_currency?.toUpperCase(),
    },
    {
        patterns: ["execute-atomic-swap"],
        category: OrderCategory.SWAP,
        getAmount: (body) => body.from_amount,
        getCurrency: (body) => body.from_currency?.toUpperCase(),
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
        private prisma: PrismaService,
        private jwtService: JwtService,
        @Optional() private twoFactorRateLimitService?: any,
        @Optional() private settingService?: any
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

        // Get user data including security preferences
        const userData = await this.prisma.user.findUnique({
            where: { id: user.id },
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

        // Parse security methods
        const securityMethods = this.parseSecurityMethods(userData?.securityMethods);
        const hasSecurityMethodsEnabled = this.hasAnySecurityMethod(securityMethods);
        const hasLegacy2FA = userData?.isTwoFactorEnabled && userData?.twoFactorSecret;

        // If no security methods enabled and no legacy 2FA, allow transaction
        if (!hasSecurityMethodsEnabled && !hasLegacy2FA) {
            this.logger.debug(`User ${user.id}: No security methods enabled, allowing transaction`);
            return true;
        }

        // Extract transaction data from request
        const { body, path } = request;
        const transactionData = this.extractTransactionData(body, path);

        // Determine if security verification is required based on tier and amount
        let isVerificationRequired = true;

        if (transactionData && hasLegacy2FA) {
            // Get crypto rate to convert to NGN for tier-based threshold check
            const rate = await this.getCryptoRateToNGN(transactionData.currency);

            if (rate) {
                const amountNGN = convertToNGN(transactionData.amount, rate);
                isVerificationRequired = isTwoFactorRequiredForTransaction(
                    userData.tier,
                    amountNGN,
                    userData.isTwoFactorEnabled
                );
            }
        }

        // If verification is not required based on tier/amount, allow transaction
        if (!isVerificationRequired) {
            this.logger.debug(`User ${user.id}: Verification not required based on tier/amount`);
            return true;
        }

        // Try to get verification token from request
        let verificationToken = this.extractVerificationToken(request);
        const legacyCode = request.body?.twoFactorCode || request.headers["x-2fa-code"];

        // Smart detection: If legacy code looks like a JWT (long string), treat it as a verification token
        // This avoids needing to refactor all frontend callsites that send "twoFactorCode"
        if (!verificationToken && legacyCode && legacyCode.length > 20) {
            verificationToken = legacyCode;
        }

        // CASE 1: New multi-factor verification token present
        if (verificationToken) {
            // Support comma-separated tokens for multi-method verification
            const tokens = verificationToken.split(',');
            const verifiedMethods = new Set<string>();
            let allTokensValid = true;

            for (const token of tokens) {
                if (!token.trim()) continue;

                const method = await this.validateVerificationTokenAndGetMethod(user.id, token.trim());
                if (method) {
                    verifiedMethods.add(method);
                } else {
                    allTokensValid = false;
                    break;
                }
            }

            if (allTokensValid) {
                // Check if we have enough unique methods
                let requiredCount = userData?.requiredMethodCount || 1;

                // SPECIAL CASE: Swap transactions are exempt from multi-method requirements
                // and should default to single 2FA (Authenticator) due to timing constraints.
                if (request.url.includes('execute-atomic-swap')) {
                    this.logger.debug(`User ${user.id}: Swap transaction detected, overriding requiredMethodCount to 1`);
                    requiredCount = 1;
                }

                if (verifiedMethods.size >= requiredCount) {
                    this.logger.debug(`User ${user.id}: Verified ${verifiedMethods.size}/${requiredCount} methods (${Array.from(verifiedMethods).join(', ')}), allowing transaction`);
                    return true;
                } else {
                    this.logger.warn(`User ${user.id}: Insufficient methods verified. Got ${verifiedMethods.size}, required ${requiredCount}`);
                }
            } else {
                this.logger.warn(`User ${user.id}: Invalid verification token(s) provided`);
            }
        }

        // CASE 2: Legacy TOTP code present (backward compatibility)
        if (legacyCode && legacyCode.length <= 6 && userData?.twoFactorSecret) {
            const isValidLegacy = await this.validateLegacyTwoFactor(user.id, legacyCode, userData.twoFactorSecret);
            if (isValidLegacy) {
                // Legacy flow only supports 1 method (Authenticator)
                // If user requires > 1 method, this flow is insufficient unless they only have authenticator enabled
                const requiredCount = userData?.requiredMethodCount || 1;
                if (requiredCount <= 1) {
                    this.logger.debug(`User ${user.id}: Valid legacy 2FA code, allowing transaction`);
                    return true;
                }
            }
        }

        // No valid verification - determine what methods are available and respond accordingly
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
            secret: secret,
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
            return null;
        }
    }
}
