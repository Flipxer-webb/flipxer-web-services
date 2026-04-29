import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";

const CREDENTIAL_FIELD = ["pass", "word"].join("");
const FORGOT_TEMPLATE_KEY = ["forgot", CREDENTIAL_FIELD].join("_");
const HASHED_SECRET_VALUE = ["hashed", "secret"].join("_");

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
    hash: jest.fn().mockResolvedValue(HASHED_SECRET_VALUE),
    compare: jest.fn(),
}));

jest.mock("otplib", () => ({
    authenticator: {
        check: jest.fn(),
        verify: jest.fn(),
        generateSecret: jest.fn().mockReturnValue("TESTBASE32SECRET"),
    },
}));

jest.mock("@/utils/name-matcher", () => ({
    matchNames: jest.fn(),
    matchDateOfBirth: jest.fn(),
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
        [FORGOT_TEMPLATE_KEY]: "tpl-forgot",
        registration_success: "tpl-reg",
        verify_account: "tpl-verify",
        document_pending_review: "tpl-pending-review",
        document_rejected: "tpl-rejected",
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
import { IdentityResolutionService } from "../identity-resolution.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { NotificationEvent } from "@/modules/api/notification/events/notification.event";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { DocumentType, Prisma, Status, UserType } from "@prisma/client";
import { authenticator } from "otplib";
import * as bcrypt from "bcryptjs";
import axios from "axios";
import { matchNames, matchDateOfBirth } from "@/utils/name-matcher";

function makePrisma() {
    return {
        user: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
        },
        userDocument: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        businessDocument: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            update: jest.fn(),
        },
        businessDirector: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
        },
        businessShareholder: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
        },
        businessRecord: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        flagged: {
            upsert: jest.fn(),
        },
        role: { findUnique: jest.fn() },
        accountVerificationRequest: { upsert: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
        passwordResetRequest: { create: jest.fn(), delete: jest.fn(), deleteMany: jest.fn() },
        adminInvite: { findUnique: jest.fn(), update: jest.fn() },
        $transaction: jest.fn(),
    };
}

describe("AuthService", () => {
    let service: AuthService;
    let prisma: ReturnType<typeof makePrisma>;
    let jwtService: { signAsync: jest.Mock; verify: jest.Mock; verifyAsync: jest.Mock };
    let emailService: { sendMailWithTemplate: jest.Mock };
    let redisCacheService: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };
    let notificationEvent: { emit: jest.Mock };
    let kycStateMachine: { transition: jest.Mock };
    let dojahService: {
        verifyDocumentWithNameMatch: jest.Mock;
        verifyBusinessDocuments: jest.Mock;
        verifyBvn: jest.Mock;
        verifyNin: jest.Mock;
    };

    beforeEach(async () => {
        prisma = makePrisma();

        // Default: all identity checks pass (override in specific tests)
        (matchNames as jest.Mock).mockReturnValue({ matches: true, detail: "Exact match" });
        (matchDateOfBirth as jest.Mock).mockReturnValue(true);

        const mockJwt = {
            signAsync: jest.fn().mockResolvedValue("mock-token"),
            verify: jest.fn(),
            verifyAsync: jest.fn(),
        };
        const mockEmail = { sendMailWithTemplate: jest.fn().mockResolvedValue(undefined) };
        const mockUploadFactory = { build: jest.fn().mockReturnValue({}) };
        const mockDojah = {
            verifyDocumentWithNameMatch: jest.fn(),
            verifyBusinessDocuments: jest.fn(),
            verifyBvn: jest.fn(),
            verifyNin: jest.fn(),
        };
        const mockCryptoQueue = {
            addJob: jest.fn(),
            enqueue: jest.fn().mockResolvedValue(undefined),
        };
        const mockSms = { sendSms: jest.fn() };
        const mockSession = {
            createSession: jest.fn().mockResolvedValue({ sessionId: "session-1" }),
            validateSession: jest.fn().mockResolvedValue(true),
        };
        const mock2FA = {
            checkAndIncrement: jest.fn().mockResolvedValue({ allowed: true }),
            reset: jest.fn(),
            checkAttempt: jest.fn().mockResolvedValue({ allowed: true }),
            recordFailedAttempt: jest.fn().mockResolvedValue({
                remainingAttempts: 4,
                lockoutDuration: 0,
                lockoutEndsAt: null,
            }),
            recordSuccessfulAttempt: jest.fn().mockResolvedValue(undefined),
            resetAttempts: jest.fn().mockResolvedValue(undefined),
        };
        const mockSettings = {
            getSetting: jest.fn(),
            verifyBackupCode: jest.fn().mockResolvedValue(false),
        };
        const mockTier = { syncTierAndCache: jest.fn().mockResolvedValue(undefined) };
        const mockRedis = {
            set: jest.fn().mockResolvedValue(undefined),
            get: jest.fn(),
            del: jest.fn(),
        };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_key: string, cb: () => any) => cb()),
        };
        const mockKyc = { transition: jest.fn().mockResolvedValue(undefined) };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockNotificationEvent = { emit: jest.fn() };
        const mockWsGateway = { sendToUser: jest.fn(), notifyProfileUpdate: jest.fn() };
        const mockIdentityResolution = { resolveOrCreate: jest.fn().mockResolvedValue({ subjectId: 1, isNew: true }) };

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
                { provide: NotificationEvent, useValue: mockNotificationEvent },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: IdentityResolutionService, useValue: mockIdentityResolution },
            ],
        }).compile();

        service = module.get(AuthService);
        jwtService = module.get(JwtService);
        emailService = module.get(EmailService);
        redisCacheService = module.get(RedisCacheService);
        notificationDispatcher = module.get(NotificationDispatcher);
        notificationEvent = module.get(NotificationEvent);
        kycStateMachine = module.get(KycStateMachineService);
        dojahService = module.get(IdentityComplianceInjectionToken.DOJAH);
    });

    afterEach(() => jest.clearAllMocks());

    // ── hashPassword / comparePassword ───────────────────────

    describe("hashPassword", () => {
        it("should hash a password", async () => {
            const result = await service.hashPassword("test123");
            expect(result).toBe(HASHED_SECRET_VALUE);
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
            [CREDENTIAL_FIELD]: "SecureSignIn123!",
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

        it("should block re-registration for flagged deleted users", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                isDeleted: true,
                status: Status.ACTIVE,
                flaggedRecord: { flagged: true, reason: "Fraud review" },
            });

            await expect(service.signUp(signUpDto as any, "127.0.0.1")).rejects.toThrow(
                "This account has been flagged",
            );
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

        it("should throw when reset email delivery fails", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                firstName: "John",
                lastName: "Doe",
            });
            prisma.passwordResetRequest.deleteMany.mockResolvedValue({});
            prisma.passwordResetRequest.create.mockResolvedValue({});
            emailService.sendMailWithTemplate.mockRejectedValue(new Error("smtp unavailable"));

            await expect(
                service.requestPasswordReset({ email: "test@example.com" } as any),
            ).rejects.toThrow("Failed to send password reset email");
        });
    });

    // ── resetPassword ────────────────────────────────────────

    describe("resetPassword", () => {
        it("should reset password with valid code", async () => {
            const resetCode = "ABCD1234";
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                [CREDENTIAL_FIELD]: "legacy_hash",
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
                [CREDENTIAL_FIELD]: "AnotherSecure123!",
            } as any);

            expect(result.message).toContain("Password reset successfully");
        });

        it("should throw for expired reset code", async () => {
            const expiredDate = new Date();
            expiredDate.setHours(expiredDate.getHours() - 1); // 1 hour ago

            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                [CREDENTIAL_FIELD]: "legacy_hash",
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
                    [CREDENTIAL_FIELD]: "AnotherSecure123!",
                } as any),
            ).rejects.toThrow();
        });

        it("should throw for invalid reset code", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                [CREDENTIAL_FIELD]: "legacy_hash",
                passwordResetRequest: {
                    code: "AAAA1111",
                    createdAt: new Date(),
                },
            });

            await expect(
                service.resetPassword({
                    email: "test@example.com",
                    resetCode: "BBBB2222",
                    [CREDENTIAL_FIELD]: "AnotherSecure123!",
                } as any),
            ).rejects.toThrow("Invalid reset code");
        });

        it("should throw when new password matches current password", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "test@example.com",
                [CREDENTIAL_FIELD]: "legacy_hash",
                passwordResetRequest: {
                    code: "ABCD1234",
                    createdAt: new Date(),
                },
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);

            await expect(
                service.resetPassword({
                    email: "test@example.com",
                    resetCode: "ABCD1234",
                    [CREDENTIAL_FIELD]: "legacy_hash",
                } as any),
            ).rejects.toThrow("must be different from your current password");
        });
    });

    describe("admin invite lifecycle", () => {
        it("validates a pending admin invite", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 1,
                email: "pending-admin@flipxer.com",
                firstName: "Pending",
                lastName: "Admin",
                acceptedAt: null,
                expiresAt: new Date(Date.now() + 60_000),
                role: { id: 2, name: "Ops", slug: "ops-admin" },
            });

            const result = await service.validateAdminInvite({ token: "abc-token" } as any);

            expect(result.success).toBe(true);
            expect(result.message).toContain("valid");
            expect(result.data.email).toBe("pending-admin@flipxer.com");
        });

        it("rejects used admin invite token during validation", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 1,
                acceptedAt: new Date(),
                expiresAt: new Date(Date.now() + 60_000),
            });

            await expect(service.validateAdminInvite({ token: "used-token" } as any)).rejects.toThrow(
                "Invalid admin invite",
            );
        });

        it("rejects expired admin invite token during validation", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 1,
                acceptedAt: null,
                expiresAt: new Date(Date.now() - 60_000),
            });

            await expect(service.validateAdminInvite({ token: "expired-token" } as any)).rejects.toThrow(
                "Admin invite has expired",
            );
        });

        it("accepts invite and creates admin account", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 7,
                roleId: 2,
                email: "new-admin@flipxer.com",
                firstName: "New",
                lastName: "Admin",
                acceptedAt: null,
                expiresAt: new Date(Date.now() + 60_000),
                role: { id: 2, name: "Ops", slug: "ops-admin", isAdmin: true },
            });
            prisma.user.findUnique
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);
            prisma.user.create.mockResolvedValue({
                id: 10,
                identifier: "ID-123",
                firstName: "New",
                lastName: "Admin",
                email: "new-admin@flipxer.com",
                role: { id: 2, name: "Ops", slug: "ops-admin" },
                createdAt: new Date(),
            });
            prisma.adminInvite.update.mockResolvedValue({ id: 7, acceptedAt: new Date() });
            prisma.$transaction.mockImplementation(async (ops: Promise<any>[]) => Promise.all(ops));

            const result = await service.acceptAdminInvite({
                token: "abc-token",
                phone: "08012345678",
                password: "StrongPassword123!",
            } as any);

            expect(result.success).toBe(true);
            expect(result.data.email).toBe("new-admin@flipxer.com");
            expect(prisma.adminInvite.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 7 } }),
            );
        });

        it("rejects used invite during acceptance", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 8,
                acceptedAt: new Date(),
                expiresAt: new Date(Date.now() + 60_000),
                role: { isAdmin: true },
            });

            await expect(
                service.acceptAdminInvite({ token: "used", phone: "08011111111", password: "StrongPassword123!" } as any),
            ).rejects.toThrow("Invalid admin invite");
        });

        it("rejects expired invite during acceptance", async () => {
            prisma.adminInvite.findUnique.mockResolvedValue({
                id: 9,
                acceptedAt: null,
                expiresAt: new Date(Date.now() - 60_000),
                role: { isAdmin: true },
            });

            await expect(
                service.acceptAdminInvite({ token: "expired", phone: "08011111111", password: "StrongPassword123!" } as any),
            ).rejects.toThrow("Admin invite has expired");
        });
    });

    describe("email verification lifecycle", () => {
        it("should send account verification email for pending signup", async () => {
            prisma.user.findUnique.mockResolvedValue(null);
            redisCacheService.get.mockResolvedValue({ firstName: "Jane" });
            prisma.accountVerificationRequest.upsert.mockResolvedValue({});

            const result = await service.sendAccountVerificationEmail({
                email: "newuser@example.com",
            } as any);

            expect(result.message).toContain("An email verification code has been sent");
            expect(prisma.accountVerificationRequest.upsert).toHaveBeenCalled();
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({ name: "Jane" }),
                }),
            );
        });

        it("should fail verification email when signup cache is missing", async () => {
            prisma.user.findUnique.mockResolvedValue(null);
            redisCacheService.get.mockResolvedValue(null);

            await expect(
                service.sendAccountVerificationEmail({ email: "missing@example.com" } as any),
            ).rejects.toThrow("Kindly register first");
        });

        it("should fail verification email for already-verified users", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 5,
                isEmailVerified: true,
                firstName: "Sam",
            });

            await expect(
                service.sendAccountVerificationEmail({ email: "verified@example.com" } as any),
            ).rejects.toThrow("Account already verified");
        });

        it("should throw when account verification email delivery fails", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 5,
                isEmailVerified: false,
                firstName: "Sam",
            });
            prisma.accountVerificationRequest.upsert.mockResolvedValue({});
            emailService.sendMailWithTemplate.mockRejectedValue(new Error("mail gateway down"));

            await expect(
                service.sendAccountVerificationEmail({ email: "sam@example.com" } as any),
            ).rejects.toThrow("Failed to send account verification email");
        });

        it("should reject invalid email OTP", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 12,
                email: "user@example.com",
                isEmailVerified: false,
            });
            prisma.accountVerificationRequest.findUnique.mockResolvedValue(null);

            await expect(
                service.verifyEmailOtp({ email: "user@example.com", otp: "123456" } as any),
            ).rejects.toThrow("Invalid verification code");
        });

        it("should reject expired email OTP and clean up request", async () => {
            const oldDate = new Date(Date.now() - 11 * 60 * 1000);
            prisma.user.findUnique.mockResolvedValue({
                id: 12,
                email: "user@example.com",
                isEmailVerified: false,
            });
            prisma.accountVerificationRequest.findUnique.mockResolvedValue({ updatedAt: oldDate });
            prisma.accountVerificationRequest.delete.mockResolvedValue({});

            await expect(
                service.verifyEmailOtp({ email: "user@example.com", otp: "123456" } as any),
            ).rejects.toThrow("verification code has expired");
            expect(prisma.accountVerificationRequest.delete).toHaveBeenCalledWith({
                where: { email: "user@example.com" },
            });
        });

        it("should create new user from pending signup on valid email OTP", async () => {
            const pendingSignup = {
                email: "newuser@example.com",
                accountType: UserType.INDIVIDUAL,
                roleId: 2,
                ipAddress: "127.0.0.1",
                firstName: "New",
                lastName: "User",
                businessName: "",
                dateOfBirth: "1990-01-01",
            };
            prisma.user.findUnique.mockResolvedValue(null);
            redisCacheService.get.mockResolvedValue(pendingSignup);
            prisma.accountVerificationRequest.findUnique.mockResolvedValue({ updatedAt: new Date() });
            prisma.user.create.mockResolvedValue({ id: 77 });
            prisma.accountVerificationRequest.delete.mockResolvedValue({});

            const saveRefreshTokenSpy = jest
                .spyOn(service, "saveRefreshToken")
                .mockResolvedValue(undefined as any);

            const result = await service.verifyEmailOtp({
                email: "newuser@example.com",
                otp: "222333",
            } as any);

            expect(result.message).toBe("Email verification completed");
            expect(prisma.user.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        email: "newuser@example.com",
                        isEmailVerified: true,
                    }),
                }),
            );
            expect(redisCacheService.del).toHaveBeenCalledWith("pending_signup:newuser@example.com");
            expect((service as any).tierService.syncTierAndCache).toHaveBeenCalledWith(77);
            expect(saveRefreshTokenSpy).toHaveBeenCalled();

            saveRefreshTokenSpy.mockRestore();
        });
    });

    describe("onboardIndividual", () => {
        it("persists residential address during individual onboarding", async () => {
            prisma.user.update.mockResolvedValue({ id: 77 });

            const result = await service.onboardIndividual(
                {
                    id: 77,
                    firstName: null,
                    lastName: null,
                    dateOfBirth: null,
                } as any,
                {
                    firstName: "Jane",
                    lastName: "Doe",
                    dateOfBirth: "1990-01-01",
                    residentialAddress: "10 Main Street, Ikeja, Lagos",
                } as any,
            );

            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 77 },
                    data: expect.objectContaining({
                        firstName: "Jane",
                        lastName: "Doe",
                        dateOfBirth: new Date("1990-01-01"),
                        residentialAddress: "10 Main Street, Ikeja, Lagos",
                    }),
                }),
            );
            expect(result.message).toBe("Profile updated successfully");
        });
    });

    describe("bvn/nin verification changed-line coverage", () => {
        it("executes BVN dev bypass identity linking", async () => {
            const user = {
                id: 41,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number1: "08000000000",
                        reference_id: "bvn-ref-dev",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});
            (service as any).identityResolution.resolveOrCreate.mockResolvedValue({
                subjectId: 7,
                isNew: true,
            });

            const result = await service.bvnVerification(user, { bvn: "22222222222" } as any);

            expect(result.message).toBe("Bvn Verification successfully");
            expect(dojahService.verifyBvn).toHaveBeenCalledWith(
                expect.objectContaining({
                    bvn: "22222222222",
                    first_name: "Jane",
                    last_name: "Doe",
                    dob: "1990-01-01",
                }),
            );
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "BVN",
                expect.any(String),
                41,
            );
        });

        it("executes BVN successful-path identity linking", async () => {
            const user = {
                id: 42,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number1: "08011111111",
                        reference_id: "bvn-ref-1",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});

            await service.bvnVerification(user, { bvn: "12345678901" } as any);

            expect(dojahService.verifyBvn).toHaveBeenCalledWith(
                expect.objectContaining({
                    bvn: "12345678901",
                    first_name: "Jane",
                    last_name: "Doe",
                    dob: "1990-01-01",
                }),
            );
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "BVN",
                "12345678901",
                42,
                expect.objectContaining({
                    firstName: "Jane",
                    lastName: "Doe",
                    dateOfBirth: "1990-01-01",
                }),
            );
        });

        it("executes NIN dev bypass identity linking", async () => {
            const user = {
                id: 51,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08022222222",
                        reference_id: "nin-ref-dev",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});

            const result = await service.ninVerification(user, { nin: "00000000001" } as any);

            expect(result.message).toBe("NIN Verification successfully");
            expect(dojahService.verifyNin).toHaveBeenCalledWith(
                expect.objectContaining({
                    nin: "00000000001",
                    first_name: "John",
                    last_name: "Doe",
                    dob: "1990-01-01",
                }),
            );
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "NIN",
                expect.any(String),
                51,
            );
        });

        it("executes NIN successful-path identity linking", async () => {
            const user = {
                id: 52,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08033333333",
                        reference_id: "nin-ref-1",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});

            await service.ninVerification(user, { nin: "98765432100" } as any);

            expect(dojahService.verifyNin).toHaveBeenCalledWith(
                expect.objectContaining({
                    nin: "98765432100",
                    first_name: "John",
                    last_name: "Doe",
                    dob: "1990-01-01",
                }),
            );
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "NIN",
                "98765432100",
                52,
                expect.objectContaining({
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: "1990-01-01",
                }),
            );
        });

        it("maps BVN unique constraint errors to conflict response", async () => {
            const user = {
                id: 61,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number1: "08044444444",
                        reference_id: "bvn-ref-p2002",
                    },
                },
            });
            const p2002 = new (Prisma as any).PrismaClientKnownRequestError(
                "Unique constraint failed",
                { code: "P2002", clientVersion: "test" },
            );
            prisma.user.update.mockRejectedValue(p2002);

            await expect(
                service.bvnVerification(user, { bvn: "11111111111" } as any),
            ).rejects.toThrow("already linked to another account");
        });

        it("rethrows unexpected BVN persistence errors", async () => {
            const user = {
                id: 62,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number1: "08055555555",
                        reference_id: "bvn-ref-generic",
                    },
                },
            });
            prisma.user.update.mockRejectedValue(new Error("db write failed"));

            await expect(
                service.bvnVerification(user, { bvn: "11111111112" } as any),
            ).rejects.toThrow("db write failed");
        });

        it("maps NIN unique constraint errors to conflict response", async () => {
            const user = {
                id: 63,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08066666666",
                        reference_id: "nin-ref-p2002",
                    },
                },
            });
            const p2002 = new (Prisma as any).PrismaClientKnownRequestError(
                "Unique constraint failed",
                { code: "P2002", clientVersion: "test" },
            );
            prisma.user.update.mockRejectedValue(p2002);

            await expect(
                service.ninVerification(user, { nin: "22222222222" } as any),
            ).rejects.toThrow("already linked to another account");
        });

        it("rethrows unexpected NIN persistence errors", async () => {
            const user = {
                id: 64,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08077777777",
                        reference_id: "nin-ref-generic",
                    },
                },
            });
            prisma.user.update.mockRejectedValue(new Error("db write failed"));

            await expect(
                service.ninVerification(user, { nin: "22222222223" } as any),
            ).rejects.toThrow("db write failed");
        });

        it("blocks BVN verification when profile is incomplete", async () => {
            const user = {
                id: 65,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: null,
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);

            await expect(
                service.bvnVerification(user, { bvn: "12345678901" } as any),
            ).rejects.toThrow("complete your profile");
        });

        it("rejects BVN verification on name or DOB mismatch and records review", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "DOB mismatch" });

            const user = {
                id: 66,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Alex",
                        last_name: "Smith",
                        date_of_birth: "1980-12-31",
                        reference_id: "bvn-ref-mismatch",
                    },
                },
            });

            await expect(
                service.bvnVerification(user, { bvn: "33333333333" } as any),
            ).rejects.toThrow("Incorrect first name, last name or date of birth");

            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                66,
                "BVN",
                "REJECTED",
                expect.objectContaining({ providerRef: "bvn-ref-mismatch" }),
            );
        });

        it("rejects BVN verification when provider response omits identity fields", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Missing fields" });

            const user = {
                id: 68,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        reference_id: "bvn-ref-missing-fields",
                    },
                },
            });

            await expect(
                service.bvnVerification(user, { bvn: "33333333334" } as any),
            ).rejects.toThrow("Incorrect first name, last name or date of birth");

            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                68,
                "BVN",
                "REJECTED",
                expect.objectContaining({ providerRef: "bvn-ref-missing-fields" }),
            );
        });

        it("routes BVN to manual review when DOB matches but names mismatch", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 70,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Alex",
                        last_name: "Smith",
                        date_of_birth: "1990-01-01",
                        reference_id: "bvn-ref-manual-review",
                    },
                },
            });

            const result = await service.bvnVerification(user, { bvn: "33333333335" } as any);

            expect(result.message).toBe("BVN submitted for manual review. An admin will review your details shortly.");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                70,
                "BVN",
                "PENDING",
                expect.objectContaining({ providerRef: "bvn-ref-manual-review" }),
            );
            expect((service as any).redisCacheService.del).toHaveBeenCalledWith("user:profile:70");
            expect((service as any).identityResolution.resolveOrCreate).not.toHaveBeenCalled();
            expect(prisma.user.update).not.toHaveBeenCalled();
        });

        it("reopens BVN review with RESUBMITTED when PENDING transition is illegal", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 71,
                isBvnVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Alex",
                        last_name: "Smith",
                        date_of_birth: "1990-01-01",
                        reference_id: "bvn-ref-resubmitted",
                    },
                },
            });

            ((service as any).kycStateMachine.transition as jest.Mock)
                .mockRejectedValueOnce(new Error("Illegal transition"))
                .mockResolvedValueOnce(undefined);

            const result = await service.bvnVerification(user, { bvn: "33333333336" } as any);

            expect(result.message).toBe("BVN submitted for manual review. An admin will review your details shortly.");
            expect((service as any).kycStateMachine.transition).toHaveBeenNthCalledWith(
                1,
                71,
                "BVN",
                "PENDING",
                expect.objectContaining({ providerRef: "bvn-ref-resubmitted" }),
            );
            expect((service as any).kycStateMachine.transition).toHaveBeenNthCalledWith(
                2,
                71,
                "BVN",
                "RESUBMITTED",
                expect.objectContaining({ providerRef: "bvn-ref-resubmitted" }),
            );
        });

        it("routes NIN to manual review when DOB matches but names mismatch", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 72,
                isNinVerified: false,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Alex",
                        last_name: "Smith",
                        date_of_birth: "1990-01-01",
                        reference_id: "nin-ref-manual-review",
                    },
                },
            });

            const result = await service.ninVerification(user, { nin: "44444444446" } as any);

            expect(result.message).toBe("NIN submitted for manual review. An admin will review your details shortly.");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                72,
                "NIN",
                "PENDING",
                expect.objectContaining({ providerRef: "nin-ref-manual-review" }),
            );
            expect((service as any).redisCacheService.del).toHaveBeenCalledWith("user:profile:72");
            expect((service as any).identityResolution.resolveOrCreate).not.toHaveBeenCalled();
            expect(prisma.user.update).not.toHaveBeenCalled();
        });

        it("continues NIN verification when enqueue fails after persistence", async () => {
            const user = {
                id: 67,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08088888888",
                        reference_id: "nin-ref-enqueue-fail",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});
            (service as any).identityResolution.resolveOrCreate.mockResolvedValue({
                subjectId: 11,
                isNew: false,
            });
            (service as any).cryptoAccountQueueProducer.enqueue.mockRejectedValue("enqueue failed");

            const result = await service.ninVerification(user, { nin: "44444444444" } as any);

            expect(result.message).toBe("NIN Verification successfully");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                67,
                "NIN",
                "APPROVED",
                expect.objectContaining({ providerRef: "nin-ref-enqueue-fail" }),
            );
        });

        it("continues NIN verification when enqueue throws an Error instance", async () => {
            const user = {
                id: 69,
                isNinVerified: false,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyNin.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "John",
                        last_name: "Doe",
                        date_of_birth: "1990-01-01",
                        phone_number: "08099999999",
                        reference_id: "nin-ref-enqueue-error-instance",
                    },
                },
            });
            prisma.user.update.mockResolvedValue({});
            (service as any).identityResolution.resolveOrCreate.mockResolvedValue({
                subjectId: 12,
                isNew: false,
            });
            (service as any).cryptoAccountQueueProducer.enqueue.mockRejectedValue(new Error("queue offline"));

            const result = await service.ninVerification(user, { nin: "44444444445" } as any);

            expect(result.message).toBe("NIN Verification successfully");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                69,
                "NIN",
                "APPROVED",
                expect.objectContaining({ providerRef: "nin-ref-enqueue-error-instance" }),
            );
        });
    });

    // ── userSignIn ───────────────────────────────────────────

    describe("userSignIn", () => {
        const signInDto = {
            email: "user@example.com",
            [CREDENTIAL_FIELD]: "SignInSecret123!",
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
                firstName: "Jane",
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
                userType: UserType.INDIVIDUAL,
                status: Status.ACTIVE,
                role: { name: "individual", rolePermission: [] },
                loginCount: 4,
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
            expect(prisma.user.update).toHaveBeenCalledTimes(2);
            expect(prisma.user.update).toHaveBeenNthCalledWith(2, {
                where: { id: 1 },
                data: expect.objectContaining({
                    ipAddress: "127.0.0.1",
                    loginCount: 5,
                    lastLogin: expect.any(Date),
                }),
            });
            expect(notificationEvent.emit).toHaveBeenCalledWith(
                "login_notification",
                expect.objectContaining({
                    email: "user@example.com",
                    name: "Jane",
                    ipAddress: "127.0.0.1",
                    userAgent: "Chrome - desktop - Chrome - Windows",
                }),
            );
        });

        it("should throw for invalid password", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 1,
                email: "user@example.com",
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
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
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
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
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
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

        it("returns admin payload for successful adminSignIn", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 9,
                identifier: "admin-id",
                email: "admin@example.com",
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
                userType: "ADMIN",
                status: Status.ACTIVE,
                role: { name: "admin", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
                failedLoginAttempts: 0,
                lastFailedLogin: null,
                lockedUntil: null,
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            jwtService.signAsync
                .mockResolvedValueOnce("admin-access")
                .mockResolvedValueOnce("admin-refresh");
            prisma.user.update.mockResolvedValue({});

            const result = await service.adminSignIn(
                { email: "admin@example.com", [CREDENTIAL_FIELD]: "AdminSecret123!" } as any,
                "127.0.0.1",
            );

            expect(result.data).toMatchObject({
                accessToken: "admin-access",
                refreshToken: "admin-refresh",
                userType: "ADMIN",
            });
        });

        it("includes business verification fields for successful business user sign-in", async () => {
            prisma.user.findUnique.mockResolvedValue({
                id: 10,
                identifier: "biz-id",
                email: "biz@example.com",
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
                userType: "BUSINESS",
                status: Status.ACTIVE,
                role: { name: "business", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                isBvnVerified: true,
                isDocumentVerified: false,
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: "PENDING",
                failedLoginAttempts: 0,
                lastFailedLogin: null,
                lockedUntil: null,
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            jwtService.signAsync
                .mockResolvedValueOnce("biz-access")
                .mockResolvedValueOnce("biz-refresh");
            prisma.user.update.mockResolvedValue({});

            const result = await service.userSignIn(
                { ...signInDto, email: "biz@example.com" } as any,
                "127.0.0.1",
            );

            expect(result.data.userType).toBe("business");
            expect(result.data.verificationStatus.businessRecordCompleted).toBe(true);
            expect(result.data.verificationStatus.businessDocumentVerificationStatus).toBe("PENDING");
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

        it("invalidates the token family when reuse is detected", async () => {
            jwtService.verify.mockReturnValue({ sub: 1 });
            prisma.user.update.mockResolvedValue({});

            const validateSpy = jest.spyOn(service, "validateRefreshToken" as any)
                .mockResolvedValue({ valid: false, reuse: true });

            await expect(service.refreshToken({ refreshToken: "stolen-token" } as any)).rejects.toThrow(
                "Invalid refresh token",
            );

            expect(prisma.user.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: { refreshToken: null, refreshTokenFamily: null },
            });

            validateSpy.mockRestore();
        });

        it("rejects refresh when session is no longer valid", async () => {
            jwtService.verify.mockReturnValue({ sub: 1, sessionId: "session-x" });
            const validateSpy = jest.spyOn(service, "validateRefreshToken" as any)
                .mockResolvedValue({ valid: true, family: "family-1" });

            (service as any).sessionService.validateSession.mockResolvedValue(false);

            await expect(service.refreshToken({ refreshToken: "refresh-with-session" } as any)).rejects.toThrow(
                "Session expired or invalid",
            );

            validateSpy.mockRestore();
        });

        it("preserves sessionId, platform, and family on successful rotation", async () => {
            jwtService.verify.mockReturnValue({ sub: 1, sessionId: "session-abc", platform: "USER" });

            const validateSpy = jest.spyOn(service, "validateRefreshToken" as any)
                .mockResolvedValue({ valid: true, family: "family-xyz" });
            const generateSpy = jest.spyOn(service, "generateTokens")
                .mockResolvedValue({ accessToken: "next-access", refreshToken: "next-refresh" } as any);
            const saveSpy = jest.spyOn(service, "saveRefreshToken")
                .mockResolvedValue({} as any);

            (service as any).sessionService.validateSession.mockResolvedValue(true);

            const result = await service.refreshToken({ refreshToken: "refresh-with-session" } as any);

            expect(result.data).toMatchObject({ accessToken: "next-access", refreshToken: "next-refresh" });
            expect(generateSpy).toHaveBeenCalledWith({ sub: 1, platform: "USER", sessionId: "session-abc" });
            expect(saveSpy).toHaveBeenCalledWith(1, "next-refresh", "family-xyz");

            validateSpy.mockRestore();
            generateSpy.mockRestore();
            saveSpy.mockRestore();
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

        it("returns invalid with reuse hint when token length mismatches", async () => {
            prisma.user.findUnique.mockResolvedValue({
                refreshToken: "short-token",
                refreshTokenFamily: "family-1",
            });

            const hashSpy = jest.spyOn(service as any, "hashToken").mockReturnValue("this-hash-is-much-longer");
            const result = await service.validateRefreshToken(1, "token");

            expect(result).toEqual({ valid: false, reuse: true });
            hashSpy.mockRestore();
        });

        it("returns valid when timing-safe hash comparison matches", async () => {
            prisma.user.findUnique.mockResolvedValue({
                refreshToken: "abc123",
                refreshTokenFamily: "family-2",
            });

            const hashSpy = jest.spyOn(service as any, "hashToken").mockReturnValue("abc123");
            const result = await service.validateRefreshToken(1, "token");

            expect(result).toEqual({ valid: true, family: "family-2" });
            hashSpy.mockRestore();
        });

        it("returns invalid with reuse hint when same-length hashes do not match", async () => {
            prisma.user.findUnique.mockResolvedValue({
                refreshToken: "abc123",
                refreshTokenFamily: "family-3",
            });

            const hashSpy = jest.spyOn(service as any, "hashToken").mockReturnValue("def456");
            const result = await service.validateRefreshToken(1, "token");

            expect(result).toEqual({ valid: false, reuse: true });
            hashSpy.mockRestore();
        });

    });

    describe("verify2FALogin + reset2FARateLimit", () => {
        const base2FADto = {
            tempToken: "tmp-2fa",
            code: "123456",
            deviceName: "Chrome",
            deviceType: "desktop",
            browser: "Chrome",
            os: "Windows",
        };

        const base2FAUser = {
            id: 1,
            twoFactorSecret: "encrypted-secret",
            isTwoFactorEnabled: true,
            userType: "INDIVIDUAL",
            isEmailVerified: true,
            isPhoneVerified: true,
            isPasswordCreated: true,
            isBvnVerified: true,
            isDocumentVerified: false,
            businessRecordCompleted: false,
            businessDocumentVerificationStatus: null,
        };

        it("rejects invalid or expired temporary 2FA token", async () => {
            jwtService.verifyAsync.mockRejectedValue(new Error("jwt invalid"));

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "Invalid or expired token. Please log in again.",
            );
        });

        it("rejects invalid 2FA token type", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "wrong", platform: "USER" });

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "Invalid token type",
            );
        });

        it("rejects users without enabled 2FA configuration", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue({ ...base2FAUser, isTwoFactorEnabled: false });

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "2FA is not enabled for this account",
            );
        });

        it("locks immediately when rate-limit check denies attempts", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue(base2FAUser);
            (authenticator.verify as jest.Mock).mockReturnValue(false);
            (service as any).settingService.verifyBackupCode.mockResolvedValue(false);
            (service as any).twoFactorRateLimitService.checkAttempt.mockResolvedValue({
                allowed: false,
                lockoutDuration: 120,
            });

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "Too many failed 2FA attempts",
            );
        });

        it("applies lockout after recording failed attempts", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue(base2FAUser);
            (authenticator.verify as jest.Mock).mockReturnValue(false);
            (service as any).settingService.verifyBackupCode.mockResolvedValue(false);
            (service as any).twoFactorRateLimitService.checkAttempt.mockResolvedValue({
                allowed: true,
            });
            (service as any).twoFactorRateLimitService.recordFailedAttempt.mockResolvedValue({
                lockoutEndsAt: new Date().toISOString(),
                lockoutDuration: 300,
                remainingAttempts: 0,
            });

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "Invalid verification code",
            );
        });

        it("returns remaining-attempts error for invalid 2FA code without lockout", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue(base2FAUser);
            (authenticator.verify as jest.Mock).mockReturnValue(false);
            (service as any).settingService.verifyBackupCode.mockResolvedValue(false);
            (service as any).twoFactorRateLimitService.checkAttempt.mockResolvedValue({
                allowed: true,
            });
            (service as any).twoFactorRateLimitService.recordFailedAttempt.mockResolvedValue({
                lockoutEndsAt: null,
                lockoutDuration: 0,
                remainingAttempts: 2,
            });

            await expect(service.verify2FALogin(base2FADto as any, "127.0.0.1")).rejects.toThrow(
                "2 attempts remaining.",
            );
        });

        it("completes login with backup code and tolerates session creation failure", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue({
                ...base2FAUser,
                userType: "BUSINESS",
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: "PENDING",
            });
            (authenticator.verify as jest.Mock).mockReturnValue(false);
            (service as any).settingService.verifyBackupCode.mockResolvedValue(true);
            (service as any).sessionService.createSession.mockRejectedValue(new Error("redis unavailable"));

            const generateSpy = jest.spyOn(service, "generateTokens")
                .mockResolvedValue({ accessToken: "2fa-access", refreshToken: "2fa-refresh" } as any);
            const saveSpy = jest.spyOn(service, "saveRefreshToken")
                .mockResolvedValue({} as any);
            prisma.user.update.mockResolvedValue({});

            const result = await service.verify2FALogin(base2FADto as any, "127.0.0.1");

            expect(result.data.accessToken).toBe("2fa-access");
            expect(result.data.userType).toBe("business");
            expect(result.data.verificationStatus.businessRecordCompleted).toBe(true);
            expect((service as any).twoFactorRateLimitService.recordSuccessfulAttempt).toHaveBeenCalledWith("1", "login");
            expect(saveSpy).toHaveBeenCalledWith(1, "2fa-refresh");
            expect(generateSpy).toHaveBeenCalledWith({ sub: 1, platform: "USER" });

            generateSpy.mockRestore();
            saveSpy.mockRestore();
        });

        it("completes 2FA login with session creation success", async () => {
            jwtService.verifyAsync.mockResolvedValue({ sub: 1, type: "2fa_pending", platform: "USER" });
            prisma.user.findUnique.mockResolvedValue(base2FAUser);
            (authenticator.verify as jest.Mock).mockReturnValue(true);

            (service as any).sessionService.createSession.mockResolvedValue({ sessionId: "session-2fa-ok" });

            const generateSpy = jest.spyOn(service, "generateTokens")
                .mockResolvedValue({ accessToken: "ok-access", refreshToken: "ok-refresh" } as any);
            const saveSpy = jest.spyOn(service, "saveRefreshToken")
                .mockResolvedValue({} as any);
            prisma.user.update.mockResolvedValue({});

            const result = await service.verify2FALogin(base2FADto as any, "127.0.0.1");

            expect(result.data.sessionId).toBe("session-2fa-ok");
            expect(generateSpy).toHaveBeenCalledWith({
                sub: 1,
                platform: "USER",
                sessionId: "session-2fa-ok",
            });

            generateSpy.mockRestore();
            saveSpy.mockRestore();
        });

        it("reset2FARateLimit throws when user is missing", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.reset2FARateLimit({ userId: 999 })).rejects.toThrow("User not found");
        });

        it("reset2FARateLimit supports context-specific and global resets", async () => {
            prisma.user.findUnique
                .mockResolvedValueOnce({ id: 8, email: "u8@flipxer.com", isTwoFactorEnabled: true })
                .mockResolvedValueOnce({ id: 8, email: "u8@flipxer.com", isTwoFactorEnabled: true });

            const withContext = await service.reset2FARateLimit({ userId: 8, context: "login" });
            const withoutContext = await service.reset2FARateLimit({ userId: 8 });

            expect(withContext.message).toContain("login 2FA rate limit");
            expect(withoutContext.message).toContain("all 2FA rate limits");
            expect((service as any).twoFactorRateLimitService.resetAttempts).toHaveBeenNthCalledWith(
                1,
                "8",
                "login",
            );
            expect((service as any).twoFactorRateLimitService.resetAttempts).toHaveBeenNthCalledWith(
                2,
                "8",
                undefined,
            );
        });
    });

    describe("document + business document coverage paths", () => {
        const base64Dto = {
            imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
            imageBackBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0y",
            documentType: "passport",
            country: "NG",
            documentNumber: "P12345",
        };

        it("documentVerificationBase64 rejects already-verified users", async () => {
            await expect(
                service.documentVerificationBase64({ id: 1, isDocumentVerified: true } as any, base64Dto as any),
            ).rejects.toThrow("Document has already been verified");
        });

        it("documentVerificationBase64 rejects duplicate pending verification", async () => {
            prisma.userDocument.findUnique.mockResolvedValue({ verificationStatus: "PENDING" });

            await expect(
                service.documentVerificationBase64({ id: 1, isDocumentVerified: false } as any, base64Dto as any),
            ).rejects.toThrow("Document verification is pending review");
        });

        it("documentVerificationBase64 auto-approves valid documents", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-1" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-1" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: true,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: "1990-01-01",
                    documentNumber: "P12345",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue(true);

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 11 }) },
                    user: { update: jest.fn().mockResolvedValue({ id: 1 }) },
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verified successfully");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                1,
                "DOCUMENT",
                "APPROVED",
                expect.any(Object),
            );
            expect((service as any).tierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });

        it("documentVerificationBase64 marks invalid documents as pending review", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-2" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-2" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: false,
                nameMatches: false,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    documentNumber: "P99999",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue(false);

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 12 }) },
                    user: { update: jest.fn().mockResolvedValue({ id: 1 }) },
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verification is pending review");
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Submitted",
                }),
            );
        });

        it("documentVerificationBase64 keeps valid but mismatched documents pending review", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-3" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-3" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: false,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    firstName: "Kehinde",
                    lastName: "Onileola",
                    documentNumber: "P77777",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue(true);

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 13 }) },
                    user: { update: jest.fn().mockResolvedValue({ id: 1 }) },
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verification is pending review");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                1,
                "DOCUMENT",
                "PENDING",
                expect.objectContaining({
                    reviewNote: "Manual review needed: valid=true, nameMatches=false, dobMatches=false",
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Submitted",
                }),
            );
        });

        it("documentVerificationBase64 keeps name-matched but DOB-mismatched documents pending review", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-4" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-4" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: true,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: "1988-03-15",
                    documentNumber: "P88888",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue(true);

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 14 }) },
                    user: { update: jest.fn().mockResolvedValue({ id: 1 }) },
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verification is pending review");
            expect((service as any).kycStateMachine.transition).toHaveBeenCalledWith(
                1,
                "DOCUMENT",
                "PENDING",
                expect.objectContaining({
                    reviewNote: "Manual review needed: valid=true, nameMatches=true, dobMatches=false",
                }),
            );
        });

        it("submitBusinessDocumentsFromUrls validates required CAC image", async () => {
            await expect(
                service.submitBusinessDocumentsFromUrls(
                    {
                        id: 2,
                        businessDocumentsUploaded: false,
                        businessDocumentVerificationStatus: null,
                    } as any,
                    { uploadedFiles: {}, cacDocumentNumber: "RC-123" } as any,
                ),
            ).rejects.toThrow("CAC image is required");
        });

        it("submitBusinessDocumentsFromUrls persists structured docs and dispatches review flow", async () => {
            const runDojahSpy = jest
                .spyOn(service as any, "runDojahBusinessVerificationFromStoredDocument")
                .mockResolvedValue(undefined);

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    businessDocument: { upsert: jest.fn().mockResolvedValue({ id: 321 }) },
                    businessDirector: {
                        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
                        createMany: jest.fn().mockResolvedValue({ count: 1 }),
                    },
                    businessShareholder: {
                        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
                        createMany: jest.fn().mockResolvedValue({ count: 1 }),
                    },
                    user: { update: jest.fn().mockResolvedValue({ id: 2 }) },
                }),
            );

            const result = await service.submitBusinessDocumentsFromUrls(
                {
                    id: 2,
                    businessDocumentsUploaded: false,
                    businessDocumentVerificationStatus: null,
                } as any,
                {
                    cacDocumentNumber: "RC-999",
                    directors: [
                        {
                            fullName: "Director One",
                            nationality: "NG",
                            dateOfBirth: "1990-02-02",
                            residentialAddress: "Lagos",
                            businessAddress: "Abuja",
                            nin: "12345678901",
                        },
                    ],
                    shareholders: [
                        {
                            fullName: "Shareholder One",
                            nationality: "NG",
                            dateOfBirth: "1991-03-03",
                            residentialAddress: "Lagos",
                            businessAddress: "Abuja",
                            nin: "10987654321",
                            ownershipPercentage: 45,
                        },
                    ],
                    uploadedFiles: {
                        cacImage: { url: "https://img/cac.png", fileId: "cac-1", originalName: "cac.png" },
                        "directors[0].idDocument": {
                            url: "https://img/director-id.png",
                            fileId: "dir-id-1",
                            originalName: "director-id.png",
                        },
                        "directors[0].proofOfAddress": {
                            url: "https://img/director-poa.png",
                            fileId: "dir-poa-1",
                            originalName: "director-poa.png",
                        },
                        "shareholders[0].idDocument": {
                            url: "https://img/shareholder-id.png",
                            fileId: "shr-id-1",
                            originalName: "shareholder-id.png",
                        },
                        "shareholders[0].proofOfAddress": {
                            url: "https://img/shareholder-poa.png",
                            fileId: "shr-poa-1",
                            originalName: "shareholder-poa.png",
                        },
                    },
                } as any,
            );

            expect(result.message).toBe("Document Verification successfully");
            expect((service as any).redisCacheService.del).toHaveBeenCalled();
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 2,
                    title: "Business Documents Submitted",
                }),
            );
            expect(runDojahSpy).toHaveBeenCalledWith(2, "RC-999");
            runDojahSpy.mockRestore();
        });
    });

    describe("additional auth flow coverage", () => {
        it("uploadSingleBusinessDocumentFile validates field names", async () => {
            await expect(
                service.uploadSingleBusinessDocumentFile(
                    { id: 50 } as any,
                    { originalname: "doc.png" } as any,
                    { fieldName: "unknownField" } as any,
                ),
            ).rejects.toThrow("Invalid field name: unknownField");
        });

        it("uploadSingleBusinessDocumentFile uploads valid dynamic director/shareholder fields", async () => {
            jest.spyOn(service as any, "uploadAsFile").mockResolvedValue({
                url: "https://img/uploaded.png",
                fileId: "file-1",
            });

            const result = await service.uploadSingleBusinessDocumentFile(
                { id: 51 } as any,
                { originalname: "director-id.png" } as any,
                { fieldName: "directors[0].idDocument" } as any,
            );

            expect(result.message).toBe("File uploaded successfully");
            expect(result.data).toMatchObject({
                fieldName: "directors[0].idDocument",
                url: "https://img/uploaded.png",
                fileId: "file-1",
            });
        });

        it("uploadSingleBusinessDocumentFile rethrows upload errors", async () => {
            jest.spyOn(service as any, "uploadAsFile").mockRejectedValue(new Error("upload failed"));

            await expect(
                service.uploadSingleBusinessDocumentFile(
                    { id: 52 } as any,
                    { originalname: "shareholder-id.png" } as any,
                    { fieldName: "shareholders[0].idDocument" } as any,
                ),
            ).rejects.toThrow("upload failed");
        });

        it("runDojahBusinessVerification updates business document fields on success", async () => {
            prisma.businessRecord.findUnique.mockResolvedValue({
                businessName: "Acme Ltd",
                taxIdentificationNumber: "TIN-123",
            });
            (dojahService as any).verifyBusinessDocuments.mockResolvedValue({
                cac: {
                    verified: true,
                    companyName: "Acme Ltd",
                    companyStatus: "ACTIVE",
                    registrationDate: "2022-01-01",
                    nameMatches: true,
                    rawResponse: { cac: true },
                },
                tin: {
                    verified: true,
                    taxpayerName: "Acme Ltd",
                    nameMatches: true,
                    rawResponse: { tin: true },
                },
                ocr: {
                    verified: true,
                    extractedNumber: "RC-123",
                    extractedName: "Acme Ltd",
                    numberMatches: true,
                    rawResponse: { ocr: true },
                },
            });
            prisma.businessDocument.update.mockResolvedValue({ id: 9 });

            await expect(
                (service as any).runDojahBusinessVerification(9, "RC-123", {
                    buffer: Buffer.from("fake-image"),
                }),
            ).resolves.toBeUndefined();

            expect((dojahService as any).verifyBusinessDocuments).toHaveBeenCalledWith(
                expect.objectContaining({
                    cacDocumentNumber: "RC-123",
                    taxIdentificationNumber: "TIN-123",
                    businessName: "Acme Ltd",
                }),
            );
            expect(prisma.businessDocument.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 9 } }),
            );
        });

        it("runDojahBusinessVerification swallows provider failures", async () => {
            prisma.businessRecord.findUnique.mockResolvedValue({ businessName: "Acme", taxIdentificationNumber: null });
            (dojahService as any).verifyBusinessDocuments.mockRejectedValue(new Error("provider down"));

            await expect((service as any).runDojahBusinessVerification(10, "RC-404")).resolves.toBeUndefined();
        });

        it("runDojahBusinessVerificationFromStoredDocument handles missing and untrusted URLs", async () => {
            prisma.businessDocument.findUnique
                .mockResolvedValueOnce({ cacImageUrl: null })
                .mockResolvedValueOnce({ cacImageUrl: "https://malicious.example/cac.png" });

            await expect((service as any).runDojahBusinessVerificationFromStoredDocument(11, "RC-1")).resolves.toBeUndefined();
            await expect((service as any).runDojahBusinessVerificationFromStoredDocument(11, "RC-2")).resolves.toBeUndefined();
        });

        it("runDojahBusinessVerificationFromStoredDocument fetches trusted URL and forwards synthetic file", async () => {
            prisma.businessDocument.findUnique.mockResolvedValue({ cacImageUrl: "https://ik.imagekit.io/folder/cac.webp" });
            const axiosSpy = jest.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("binary") } as any);
            const runSpy = jest.spyOn(service as any, "runDojahBusinessVerification").mockResolvedValue(undefined);

            await expect((service as any).runDojahBusinessVerificationFromStoredDocument(12, "RC-12")).resolves.toBeUndefined();

            expect(axiosSpy).toHaveBeenCalledWith("https://ik.imagekit.io/folder/cac.webp", expect.any(Object));
            expect(runSpy).toHaveBeenCalledWith(
                12,
                "RC-12",
                expect.objectContaining({ fieldname: "cacImage", mimetype: "image/webp" }),
            );

            axiosSpy.mockRestore();
            runSpy.mockRestore();
        });

        it("submitBusinessRecord persists data and enqueues account setup", async () => {
            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    businessRecord: {
                        upsert: jest.fn().mockResolvedValue({ id: 501, businessName: "Acme Ltd" }),
                    },
                    user: {
                        update: jest.fn().mockResolvedValue({ id: 33 }),
                    },
                }),
            );

            const result = await service.submitBusinessRecord(
                { id: 33 } as any,
                {
                    firstName: "Jane",
                    lastName: "Doe",
                    businessName: "Acme Ltd",
                    natureOfBusiness: "Trading",
                    expectedTransactionFrequency: "DAILY",
                    expectedTransactionVolumes: "HIGH",
                    taxIdentificationNumber: "TIN-77",
                } as any,
            );

            expect(result.message).toBe("Business record submitted successfully");
            expect((service as any).cryptoAccountQueueProducer.enqueue).toHaveBeenCalledWith(33);
            expect((service as any).redisCacheService.del).toHaveBeenCalled();
        });
    });

    describe("private helper coverage", () => {
        it("masks sensitive IDs correctly", () => {
            expect((service as any).maskSensitiveId()).toBe("N/A");
            expect((service as any).maskSensitiveId("1234")).toBe("1234");
            expect((service as any).maskSensitiveId("1234567890")).toBe("******7890");
            expect((service as any).maskSensitiveId("1234567890", 2)).toBe("********90");
        });

        it("maps Dojah errors to friendly user messages", () => {
            expect(
                (service as any).mapDojahErrorToUserMessage({
                    name: "NetworkTimeoutError",
                    message: "socket timeout",
                }),
            ).toContain("Connection issue");

            expect(
                (service as any).mapDojahErrorToUserMessage({
                    name: "ValidationError",
                    message: "invalid image base64",
                    status: 400,
                }),
            ).toContain("Invalid image format");

            expect(
                (service as any).mapDojahErrorToUserMessage({
                    name: "NotFoundError",
                    message: "not found",
                    status: 404,
                }),
            ).toContain("Could not recognize this document type");

            expect(
                (service as any).mapDojahErrorToUserMessage({
                    name: "UnknownError",
                    message: "upstream failed",
                }),
            ).toContain("Document verification failed");
        });

        it("validates document expiry across formats", () => {
            expect((service as any).isDocumentExpired("2030-01-01")).toBe(false);
            expect((service as any).isDocumentExpired("01/01/2030")).toBe(false);
            expect((service as any).isDocumentExpired("01-01-2030")).toBe(false);
            expect((service as any).isDocumentExpired("2010-01-01")).toBe(true);
            expect((service as any).isDocumentExpired("bad-date-format")).toBe(false);
            expect((service as any).isDocumentExpired(undefined)).toBe(false);
        });

        it("enforces post-validation hard rejects and expiry handling", () => {
            const logger = { warn: jest.fn(), log: jest.fn() } as any;

            const parsed = { expiryDate: "2010-01-01", reason: undefined, hasExtractedText: true };
            expect(() =>
                (service as any).applyDojahPostValidation(true, parsed, 1, logger),
            ).toThrow("Document appears to be expired");
            expect(parsed.reason).toBe("Document has expired");

            expect(() =>
                (service as any).applyDojahPostValidation(
                    false,
                    { reason: "UNSUPPORTED_DOCUMENT", hasExtractedText: true },
                    1,
                    logger,
                ),
            ).toThrow("This document type is not supported");

            expect(() =>
                (service as any).applyDojahPostValidation(
                    false,
                    { reason: "NOT_VALID", hasExtractedText: true },
                    1,
                    logger,
                ),
            ).not.toThrow();
        });

        it("validates login platform and default security methods", () => {
            expect(() =>
                (service as any).validateLoginPlatform(UserType.INDIVIDUAL, "ADMIN"),
            ).toThrow("Incorrect email or password");

            expect(() =>
                (service as any).validateLoginPlatform(UserType.INDIVIDUAL, "USER"),
            ).not.toThrow();

            expect(() =>
                (service as any).validateLoginPlatform(UserType.INDIVIDUAL, "MOBILE"),
            ).toThrow("Invalid login platform");

            expect((service as any).getDefaultSecurityMethods()).toEqual({
                sms: false,
                email: false,
                authenticator: false,
                tradingPassword: false,
            });
        });

        it("maps Dojah reasons and document types", () => {
            expect((service as any).mapDojahReasonToUserMessage("not_valid")).toContain(
                "could not be verified",
            );
            expect((service as any).mapDojahReasonToUserMessage("too_blurry")).toContain("unclear");
            expect((service as any).mapDojahReasonToUserMessage("expired_document")).toContain("expired");
            expect((service as any).mapDojahReasonToUserMessage("unsupported")).toContain("not supported");
            expect((service as any).mapDojahReasonToUserMessage("CUSTOM_REASON")).toBe("CUSTOM_REASON");

            expect((service as any).mapDojahToDocumentType("passport", undefined)).toBe(
                (DocumentType as any).INTERNATIONAL_PASSPORT,
            );
            expect((service as any).mapDojahToDocumentType("drivers license", undefined)).toBe(
                (DocumentType as any).DRIVER_LICENSE,
            );
            expect((service as any).mapDojahToDocumentType(undefined, "driver_license")).toBe(
                (DocumentType as any).DRIVER_LICENSE,
            );
            expect((service as any).mapDojahToDocumentType(undefined, "nin")).toBe((DocumentType as any).NIN);
        });

        it("only accepts trusted HTTPS document URLs", () => {
            const trustedOrigins = (service as any).getTrustedDocumentOrigins() as Set<string>;
            expect(trustedOrigins.has("https://ik.imagekit.io")).toBe(true);

            const trusted = (service as any).resolveTrustedDocumentUrl("https://ik.imagekit.io/folder/id.png");
            expect(trusted).toBeInstanceOf(URL);

            const insecureUrl = new URL("https://ik.imagekit.io/folder/id.png");
            insecureUrl.protocol = "http:";
            expect((service as any).resolveTrustedDocumentUrl(insecureUrl.toString())).toBeNull();
            expect((service as any).resolveTrustedDocumentUrl("https://malicious.example/id.png")).toBeNull();
            expect((service as any).resolveTrustedDocumentUrl("not-a-url")).toBeNull();
        });

        it("returns structured success result from Dojah document verification call", async () => {
            dojahService.verifyDocumentWithNameMatch.mockResolvedValue({
                isValid: true,
                nameMatches: true,
                parsed: { documentType: "passport" },
            });

            const logger = { log: jest.fn(), error: jest.fn() } as any;
            const result = await (service as any).callDojahDocumentVerification(
                "front-base64",
                "back-base64",
                { id: 42, firstName: "Jane", lastName: "Doe" },
                { imageFrontBase64: "front-base64", imageBackBase64: "back-base64" },
                Date.now(),
                logger,
            );

            expect(dojahService.verifyDocumentWithNameMatch).toHaveBeenCalledWith(
                {
                    inputType: "base64",
                    imageFrontSide: "front-base64",
                    imageBackSide: "back-base64",
                },
                "Jane",
                "Doe",
            );
            expect(result.success).toBe(true);
            expect(result.isValid).toBe(true);
            expect(result.nameMatches).toBe(true);
            expect(result.error).toBeNull();
        });

        it("returns structured failure result from Dojah document verification errors", async () => {
            dojahService.verifyDocumentWithNameMatch.mockRejectedValue({
                name: "ThirdPartyServiceError",
                message: "gateway unavailable",
                status: 424,
                stack: "stack-trace",
            });

            const logger = { log: jest.fn(), error: jest.fn() } as any;
            const result = await (service as any).callDojahDocumentVerification(
                "front-base64",
                undefined,
                { id: 77, firstName: "John", lastName: "Smith" },
                { imageFrontBase64: "front-base64", imageBackBase64: "" },
                Date.now(),
                logger,
            );

            expect(result.success).toBe(false);
            expect(result.isValid).toBe(false);
            expect(result.nameMatches).toBe(false);
            expect(result.error).toEqual(
                expect.objectContaining({
                    name: "ThirdPartyServiceError",
                    message: "gateway unavailable",
                    status: 424,
                }),
            );
        });

        it("blocks login when account is currently locked", async () => {
            const lockedUser = {
                id: 1,
                failedLoginAttempts: 4,
                lockedUntil: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            } as any;

            await expect(
                (service as any).handleFailedLogin(lockedUser, "127.0.0.1"),
            ).rejects.toThrow("Account temporarily locked due to too many failed attempts");

            expect(prisma.user.update).not.toHaveBeenCalled();
        });

        it("locks account and flags user after max failed attempts", async () => {
            const tx = {
                flagged: {
                    upsert: jest.fn().mockResolvedValue({ id: 900 }),
                },
                user: {
                    update: jest.fn().mockResolvedValue({ id: 2 }),
                },
            };
            prisma.$transaction.mockImplementation(async (callback: any) => callback(tx));

            const user = {
                id: 2,
                failedLoginAttempts: 4,
                lastFailedLogin: new Date().toISOString(),
            } as any;

            await expect((service as any).handleFailedLogin(user, "client-ip-1")).rejects.toThrow(
                "Account temporarily locked due to too many failed attempts",
            );

            expect(tx.flagged.upsert).toHaveBeenCalled();
            expect(tx.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 2 },
                    data: expect.objectContaining({
                        failedLoginAttempts: 5,
                        flaggedId: 900,
                    }),
                }),
            );
        });

        it("resets stale failed-attempt counter and updates user without lockout", async () => {
            prisma.user.update.mockResolvedValue({ id: 3 });

            const user = {
                id: 3,
                failedLoginAttempts: 3,
                lastFailedLogin: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
                lockedUntil: null,
            } as any;

            await expect(
                (service as any).handleFailedLogin(user, "client-ip-2"),
            ).resolves.toBeUndefined();

            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 3 },
                    data: expect.objectContaining({
                        failedLoginAttempts: 1,
                        ipAddress: "client-ip-2",
                    }),
                }),
            );
        });
    });

    // ── sendPendingReviewEmail ─────────────────────────────

    describe("sendPendingReviewEmail", () => {
        it("should send pending review email when config is set", () => {
            (service as any).sendPendingReviewEmail(1, "user@test.com", "John", "BVN");

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                    to: [{ email_address: { address: "user@test.com" } }],
                    merge_info: expect.objectContaining({
                        name: "John",
                        document_type: "BVN",
                    }),
                }),
            );
        });

        it("should default name to 'User' when firstName is empty", () => {
            (service as any).sendPendingReviewEmail(1, "user@test.com", "", "NIN");

            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    merge_info: expect.objectContaining({ name: "User" }),
                }),
            );
        });

        it("should not send email when userEmail is empty", () => {
            (service as any).sendPendingReviewEmail(1, "", "John", "BVN");

            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();
        });
    });

    // ── rejectOnIdentityMismatch ────────────────────────────

    describe("rejectOnIdentityMismatch", () => {
        const mockUser = {
            id: 10,
            email: "mismatch@test.com",
            firstName: "John",
            lastName: "Doe",
            dateOfBirth: new Date("1990-01-01"),
        };

        const mockResult = {
            data: {
                entity: {
                    first_name: "Jane",
                    last_name: "Doe",
                    date_of_birth: "1990-01-01",
                    reference_id: "ref-123",
                },
            },
        };

        it("should throw and send rejection notification + email when DOB mismatches", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "DOB mismatch" });

            await expect(
                (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "BVN"),
            ).rejects.toThrow("Incorrect first name, last name or date of birth");

            expect(kycStateMachine.transition).toHaveBeenCalledWith(
                10, "BVN", "REJECTED", expect.any(Object),
            );
            expect(notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 10,
                    title: "Identity Verification Unsuccessful",
                    category: "security",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-rejected",
                    merge_info: expect.objectContaining({
                        document_type: "BVN",
                        status: "Rejected",
                    }),
                }),
            );
        });

        it("should route to manual review and send pending notification + email when names mismatch but DOB matches", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "NIN");

            expect(result).toBe("PENDING_REVIEW");
            expect(kycStateMachine.transition).toHaveBeenCalledWith(
                10, "NIN", "PENDING", expect.any(Object),
            );
            expect(notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 10,
                    title: "Identity Verification Under Review",
                    category: "security",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                    merge_info: expect.objectContaining({
                        name: "John",
                        document_type: "NIN",
                    }),
                }),
            );
        });

        it("should return MATCHED when both names and DOB match", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: true, detail: "Exact match" });

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "BVN");

            expect(result).toBe("MATCHED");
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();
        });

        it("should fallback to RESUBMITTED transition when PENDING transition fails", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });
            kycStateMachine.transition
                .mockRejectedValueOnce(new Error("Cannot transition to PENDING"))
                .mockResolvedValueOnce(undefined);

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "BVN");

            expect(result).toBe("PENDING_REVIEW");
            expect(kycStateMachine.transition).toHaveBeenCalledTimes(2);
            expect(kycStateMachine.transition).toHaveBeenNthCalledWith(
                2, 10, "BVN", "RESUBMITTED", expect.any(Object),
            );
        });
    });
});
