import { Test, TestingModule } from "@nestjs/testing";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHmac } from "node:crypto";
import { authenticator } from "otplib";
import { quidaxConfig } from "@/config";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

jest.mock("request-ip", () => ({
    getClientIp: jest.fn().mockReturnValue("1.2.3.4"),
}));

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class { server = { to: jest.fn() } },
}));

jest.mock("@/config", () => ({
    jwtSecret: "test-jwt-value",
    quidaxConfig: { webhook_key: "test-hmac-value" },
    blockedCountries: ["KP", "IR"],
    isProduction: false,
    isProdEnvironment: false,
}));

jest.mock("moment-logger", () => ({ error: jest.fn(), warn: jest.fn() }));

jest.mock("@/utils", () => ({
    decryptField: jest.fn((value: string) => value),
    __esModule: true,
}));

import {
    AuthGuard,
    EnabledAccountGuard,
    QuidaxWebhookGuard,
    FincraWebhookGuard,
    CountryBlockGuard,
    SocketAuthGuard,
    TransactionAmountGuard,
    TwoFactorGuard,
} from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { GeoIPService } from "@/modules/core/geoip/geoip.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { SessionService } from "@/modules/api/session/services";
import { TransactionService } from "../../services/transaction.service";

// Helper to create mock ExecutionContext
function mockContext(overrides: {
    headers?: Record<string, any>;
    body?: any;
    path?: string;
    user?: any;
    query?: any;
} = {}) {
    const request = {
        headers: overrides.headers ?? {},
        body: overrides.body ?? {},
        path: overrides.path ?? "/",
        user: overrides.user ?? undefined,
    };

    const client = {
        handshake: { query: overrides.query ?? {} },
        data: {},
    };

    return {
        switchToHttp: () => ({
            getRequest: () => request,
        }),
        switchToWs: () => ({
            getClient: () => client,
        }),
    } as unknown as ExecutionContext;
}

// ==================== AuthGuard ====================

describe("AuthGuard", () => {
    let guard: AuthGuard;
    let jwtService: any;
    let prisma: any;
    let sessionService: any;

    beforeEach(async () => {
        jwtService = { verifyAsync: jest.fn() };
        prisma = {
            user: { findUnique: jest.fn() },
        };
        sessionService = {
            validateSession: jest.fn().mockResolvedValue(true),
            touchSessionActivity: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthGuard,
                { provide: JwtService, useValue: jwtService },
                { provide: PrismaService, useValue: prisma },
                { provide: SessionService, useValue: sessionService },
            ],
        }).compile();

        guard = module.get<AuthGuard>(AuthGuard);
    });

    it("should throw if no authorization header", async () => {
        const ctx = mockContext({ headers: {} });
        await expect(guard.canActivate(ctx)).rejects.toThrow("Authorization header is missing");
    });

    it("should throw for invalid token format", async () => {
        const ctx = mockContext({ headers: { authorization: "Basic abc" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("Authorization header is missing");
    });

    it("should throw if JWT verification fails", async () => {
        jwtService.verifyAsync.mockRejectedValue(new Error("invalid"));
        const ctx = mockContext({ headers: { authorization: "Bearer bad-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow();
    });

    it("should throw if user not found", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "999" });
        prisma.user.findUnique.mockResolvedValue(null);

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("unauthorized");
    });

    it("should throw if user is deleted", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1" });
        prisma.user.findUnique.mockResolvedValue({ id: 1, isDeleted: true });

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("Account not found");
    });

    it("should throw if session is invalid", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1", sessionId: "sess-1" });
        prisma.user.findUnique.mockResolvedValue({ id: 1, isDeleted: false });
        sessionService.validateSession.mockResolvedValue(false);

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow();
    });

    it("should return true for valid token + user + session", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1", sessionId: "sess-1" });
        prisma.user.findUnique.mockResolvedValue({ id: 1, isDeleted: false, role: { name: "user" } });
        sessionService.validateSession.mockResolvedValue(true);

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should work without sessionId (legacy tokens)", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1" });
        prisma.user.findUnique.mockResolvedValue({ id: 1, isDeleted: false, role: { name: "user" } });

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should handle PrismaClientKnownRequestError", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1" });
        const err = new Error("prisma error");
        err.name = "PrismaClientKnownRequestError";
        prisma.user.findUnique.mockRejectedValue(err);

        const ctx = mockContext({ headers: { authorization: "Bearer valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("Unable to process request");
    });
});

// ==================== EnabledAccountGuard ====================

describe("EnabledAccountGuard", () => {
    let guard: EnabledAccountGuard;

    beforeEach(() => {
        guard = new EnabledAccountGuard();
    });

    it("should return true if user is not blocked", async () => {
        const ctx = mockContext({ user: { accountStatus: "ACTIVE" } });
        (ctx.switchToHttp().getRequest() as any).user = { accountStatus: "ACTIVE" };
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should throw if user is blocked", async () => {
        const ctx = mockContext();
        (ctx.switchToHttp().getRequest() as any).user = { accountStatus: "BLOCKED" };
        await expect(guard.canActivate(ctx)).rejects.toThrow("Account is blocked");
    });
});

// ==================== QuidaxWebhookGuard ====================

describe("QuidaxWebhookGuard", () => {
    let guard: QuidaxWebhookGuard;

    beforeEach(() => {
        guard = new QuidaxWebhookGuard();
    });

    it("should reject if no signature header", () => {
        const ctx = mockContext({ headers: {}, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should reject simple (non-HMAC) signature format", () => {
        const ctx = mockContext({ headers: { "quidax-signature": "simple-sig-no-comma" }, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should reject if missing t= or s= format", () => {
        const ctx = mockContext({ headers: { "quidax-signature": "a=1,b=2" }, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should reject expired timestamps", () => {
        const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
        const ctx = mockContext({ headers: { "quidax-signature": `t=${oldTimestamp},s=invalidsig` }, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should accept valid HMAC signature", () => {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const body = { event: "test_event" };
        const payload = `${timestamp}.${JSON.stringify(body)}`;
        const sig = createHmac("sha256", quidaxConfig.webhook_key).update(payload).digest("hex");

        const ctx = mockContext({
            headers: { "quidax-signature": `t=${timestamp},s=${sig}` },
            body,
        });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it("should reject mismatched HMAC signature", () => {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const ctx = mockContext({
            headers: { "quidax-signature": `t=${timestamp},s=bad_signature_here` },
            body: { event: "test" },
        });
        expect(guard.canActivate(ctx)).toBe(false);
    });
});

// ==================== FincraWebhookGuard ====================

describe("FincraWebhookGuard", () => {
    let guard: FincraWebhookGuard;
    const FINCRA_SECRET = process.env.FINCRA_WEBHOOK_SECRET || "test-value";

    beforeEach(() => {
        guard = new FincraWebhookGuard();
        process.env.FINCRA_WEBHOOK_SECRET = FINCRA_SECRET;
    });

    afterEach(() => {
        delete process.env.FINCRA_WEBHOOK_SECRET;
    });

    it("should reject if no signature header", () => {
        const ctx = mockContext({ headers: {}, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should reject if no webhook secret configured", () => {
        delete process.env.FINCRA_WEBHOOK_SECRET;
        const ctx = mockContext({ headers: { signature: "sig" }, body: {} });
        expect(guard.canActivate(ctx)).toBe(false);
    });

    it("should accept valid sha512 HMAC signature", () => {
        const body = { event: "payment.success" };
        const bodyStr = JSON.stringify(body);
        const sig = createHmac("sha512", FINCRA_SECRET).update(Buffer.from(bodyStr)).digest("hex");

        const ctx = mockContext({ headers: { signature: sig }, body });
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it("should reject invalid signature", () => {
        const ctx = mockContext({ headers: { signature: "invalid-sig" }, body: { event: "test" } });
        expect(guard.canActivate(ctx)).toBe(false);
    });
});

// ==================== CountryBlockGuard ====================

describe("CountryBlockGuard", () => {
    let guard: CountryBlockGuard;
    let geoIpService: any;
    let redisCache: any;

    beforeEach(async () => {
        geoIpService = { getCountryCode: jest.fn() };
        redisCache = {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CountryBlockGuard,
                { provide: GeoIPService, useValue: geoIpService },
                { provide: RedisCacheService, useValue: redisCache },
            ],
        }).compile();

        guard = module.get<CountryBlockGuard>(CountryBlockGuard);
    });

    it("should allow non-blocked countries", async () => {
        // Use a unique IP to avoid memory cache collisions
        const requestIp = require("request-ip");
        requestIp.getClientIp.mockReturnValue("2.2.2.2");
        geoIpService.getCountryCode.mockReturnValue("US");
        const ctx = mockContext();
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should block listed countries", async () => {
        const requestIp = require("request-ip");
        requestIp.getClientIp.mockReturnValue("3.3.3.3");
        geoIpService.getCountryCode.mockReturnValue("KP");
        const ctx = mockContext();
        await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });

    it("should use Redis-cached country code", async () => {
        const requestIp = require("request-ip");
        requestIp.getClientIp.mockReturnValue("4.4.4.4");
        redisCache.get.mockResolvedValue("US");
        const ctx = mockContext();
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
        expect(geoIpService.getCountryCode).not.toHaveBeenCalled();
    });
});

// ==================== TransactionAmountGuard ====================

describe("TransactionAmountGuard", () => {
    let guard: TransactionAmountGuard;
    let transactionService: any;

    beforeEach(async () => {
        transactionService = {
            validateTransaction: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TransactionAmountGuard,
                { provide: TransactionService, useValue: transactionService },
            ],
        }).compile();

        guard = module.get<TransactionAmountGuard>(TransactionAmountGuard);
    });

    it("should throw if no user in request", async () => {
        const ctx = mockContext({ path: "/api/v1/buy/order", body: { amount: 1, asset: "btc" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow();
    });

    it("should throw if transaction data cannot be extracted", async () => {
        const ctx = mockContext({
            path: "/api/v1/unknown-route",
            body: {},
            user: { id: 1 },
        });
        (ctx.switchToHttp().getRequest() as any).user = { id: 1 };
        await expect(guard.canActivate(ctx)).rejects.toThrow();
    });

    it("should call validateTransaction for buy order", async () => {
        const user = { id: 1 };
        const ctx = mockContext({
            path: "/api/v1/buy/order",
            body: { amount: 100, asset: "btc" },
            user,
        });
        (ctx.switchToHttp().getRequest() as any).user = user;
        transactionService.validateTransaction.mockResolvedValue(undefined);

        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
        expect(transactionService.validateTransaction).toHaveBeenCalledWith(
            user, 100, "BTC", "BUY", "/api/v1/buy/order"
        );
    });

    it("should call validateTransaction for sell order", async () => {
        const user = { id: 1 };
        const ctx = mockContext({
            path: "/api/v1/sell/order",
            body: { amount: 50, asset: "eth" },
            user,
        });
        (ctx.switchToHttp().getRequest() as any).user = user;
        transactionService.validateTransaction.mockResolvedValue(undefined);

        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should call validateTransaction for swap", async () => {
        const user = { id: 1 };
        const ctx = mockContext({
            path: "/api/v1/request-instant-swap-quote",
            body: { from_amount: 10, from_currency: "btc" },
            user,
        });
        (ctx.switchToHttp().getRequest() as any).user = user;
        transactionService.validateTransaction.mockResolvedValue(undefined);

        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should call validateTransaction for send/withdraw", async () => {
        const user = { id: 1 };
        const ctx = mockContext({
            path: "/api/v1/withdrawer-request",
            body: { amount: 500, currency: "usdt" },
            user,
        });
        (ctx.switchToHttp().getRequest() as any).user = user;
        transactionService.validateTransaction.mockResolvedValue(undefined);

        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });
});

// ==================== TwoFactorGuard ====================

describe("TwoFactorGuard", () => {
    let guard: TwoFactorGuard;
    let prisma: any;
    let jwtService: any;
    let rateLimitService: any;
    let settingService: any;

    beforeEach(() => {
        prisma = {
            user: { findUnique: jest.fn() },
            cryptoRate: { findFirst: jest.fn() },
        };
        jwtService = { verifyAsync: jest.fn() };
        rateLimitService = {
            checkAttempt: jest.fn().mockResolvedValue({ allowed: true }),
            recordFailedAttempt: jest.fn().mockResolvedValue({}),
            recordSuccessfulAttempt: jest.fn().mockResolvedValue(undefined),
        };
        settingService = {
            verifyBackupCode: jest.fn().mockResolvedValue(false),
        };

        guard = new TwoFactorGuard(
            prisma as any,
            jwtService as any,
            rateLimitService,
            settingService,
        );

        jest.spyOn((guard as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((guard as any).logger, "warn").mockImplementation(() => undefined);
    });

    it("should throw when request user is missing", async () => {
        const ctx = mockContext({ path: "/api/v1/buy/order", body: { amount: 1, asset: "btc" } });

        await expect(guard.canActivate(ctx)).rejects.toThrow("User not found in request");
    });

    it("should allow when no security method is enabled", async () => {
        const ctx = mockContext({ user: { id: 1 }, path: "/api/v1/buy/order", body: { amount: 1, asset: "btc" } });
        (ctx.switchToHttp().getRequest() as any).user = { id: 1 };
        prisma.user.findUnique.mockResolvedValue({
            securityMethods: null,
            isTwoFactorEnabled: false,
            twoFactorSecret: null,
        });

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("should allow when verification is not required", async () => {
        const ctx = mockContext({ user: { id: 2 }, path: "/api/v1/buy/order", body: { amount: 1, asset: "btc" } });
        (ctx.switchToHttp().getRequest() as any).user = { id: 2 };
        prisma.user.findUnique.mockResolvedValue({
            securityMethods: { authenticator: true },
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
        });
        jest.spyOn(guard as any, "checkVerificationRequired").mockResolvedValue(false);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("should allow when security credentials are valid", async () => {
        const ctx = mockContext({ user: { id: 3 }, path: "/api/v1/buy/order", body: { verificationToken: "a" } });
        (ctx.switchToHttp().getRequest() as any).user = { id: 3 };
        prisma.user.findUnique.mockResolvedValue({
            securityMethods: { sms: true },
            isTwoFactorEnabled: false,
            twoFactorSecret: null,
            requiredMethodCount: 1,
            isPhoneVerified: true,
        });
        jest.spyOn(guard as any, "checkVerificationRequired").mockResolvedValue(true);
        jest.spyOn(guard as any, "tryValidateSecurityCredentials").mockResolvedValue(true);

        await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("should reject when security verification fails", async () => {
        const ctx = mockContext({ user: { id: 4 }, path: "/api/v1/buy/order", body: {} });
        (ctx.switchToHttp().getRequest() as any).user = { id: 4 };
        prisma.user.findUnique.mockResolvedValue({
            securityMethods: { sms: true, email: true },
            isTwoFactorEnabled: true,
            twoFactorSecret: "secret",
            requiredMethodCount: 2,
            isPhoneVerified: true,
            isEmailVerified: true,
        });
        jest.spyOn(guard as any, "checkVerificationRequired").mockResolvedValue(true);
        jest.spyOn(guard as any, "tryValidateSecurityCredentials").mockResolvedValue(false);

        await expect(guard.canActivate(ctx)).rejects.toThrow("SECURITY_VERIFICATION_REQUIRED");
    });

    it("should parse security methods and extract tokens", () => {
        expect((guard as any).parseSecurityMethods({ sms: true })).toEqual({ sms: true });
        expect((guard as any).parseSecurityMethods('{"email":true}')).toEqual({ email: true });
        expect((guard as any).parseSecurityMethods("bad-json")).toEqual({});

        const req = {
            headers: { "x-security-token": "header-token", "x-2fa-code": "222222" },
            body: { verificationToken: "body-token", twoFactorCode: "111111" },
        };

        expect((guard as any).extractVerificationToken(req)).toBe("header-token");
        expect((guard as any).extractLegacyCode(req)).toBe("111111");
    });

    it("should validate token payload shape and expiry", async () => {
        jwtService.verifyAsync.mockResolvedValueOnce({ userId: 9, type: "transaction_verification", method: "sms", exp: Math.floor(Date.now() / 1000) + 100 });
        await expect((guard as any).validateVerificationTokenAndGetMethod(9, "tok")).resolves.toBe("sms");

        jwtService.verifyAsync.mockResolvedValueOnce({ userId: 10, type: "transaction_verification", method: "sms", exp: Math.floor(Date.now() / 1000) + 100 });
        await expect((guard as any).validateVerificationTokenAndGetMethod(9, "tok")).resolves.toBeNull();

        jwtService.verifyAsync.mockResolvedValueOnce({ userId: 9, type: "wrong_type", method: "sms", exp: Math.floor(Date.now() / 1000) + 100 });
        await expect((guard as any).validateVerificationTokenAndGetMethod(9, "tok")).resolves.toBeNull();

        jwtService.verifyAsync.mockResolvedValueOnce({ userId: 9, type: "transaction_verification", method: "sms", exp: Math.floor(Date.now() / 1000) - 1 });
        await expect((guard as any).validateVerificationTokenAndGetMethod(9, "tok")).resolves.toBeNull();

        jwtService.verifyAsync.mockRejectedValueOnce(new Error("bad token"));
        await expect((guard as any).validateVerificationTokenAndGetMethod(9, "tok")).resolves.toBeNull();
    });

    it("should validate multi-factor token counts with swap override", async () => {
        jest.spyOn(guard as any, "validateVerificationTokenAndGetMethod")
            .mockResolvedValueOnce("sms")
            .mockResolvedValueOnce("email")
            .mockResolvedValueOnce("sms");

        await expect(
            (guard as any).verifyMultiFactorTokens(1, "a,b", { requiredMethodCount: 2 }, "/api/v1/buy/order"),
        ).resolves.toBe(true);

        await expect(
            (guard as any).verifyMultiFactorTokens(1, "c", { requiredMethodCount: 2 }, "/api/v1/execute-atomic-swap"),
        ).resolves.toBe(true);
    });

    it("should return fallback path when route template is unavailable", () => {
        const request = { route: undefined, path: "/api/v1/fallback" };

        expect((guard as any).getRequestRouteTemplate(request)).toBe("/api/v1/fallback");
    });

    it("should handle legacy 2FA validation and rate limits", async () => {
        const verifySpy = jest.spyOn(authenticator, "verify").mockReturnValueOnce(false).mockReturnValueOnce(true);
        settingService.verifyBackupCode.mockResolvedValueOnce(true);

        await expect((guard as any).validateLegacyTwoFactor(7, "123456", "secret")).resolves.toBe(true);
        await expect((guard as any).validateLegacyTwoFactor(7, "123456", "secret")).resolves.toBe(true);
        expect(rateLimitService.recordSuccessfulAttempt).toHaveBeenCalled();

        rateLimitService.checkAttempt.mockResolvedValueOnce({ allowed: false, lockoutDuration: 60 });
        await expect((guard as any).validateLegacyTwoFactor(7, "123456", "secret")).rejects.toThrow("Too many failed 2FA attempts");

        verifySpy.mockReturnValueOnce(false);
        settingService.verifyBackupCode.mockResolvedValueOnce(false);
        rateLimitService.checkAttempt.mockResolvedValueOnce({ allowed: true });
        rateLimitService.recordFailedAttempt.mockResolvedValueOnce({ lockoutEndsAt: 1, lockoutDuration: 120 });
        await expect((guard as any).validateLegacyTwoFactor(7, "123456", "secret")).rejects.toThrow("Invalid 2FA code. Account locked for 120 seconds.");

        verifySpy.mockReturnValueOnce(false);
        settingService.verifyBackupCode.mockResolvedValueOnce(false);
        rateLimitService.checkAttempt.mockResolvedValueOnce({ allowed: true });
        rateLimitService.recordFailedAttempt.mockResolvedValueOnce({});
        await expect((guard as any).validateLegacyTwoFactor(7, "123456", "secret")).resolves.toBe(false);

        verifySpy.mockRestore();
    });

    it("should expose all enabled available security methods", () => {
        const methods = {
            sms: true,
            email: true,
            authenticator: true,
            tradingPassword: true,
            biometric: true,
        };

        const available = (guard as any).getAvailableMethods(methods, {
            isPhoneVerified: true,
            isEmailVerified: true,
            twoFactorSecret: "secret",
            tradingPassword: "hashed",
        });

        expect(available).toEqual([
            "sms",
            "email",
            "authenticator",
            "tradingPassword",
            "biometric",
            "backupCode",
        ]);
    });

    it("should resolve crypto rates and safely handle lookup failures", async () => {
        prisma.cryptoRate.findFirst.mockResolvedValueOnce({ buyRate: 1200 });
        prisma.cryptoRate.findFirst.mockRejectedValueOnce(new Error("db issue"));

        await expect((guard as any).getCryptoRateToNGN("BTC")).resolves.toBe(1200);
        await expect((guard as any).getCryptoRateToNGN("ETH")).resolves.toBeNull();
    });
});

// ==================== SocketAuthGuard ====================

describe("SocketAuthGuard", () => {
    let guard: SocketAuthGuard;
    let jwtService: any;
    let prisma: any;

    beforeEach(async () => {
        jwtService = { verifyAsync: jest.fn() };
        prisma = { user: { findUnique: jest.fn() } };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SocketAuthGuard,
                { provide: JwtService, useValue: jwtService },
                { provide: PrismaService, useValue: prisma },
            ],
        }).compile();

        guard = module.get<SocketAuthGuard>(SocketAuthGuard);
    });

    it("should throw if no token in handshake", async () => {
        const ctx = mockContext({ query: {} });
        await expect(guard.canActivate(ctx)).rejects.toThrow("unauthorized");
    });

    it("should throw if user not found", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "999" });
        prisma.user.findUnique.mockResolvedValue(null);

        const ctx = mockContext({ query: { token: "valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("unauthorized");
    });

    it("should return true for valid token and user", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1" });
        prisma.user.findUnique.mockResolvedValue({ id: 1 });

        const ctx = mockContext({ query: { token: "valid-token" } });
        const result = await guard.canActivate(ctx);
        expect(result).toBe(true);
    });

    it("should handle Prisma errors", async () => {
        jwtService.verifyAsync.mockResolvedValue({ sub: "1" });
        const err = new Error("prisma error");
        err.name = "PrismaClientKnownRequestError";
        prisma.user.findUnique.mockRejectedValue(err);

        const ctx = mockContext({ query: { token: "valid-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("Unable to process request");
    });

    it("should handle JWT verification errors", async () => {
        jwtService.verifyAsync.mockRejectedValue(new Error("expired"));

        const ctx = mockContext({ query: { token: "expired-token" } });
        await expect(guard.canActivate(ctx)).rejects.toThrow("unauthorized");
    });
});
