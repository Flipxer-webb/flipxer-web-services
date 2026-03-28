import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

jest.mock("bcryptjs", () => ({
    hash: jest.fn().mockResolvedValue("hashed_password"),
    compare: jest.fn(),
}));

jest.mock("otplib", () => ({
    authenticator: {
        check: jest.fn(),
        generateSecret: jest.fn().mockReturnValue("TESTBASE32SECRET"),
    },
}));

jest.mock("@/config", () => ({
    ...jest.requireActual("@/config"),
    jwtSecret: "test-jwt-secret",
    jwt_refresh_secret: "test-jwt-refresh-secret",
    TOKEN_EXPIRATION: "1h",
    REFRESH_TOKEN_EXPIRATION: "7d",
    COMPANY_NAME: "Flipxer",
    isProdEnvironment: false,
    emailTemplateConfig: {
        forgot_password: "tpl-forgot",
        registration_success: "tpl-reg",
        verify_account: "tpl-verify",
    },
    mailConfig: { senderMail: "noreply@flipxer.com" },
    storageDirConfig: { profileDir: "/tmp", documentDir: "/tmp" },
    cloudinaryConfig: {},
    imagekitConfig: {},
}));

import { AuthService } from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { UploadFactory } from "@/modules/core/upload/services";
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { CryptoAccountQueueProducer } from "@/modules/api/trade/queues/producers/producer.service";
import { SmsService } from "@/modules/core/sms/services";
import { SessionService } from "@/modules/api/session/services";
import { TwoFactorRateLimitService } from "../two-factor-rate-limit.service";
import { SettingService } from "@/modules/api/settings/services";
import { TierService } from "../tier.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { KycStateMachineService } from "../kyc-state-machine.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { Status, UserType } from "@prisma/client";
import * as bcrypt from "bcryptjs";

function makePrisma() {
    return {
        user: {
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        role: { findUnique: jest.fn() },
        accountVerificationRequest: { upsert: jest.fn(), findUnique: jest.fn() },
        passwordResetRequest: { create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
    };
}

describe("AuthService", () => {
    let service: AuthService;
    let prisma: ReturnType<typeof makePrisma>;
    let jwtService: { signAsync: jest.Mock; verify: jest.Mock; verifyAsync: jest.Mock };
    let emailService: { sendMailWithTemplate: jest.Mock };
    let redisCacheService: { set: jest.Mock; get: jest.Mock; del: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockJwt = {
            signAsync: jest.fn().mockResolvedValue("mock-token"),
            verify: jest.fn(),
            verifyAsync: jest.fn(),
        };
        const mockEmail = { sendMailWithTemplate: jest.fn().mockResolvedValue(undefined) };
        const mockUploadFactory = { build: jest.fn().mockReturnValue({}) };
        const mockDojah = {};
        const mockCryptoQueue = { addJob: jest.fn() };
        const mockSms = { sendSms: jest.fn() };
        const mockSession = {
            createSession: jest.fn().mockResolvedValue({ sessionId: "session-1" }),
            validateSession: jest.fn().mockResolvedValue(true),
        };
        const mock2FA = {
            checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
            reset: jest.fn(),
        };
        const mockSettings = { getSetting: jest.fn() };
        const mockTier = {};
        const mockRedis = {
            set: jest.fn().mockResolvedValue(undefined),
            get: jest.fn(),
            del: jest.fn(),
        };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_key: string, cb: () => any) => cb()),
        };
        const mockKyc = {};
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockWsGateway = { sendToUser: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AuthService,
                { provide: JwtService, useValue: mockJwt },
                { provide: PrismaService, useValue: prisma },
                { provide: EmailService, useValue: mockEmail },
                { provide: UploadFactory, useValue: mockUploadFactory },
                { provide: IdentityComplianceInjectionToken.DOJAH, useValue: mockDojah },
                { provide: CryptoAccountQueueProducer, useValue: mockCryptoQueue },
                { provide: SmsService, useValue: mockSms },
                { provide: SessionService, useValue: mockSession },
                { provide: TwoFactorRateLimitService, useValue: mock2FA },
                { provide: SettingService, useValue: mockSettings },
                { provide: TierService, useValue: mockTier },
                { provide: RedisCacheService, useValue: mockRedis },
                { provide: DistributedLockService, useValue: mockLock },
                { provide: KycStateMachineService, useValue: mockKyc },
                { provide: NotificationDispatcher, useValue: mockNotification },
                { provide: WsGateway, useValue: mockWsGateway },
            ],
        }).compile();

        service = module.get(AuthService);
        jwtService = module.get(JwtService);
        emailService = module.get(EmailService);
        redisCacheService = module.get(RedisCacheService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── hashPassword / comparePassword ───────────────────────

    describe("hashPassword", () => {
        it("should hash a password", async () => {
            const result = await service.hashPassword("test123");
            expect(result).toBe("hashed_password");
            expect(bcrypt.hash).toHaveBeenCalledWith("test123", 10);
        });
    });

    describe("comparePassword", () => {
        it("should return true for matching passwords", async () => {
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            const result = await service.comparePassword("test123", "hashed");
            expect(result).toBe(true);
        });

        it("should return false for non-matching passwords", async () => {
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);
            const result = await service.comparePassword("wrong", "hashed");
            expect(result).toBe(false);
        });
    });

    // ── generateTokens ──────────────────────────────────────

    describe("generateTokens", () => {
        it("should generate access and refresh tokens", async () => {
            jwtService.signAsync
                .mockResolvedValueOnce("access-token")
                .mockResolvedValueOnce("refresh-token");

            const tokens = await service.generateTokens({ sub: 1 });

            expect(tokens.accessToken).toBe("access-token");
            expect(tokens.refreshToken).toBe("refresh-token");
            expect(jwtService.signAsync).toHaveBeenCalledTimes(2);
        });
    });

    // ── signUp ──────────────────────────────────────────────

    describe("signUp", () => {
        const signUpDto = {
            email: "test@example.com",
            firstName: "John",
            lastName: "Doe",
            accountType: "individual",
            password: "SecurePass123!",
        };

        it("should store signup data in Redis and return success", async () => {
            prisma.user.findUnique.mockResolvedValue(null);
            prisma.role.findUnique.mockResolvedValue({ id: 1, slug: "individual" });

            const result = await service.signUp(signUpDto as any, "127.0.0.1");

            expect(result.message).toContain("Account initialization successful");
            expect(redisCacheService.set).toHaveBeenCalledWith(
                "pending_signup:test@example.com",
                expect.objectContaining({ email: "test@example.com" }),
                expect.any(Number),
            );
        });

        it("should throw when email already exists", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                isDeleted: false,
            });

            await expect(service.signUp(signUpDto as any, "127.0.0.1")).rejects.toThrow();
        });

        it("should throw when role not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);
            prisma.role.findUnique.mockResolvedValue(null);

            await expect(service.signUp(signUpDto as any, "127.0.0.1")).rejects.toThrow();
        });

        it("should allow re-registration for deleted non-blocked users", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                isDeleted: true,
                status: Status.ACTIVE,
                flaggedRecord: null,
            });
            prisma.user.delete.mockResolvedValue({});
            prisma.role.findUnique.mockResolvedValue({ id: 1, slug: "individual" });

            const result = await service.signUp(signUpDto as any, "127.0.0.1");

            expect(result.message).toContain("Account initialization successful");
            expect(prisma.user.delete).toHaveBeenCalled();
        });

        it("should block re-registration for blocked deleted users", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                isDeleted: true,
                status: Status.BLOCKED,
                flaggedRecord: null,
            });

            await expect(service.signUp(signUpDto as any, "127.0.0.1")).rejects.toThrow();
        });
    });

    // ── requestPasswordReset ─────────────────────────────────

    describe("requestPasswordReset", () => {
        it("should send password reset email", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                firstName: "John",
                lastName: "Doe",
            });
            prisma.passwordResetRequest.deleteMany.mockResolvedValue({});
            prisma.passwordResetRequest.create.mockResolvedValue({});

            const result = await service.requestPasswordReset({
                email: "test@example.com",
            } as any);

            expect(result.message).toContain("Password reset email sent");
            expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
        });

        it("should throw when user not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(
                service.requestPasswordReset({ email: "nonexistent@example.com" } as any),
            ).rejects.toThrow();
        });
    });

    // ── resetPassword ────────────────────────────────────────

    describe("resetPassword", () => {
        it("should reset password with valid code", async () => {
            const resetCode = "ABCD1234";
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                password: "old_hash",
                passwordResetRequest: {
                    code: resetCode,
                    createdAt: new Date(), // Not expired
                },
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(false); // Not same as current
            prisma.user.update.mockResolvedValue({});
            prisma.passwordResetRequest.delete.mockResolvedValue({});

            const result = await service.resetPassword({
                email: "test@example.com",
                resetCode,
                password: "NewSecure123!",
            } as any);

            expect(result.message).toContain("Password reset successfully");
        });

        it("should throw for expired reset code", async () => {
            const expiredDate = new Date();
            expiredDate.setHours(expiredDate.getHours() - 1); // 1 hour ago

            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                password: "old_hash",
                passwordResetRequest: {
                    code: "ABCD1234",
                    createdAt: expiredDate,
                },
            });
            prisma.passwordResetRequest.delete.mockResolvedValue({});

            await expect(
                service.resetPassword({
                    email: "test@example.com",
                    resetCode: "ABCD1234",
                    password: "NewSecure123!",
                } as any),
            ).rejects.toThrow();
        });
    });

    // ── userSignIn ───────────────────────────────────────────

    describe("userSignIn", () => {
        const signInDto = {
            email: "user@example.com",
            password: "password123",
            deviceName: "Chrome",
            deviceType: "desktop",
            browser: "Chrome",
            os: "Windows",
        };

        it("should return tokens for valid credentials", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                identifier: "user-id",
                email: "user@example.com",
                password: "hashed_password",
                userType: UserType.INDIVIDUAL,
                status: Status.ACTIVE,
                role: { name: "individual", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isDocumentVerified: false,
                businessRecordCompleted: false,
                businessDocumentVerificationStatus: null,
                failedLoginAttempts: 0,
                lastFailedLogin: null,
                lockedUntil: null,
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            jwtService.signAsync
                .mockResolvedValueOnce("access-token")
                .mockResolvedValueOnce("refresh-token");
            prisma.user.update.mockResolvedValue({});

            const result = await service.userSignIn(signInDto as any, "127.0.0.1");

            expect(result.data.accessToken).toBe("access-token");
            expect(result.data.refreshToken).toBe("refresh-token");
        });

        it("should throw for invalid password", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "user@example.com",
                password: "hashed_password",
                userType: UserType.INDIVIDUAL,
                status: Status.ACTIVE,
                role: { name: "individual", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: false,
                failedLoginAttempts: 0,
                lastFailedLogin: null,
                lockedUntil: null,
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);
            prisma.user.update.mockResolvedValue({});

            await expect(service.userSignIn(signInDto as any, "127.0.0.1")).rejects.toThrow();
        });

        it("should return 2FA challenge when 2FA enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "user@example.com",
                password: "hashed_password",
                userType: UserType.INDIVIDUAL,
                status: Status.ACTIVE,
                role: { name: "individual", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: true,
                twoFactorSecret: "secret",
                failedLoginAttempts: 0,
                lastFailedLogin: null,
                lockedUntil: null,
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            jwtService.signAsync.mockResolvedValue("temp-token");

            const result = await service.userSignIn(signInDto as any, "127.0.0.1");

            expect(result.data.requiresTwoFactor).toBe(true);
            expect(result.data.tempToken).toBe("temp-token");
        });

        it("should throw for blocked user", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "user@example.com",
                password: "hashed_password",
                userType: UserType.INDIVIDUAL,
                status: Status.BLOCKED,
                role: { name: "individual", rolePermission: [] },
                flaggedRecord: null,
            });

            await expect(service.userSignIn(signInDto as any, "127.0.0.1")).rejects.toThrow();
        });

        it("should throw for non-existent user", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.userSignIn(signInDto as any, "127.0.0.1")).rejects.toThrow();
        });
    });

    // ── refreshToken ─────────────────────────────────────────

    describe("refreshToken", () => {
        it("should rotate refresh token", async () => {
            jwtService.verify.mockReturnValue({ sub: 1 });
            prisma.user.findUnique.mockResolvedValue({
                refreshToken: "hashed-matching-token",
                refreshTokenFamily: "family-1",
            });
            jwtService.signAsync
                .mockResolvedValueOnce("new-access-token")
                .mockResolvedValueOnce("new-refresh-token");
            prisma.user.update.mockResolvedValue({});

            // Mock validateRefreshToken via prisma — the method hashes and compares
            // We need the hashed incoming to match the stored hash
            // Since we can't control crypto.createHash in the test, we'll spy
            const validateSpy = jest.spyOn(service, "validateRefreshToken" as any)
                .mockResolvedValue({ valid: true, family: "family-1" });

            const result = await service.refreshToken({ refreshToken: "old-refresh-token" } as any);

            expect(result.data.accessToken).toBe("new-access-token");
            expect(result.data.refreshToken).toBe("new-refresh-token");
            validateSpy.mockRestore();
        });

        it("should throw for invalid refresh token", async () => {
            jwtService.verify.mockReturnValue({ sub: 1 });

            const validateSpy = jest.spyOn(service, "validateRefreshToken" as any)
                .mockResolvedValue({ valid: false });

            await expect(service.refreshToken({ refreshToken: "invalid" } as any)).rejects.toThrow();
            validateSpy.mockRestore();
        });
    });

    // ── saveRefreshToken ─────────────────────────────────────

    describe("saveRefreshToken", () => {
        it("should save hashed refresh token", async () => {
            prisma.user.update.mockResolvedValue({});

            await service.saveRefreshToken(1, "test-refresh-token");

            expect(prisma.user.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: {
                    refreshToken: expect.any(String), // SHA256 hash
                    refreshTokenFamily: expect.any(String), // UUID
                },
            });
        });
    });

    // ── validateRefreshToken ─────────────────────────────────

    describe("validateRefreshToken", () => {
        it("should return invalid when no stored token", async () => {
            prisma.user.findUnique.mockResolvedValue({ refreshToken: null });

            const result = await service.validateRefreshToken(1, "token");

            expect(result.valid).toBe(false);
        });
    });
});
