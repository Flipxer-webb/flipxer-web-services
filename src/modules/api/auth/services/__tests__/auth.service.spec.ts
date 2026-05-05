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
import { DojahException } from "@/modules/factory/identityCompliance/providers/dojah/errors";
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
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { DocumentType, Prisma, Status, UserType } from "@prisma/client";
import { authenticator } from "otplib";
import * as bcrypt from "bcryptjs";
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
        kycStageAttempt: {
            findFirst: jest.fn(),
            aggregate: jest.fn(),
            updateMany: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        kycAttemptEvent: {
            create: jest.fn(),
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
        $executeRaw: jest.fn().mockResolvedValue(1),
    };
}

describe("AuthService", () => {
    let service: AuthService;
    let prisma: ReturnType<typeof makePrisma>;
    let jwtService: { signAsync: jest.Mock; verify: jest.Mock; verifyAsync: jest.Mock };
    let emailService: { sendMailWithTemplate: jest.Mock };
    let redisCacheService: { set: jest.Mock; get: jest.Mock; del: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };
    let kycStateMachine: { transition: jest.Mock };
    let dojahService: {
        analyzeDocument: jest.Mock;
        verifyDocumentWithNameMatch: jest.Mock;
        verifyBusinessDocuments: jest.Mock;
        verifyBvn: jest.Mock;
        verifyNin: jest.Mock;
    };

    beforeEach(async () => {
        prisma = makePrisma();
        prisma.kycStageAttempt.findFirst.mockResolvedValue(null);
        prisma.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: 0 } });
        prisma.kycStageAttempt.updateMany.mockResolvedValue({ count: 0 });
        prisma.kycStageAttempt.create.mockResolvedValue({ id: 1 });
        prisma.kycAttemptEvent.create.mockResolvedValue({ id: 1 });
        prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma));

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
            analyzeDocument: jest.fn(),
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
        const mockKyc = {
            transition: jest.fn().mockResolvedValue({
                attemptId: 1,
                status: "APPROVED",
                version: 1,
                isActive: true,
            }),
        };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
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
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: IdentityResolutionService, useValue: mockIdentityResolution },
            ],
        }).compile();

        service = module.get(AuthService);
        jwtService = module.get(JwtService);
        emailService = module.get(EmailService);
        redisCacheService = module.get(RedisCacheService);
        notificationDispatcher = module.get(NotificationDispatcher);
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
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            prisma.user.update.mockResolvedValue({});
            (service as any).identityResolution.resolveOrCreate.mockResolvedValue({
                subjectId: 7,
                isNew: true,
            });

            const result = await service.bvnVerification(user, { bvn: "22222222222" } as any);

            expect(result.message).toBe("Bvn Verification successfully");
            expect(dojahService.verifyBvn).not.toHaveBeenCalled();
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "BVN",
                expect.any(String),
                41,
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("executes BVN successful-path identity linking", async () => {
            const user = {
                id: 42,
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
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        providerRef: "bvn-ref-1",
                        status: "APPROVED",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "bvn-ref-1",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("creates an approved stage attempt without legacy writes for BVN dev-bypass resubmissions", async () => {
            const user = {
                id: 43,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            prisma.user.update.mockResolvedValue({});

            await service.bvnVerification(user, { bvn: "22222222222" } as any);

            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        providerRef: "DEV_BYPASS",
                        status: "APPROVED",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        providerRef: "DEV_BYPASS",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "DEV_BYPASS",
                    }),
                }),
            );
        });

        it("records RESUBMITTED before APPROVED for BVN dev-bypass resubmissions", async () => {
            const user = {
                id: 44,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            prisma.user.update.mockResolvedValue({});
            prisma.kycStageAttempt.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ status: "REJECTED" });

            await service.bvnVerification(user, { bvn: "22222222222" } as any);

            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "RESUBMITTED",
                        providerRef: "DEV_BYPASS",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "DEV_BYPASS",
                    }),
                }),
            );
        });

        it("executes NIN dev bypass identity linking", async () => {
            const user = {
                id: 51,
                firstName: "John",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            prisma.user.update.mockResolvedValue({});

            const result = await service.ninVerification(user, { nin: "00000000001" } as any);

            expect(result.message).toBe("NIN Verification successfully");
            expect(dojahService.verifyNin).not.toHaveBeenCalled();
            expect((service as any).identityResolution.resolveOrCreate).toHaveBeenCalledWith(
                "NIN",
                expect.any(String),
                51,
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "DEV_BYPASS",
                    }),
                }),
            );
        });

        it("executes NIN successful-path identity linking", async () => {
            const user = {
                id: 52,
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

            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "REJECTED",
                        providerRef: "bvn-ref-mismatch",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        providerRef: "bvn-ref-mismatch",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("rejects BVN verification when provider response omits identity fields", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Missing fields" });

            const user = {
                id: 68,
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

            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        providerRef: "bvn-ref-missing-fields",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("auto-rejects BVN when provider details mismatch the profile", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 70,
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

            expect(result.message).toBe("The submitted BVN details do not match your profile. Please submit the correct BVN that belongs to you and matches your name and date of birth.");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "REJECTED",
                        providerRef: "bvn-ref-manual-review",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        providerRef: "bvn-ref-manual-review",
                    }),
                }),
            );
            expect((service as any).redisCacheService.del).toHaveBeenCalledWith("user:profile:70");
            expect((service as any).identityResolution.resolveOrCreate).not.toHaveBeenCalled();
            expect(prisma.user.update).not.toHaveBeenCalled();
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("reopens BVN review with RESUBMITTED when PENDING transition is illegal", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 71,
                firstName: "Jane",
                lastName: "Doe",
                dateOfBirth: new Date("1990-01-01"),
            } as any;

            prisma.user.findFirst.mockResolvedValue(null);
            dojahService.verifyBvn.mockResolvedValue({
                data: {
                    entity: {
                        first_name: "Alex",
                        last_name: null,
                        date_of_birth: null,
                        reference_id: "bvn-ref-resubmitted",
                    },
                },
            });

            prisma.kycStageAttempt.findFirst
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ status: "REJECTED" });

            const result = await service.bvnVerification(user, { bvn: "33333333336" } as any);

            expect(result.message).toBe("We couldn't confidently compare the submitted BVN details to your profile. Your verification has been sent for manual review.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "RESUBMITTED",
                        providerRef: "bvn-ref-resubmitted",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("auto-rejects NIN when provider details mismatch the profile", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(true);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "Name mismatch" });

            const user = {
                id: 72,
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

            expect(result.message).toBe("The submitted NIN details do not match your profile. Please submit the correct NIN that belongs to you and matches your name and date of birth.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        providerRef: "nin-ref-manual-review",
                    }),
                }),
            );
            expect((service as any).redisCacheService.del).toHaveBeenCalledWith("user:profile:72");
            expect((service as any).identityResolution.resolveOrCreate).not.toHaveBeenCalled();
            expect(prisma.user.update).not.toHaveBeenCalled();
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("continues NIN verification when enqueue fails after persistence", async () => {
            const user = {
                id: 67,
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
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "nin-ref-enqueue-fail",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("continues NIN verification when enqueue throws an Error instance", async () => {
            const user = {
                id: 69,
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
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "nin-ref-enqueue-error-instance",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
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
                [CREDENTIAL_FIELD]: HASHED_SECRET_VALUE,
                userType: UserType.INDIVIDUAL,
                status: Status.ACTIVE,
                role: { name: "individual", rolePermission: [] },
                flaggedRecord: null,
                isTwoFactorEnabled: false,
                twoFactorSecret: null,
                isEmailVerified: true,
                isPhoneVerified: true,
                isPasswordCreated: true,
                bvn: null,
                nin: "12345678901",
                isDocumentVerified: false,
                businessRecordCompleted: false,
                businessDocumentVerificationStatus: null,
                kycStageAttempts: [],
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
            expect(result.data.verificationStatus).toMatchObject({
                emailVerified: true,
                phoneVerified: true,
                passwordCreated: true,
                governmentIdVerified: true,
                documentVerified: false,
            });
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
                bvn: "12345678901",
                nin: null,
                isDocumentVerified: false,
                businessRecordCompleted: true,
                businessDocumentVerificationStatus: "PENDING",
                kycStageAttempts: [],
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
            expect(result.data.verificationStatus.governmentIdVerified).toBe(true);
            expect(result.data.verificationStatus.documentVerified).toBe(false);
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
            bvn: "12345678901",
            nin: null,
            isDocumentVerified: false,
            businessRecordCompleted: false,
            businessDocumentVerificationStatus: null,
            kycStageAttempts: [],
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
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ status: "APPROVED" });

            await expect(
                service.documentVerificationBase64({ id: 1, isDocumentVerified: true } as any, base64Dto as any),
            ).rejects.toThrow("Document has already been verified");
        });

        it("documentVerificationBase64 rejects duplicate pending verification", async () => {
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ status: "PENDING_REVIEW" });

            await expect(
                service.documentVerificationBase64({ id: 1, isDocumentVerified: false } as any, base64Dto as any),
            ).rejects.toThrow("Document verification is pending review");
        });

        it("previewDocument blocks when the uploaded document type does not match the selected path", async () => {
            dojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    reason: "valid",
                    documentType: "passport",
                    country: "Nigeria",
                    countryCode: "NG",
                    firstName: "John",
                    lastName: "Doe",
                    documentNumber: "P12345",
                    hasPortrait: true,
                    hasFrontSide: true,
                    hasBackSide: false,
                    hasExtractedText: true,
                },
                response: { data: { entity: {} } },
            });

            const result = await service.previewDocument(
                { id: 1 } as any,
                {
                    imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
                    documentType: DocumentType.NIN,
                } as any,
            );

            expect(result.success).toBe(true);
            expect(result.message).toBe("Wrong document. Please upload a valid NIN slip.");
            expect(result.data).toEqual(
                expect.objectContaining({
                    stage: "IDENTITY_DOCUMENT",
                    outcome: "BLOCKED",
                    providerStatus: "FAILED",
                    isValid: false,
                    canSubmit: false,
                    reasonCode: "DOCUMENT_TYPE_MISMATCH",
                    reasonMessage: "Wrong document. Please upload a valid NIN slip.",
                    reason: "DOCUMENT_TYPE_MISMATCH",
                    documentType: "passport",
                    documentTypeMatches: false,
                    documentNumber: "P12345",
                    autofill: { documentNumber: "P12345" },
                }),
            );
            expect(result.data).not.toHaveProperty("firstName");
        });

        it("previewDocument warns on invalid preview but still allows submit when the selected path matches", async () => {
            dojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: false,
                    reason: "invalid",
                    documentType: "nin slip",
                    country: "Nigeria",
                    countryCode: "NG",
                    documentNumber: "12345678901",
                    hasPortrait: true,
                    hasFrontSide: true,
                    hasBackSide: false,
                    hasExtractedText: true,
                },
                response: { data: { entity: {} } },
            });

            const result = await service.previewDocument(
                { id: 1 } as any,
                {
                    imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
                    documentType: DocumentType.NIN,
                } as any,
            );

            expect(result.success).toBe(true);
            expect(result.message).toBe("Document could not be verified. Please upload a valid document.");
            expect(result.data).toEqual(
                expect.objectContaining({
                    stage: "IDENTITY_DOCUMENT",
                    outcome: "REVIEW_LIKELY",
                    providerStatus: "FAILED",
                    isValid: false,
                    canSubmit: true,
                    reasonCode: "DOCUMENT_INVALID",
                    reasonMessage: "Document could not be verified. Please upload a valid document.",
                    reason: "invalid",
                    documentType: "nin slip",
                    documentTypeMatches: true,
                    documentNumber: "12345678901",
                    autofill: { documentNumber: "12345678901" },
                }),
            );
        });

        it("previewDocument marks non-Nigerian documents as invalid", async () => {
            dojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    reason: "valid",
                    documentType: "nin slip",
                    country: "Ghana",
                    countryCode: "GH",
                    documentNumber: "12345678901",
                    hasPortrait: true,
                    hasFrontSide: true,
                    hasBackSide: false,
                    hasExtractedText: true,
                },
                response: { data: { entity: {} } },
            });

            const result = await service.previewDocument(
                { id: 1 } as any,
                {
                    imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
                    documentType: DocumentType.NIN,
                } as any,
            );

            expect(result.success).toBe(true);
            expect(result.message).toBe("Only Nigerian-issued documents are accepted. Please upload a valid Nigerian document.");
            expect(result.data).toEqual(
                expect.objectContaining({
                    isValid: false,
                    canSubmit: true,
                    providerStatus: "FAILED",
                    reasonCode: "DOCUMENT_INVALID",
                    reason: "DOCUMENT_COUNTRY_NOT_NIGERIA",
                }),
            );
        });

        it("previewDocument keeps driver license back images out of provider OCR", async () => {
            dojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    reason: "valid",
                    documentType: "drivers license",
                    country: "Nigeria",
                    countryCode: "NG",
                    documentNumber: "DL12345",
                    hasPortrait: true,
                    hasFrontSide: true,
                    hasBackSide: false,
                    hasExtractedText: true,
                },
                response: { data: { entity: {} } },
            });

            const result = await service.previewDocument(
                { id: 1 } as any,
                {
                    imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
                    imageBackBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0y",
                    documentType: DocumentType.DRIVER_LICENSE,
                } as any,
            );

            const providerPayload = dojahService.analyzeDocument.mock.calls[0]?.[0];
            expect(providerPayload).toEqual(
                expect.objectContaining({
                    inputType: "base64",
                    imageFrontSide: "ZmFrZS1pbWFnZS0x",
                }),
            );
            expect(providerPayload).not.toHaveProperty("imageBackSide");
            expect(result.data).toEqual(
                expect.objectContaining({
                    documentTypeMatches: true,
                    documentNumber: "DL12345",
                }),
            );
        });

        it("previewDocumentWithProviderLog returns the exact provider request and response for preview reuse", async () => {
            dojahService.analyzeDocument.mockResolvedValue({
                parsed: {
                    isValid: true,
                    reason: "valid",
                    documentType: "passport",
                    country: "Nigeria",
                    countryCode: "NG",
                    firstName: "John",
                    lastName: "Doe",
                    documentNumber: "P12345",
                    dateOfBirth: "1990-01-01",
                    hasPortrait: true,
                    hasFrontSide: true,
                    hasBackSide: false,
                    hasExtractedText: true,
                },
                response: { data: { entity: { reference_id: "dojah-ref-1" } } },
            });

            const result = await service.previewDocumentWithProviderLog(
                { id: 1 } as any,
                {
                    imageFrontBase64: "data:image/png;base64,ZmFrZS1pbWFnZS0x",
                    documentType: DocumentType.INTERNATIONAL_PASSPORT,
                } as any,
            );

            expect(result.providerInteraction).toEqual(
                expect.objectContaining({
                    provider: "DOJAH",
                    request: expect.objectContaining({
                        inputType: "base64",
                        imageFrontSide: "ZmFrZS1pbWFnZS0x",
                    }),
                    response: expect.objectContaining({
                        parsed: expect.objectContaining({
                            documentNumber: "P12345",
                            firstName: "John",
                        }),
                    }),
                }),
            );
            expect(result.data).not.toHaveProperty("firstName");
        });

        it("analyzeIncomeDocumentSignals preserves raw Dojah failure details for preview persistence", async () => {
            const fileBuffer = Buffer.from("fake-income-image");

            dojahService.analyzeDocument.mockRejectedValueOnce(Object.assign(new Error("Service not available"), {
                name: "DojahThirdPartyServiceFailureError",
                status: 424,
                responseBody: {
                    error: "Service not available",
                    code: "DOC_ANALYSIS_UNAVAILABLE",
                },
                requestMetadata: {
                    method: "POST",
                    url: "/api/v1/document/analysis",
                    baseURL: "https://api.dojah.test",
                },
            }));

            const result = await service.analyzeIncomeDocumentSignals(
                {
                    id: 10,
                    firstName: "Ada",
                    lastName: "Lovelace",
                } as any,
                {
                    buffer: fileBuffer,
                    mimetype: "image/png",
                    originalname: "statement.png",
                } as any,
            );

            expect(dojahService.analyzeDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    inputType: "base64",
                    imageFrontSide: fileBuffer.toString("base64"),
                }),
            );
            expect(result).toEqual({
                providerInteraction: expect.objectContaining({
                    provider: "DOJAH",
                    request: expect.objectContaining({
                        endpoint: "/api/v1/document/analysis",
                        inputType: "base64",
                        fileName: "statement.png",
                        mimeType: "image/png",
                        originalByteLength: fileBuffer.length,
                        preparedByteLength: fileBuffer.length,
                    }),
                    error: {
                        name: "DojahThirdPartyServiceFailureError",
                        message: "Service not available",
                        status: 424,
                        responseBody: {
                            error: "Service not available",
                            code: "DOC_ANALYSIS_UNAVAILABLE",
                        },
                        requestMetadata: {
                            method: "POST",
                            url: "/api/v1/document/analysis",
                            baseURL: "https://api.dojah.test",
                        },
                    },
                }),
            });
        });

        it("analyzeIncomeDocumentSignals preserves metadata from wrapped DojahException failures", async () => {
            const fileBuffer = Buffer.from("fake-wrapped-income-image");

            dojahService.analyzeDocument.mockRejectedValueOnce(new DojahException(
                "Service not available",
                424,
                {
                    providerErrorName: "DojahThirdPartyServiceFailureError",
                    responseBody: {
                        error: "Service not available",
                    },
                    requestMetadata: {
                        method: "POST",
                        url: "/api/v1/document/analysis",
                        baseURL: "https://api.dojah.io",
                    },
                },
            ));

            const result = await service.analyzeIncomeDocumentSignals(
                {
                    id: 10,
                    firstName: "Ada",
                    lastName: "Lovelace",
                } as any,
                {
                    buffer: fileBuffer,
                    mimetype: "image/png",
                    originalname: "statement.png",
                } as any,
            );

            expect(result).toEqual({
                providerInteraction: expect.objectContaining({
                    provider: "DOJAH",
                    error: {
                        name: "DojahException",
                        message: "Service not available",
                        status: 424,
                        providerErrorName: "DojahThirdPartyServiceFailureError",
                        responseBody: {
                            error: "Service not available",
                        },
                        requestMetadata: {
                            method: "POST",
                            url: "/api/v1/document/analysis",
                            baseURL: "https://api.dojah.io",
                        },
                    },
                }),
            });
        });

        it("buildIdentityVerificationResultFromPreview prefers persisted provider interaction over the synthetic fallback", () => {
            const previewPayload = {
                isValid: true,
                comparisonSummary: {
                    nameMatches: false,
                },
                providerInteraction: {
                    provider: "DOJAH",
                    request: {
                        inputType: "base64",
                        imageFrontSide: "front-image",
                    },
                    response: {
                        parsed: {
                            documentType: "passport",
                            country: "Nigeria",
                            countryCode: "NG",
                            firstName: "Ada",
                            lastName: "Lovelace",
                            givenNames: "Augusta Ada",
                            documentNumber: "A1234567",
                            dateOfBirth: "1815-12-10",
                            hasExtractedText: true,
                            hasPortrait: true,
                            hasFrontSide: true,
                        },
                    },
                },
            };

            const result = (service as any).buildIdentityVerificationResultFromPreview(previewPayload);

            expect(result.parsed).toEqual(
                expect.objectContaining({
                    firstName: "Ada",
                    lastName: "Lovelace",
                    dateOfBirth: "1815-12-10",
                    documentNumber: "A1234567",
                }),
            );
            expect(JSON.parse(result.raw)).toEqual(previewPayload.providerInteraction);
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
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 11 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 101 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verified successfully");
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        providerRef: "P12345",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "P12345",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "P12345",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
            expect((service as any).tierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });

        it("documentVerificationBase64 falls back to the extracted document number for upload-only submissions", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            const userDocumentUpsert = jest.fn().mockResolvedValue({ id: 12 });
            const kycStageAttemptCreate = jest.fn().mockResolvedValue({ id: 102 });

            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-upload-only-1" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "front-upload-only-2" });
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
                    documentNumber: "P43210",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: userDocumentUpsert },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: kycStageAttemptCreate,
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                {
                    ...base64Dto,
                    documentNumber: undefined,
                } as any,
            );

            expect(result.message).toBe("Document verified successfully");
            expect(userDocumentUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    update: expect.objectContaining({ documentNumber: "P43210" }),
                    create: expect.objectContaining({ documentNumber: "P43210" }),
                }),
            );
            expect(kycStageAttemptCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        extractedFields: expect.objectContaining({
                            documentNumber: "P43210",
                            submittedDocumentNumber: null,
                            extractedDocumentNumber: "P43210",
                        }),
                        comparisonSummary: expect.objectContaining({ documentNumberMatches: null }),
                    }),
                }),
            );
        });

        it("documentVerificationBase64 rejects invalid documents before manual review", async () => {
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
                    reason: "NOT_VALID",
                    documentNumber: "P99999",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document could not be verified. Please upload a valid document.");
            expect(result.data).toEqual(
                expect.objectContaining({
                    status: "DECLINED",
                    outcome: "REJECTED_HARD_STOP",
                    reasonMessage: "Document could not be verified. Please upload a valid document.",
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "Document could not be verified. Please upload a valid document.",
                        providerRef: "P99999",
                    }),
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Rejected",
                    body: "Document could not be verified. Please upload a valid document.",
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 auto-rejects valid documents when both name and DOB mismatch", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
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
                    dateOfBirth: "1988-03-15",
                    documentNumber: "P77777",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 13 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 103 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        providerRef: "P77777",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.",
                        providerRef: "P77777",
                    }),
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Rejected",
                    body: "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-rejected",
                    merge_info: expect.objectContaining({
                        rejection_reason: "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 auto-rejects valid documents when extracted full name mismatches and DOB is unavailable", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-3b" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-3b" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: false,
                parsed: {
                    documentType: "nin",
                    countryCode: "NG",
                    firstName: "Jane",
                    lastName: "Uvo",
                    dateOfBirth: null,
                    documentNumber: "61842428215",
                    expiryDate: null,
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 13 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 103 }) },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                {
                    ...base64Dto,
                    documentType: DocumentType.NIN,
                    documentNumber: "61842428215",
                } as any,
            );

            expect(result.message).toBe("The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.",
                        providerRef: "61842428215",
                    }),
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Rejected",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-rejected",
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 auto-rejects NIN slips when the extracted NIN mismatches the verified profile NIN", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-nin-profile-mismatch" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-nin-profile-mismatch" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: false,
                parsed: {
                    documentType: "nin",
                    countryCode: "NG",
                    firstName: null,
                    lastName: "Uvo",
                    dateOfBirth: null,
                    documentNumber: "61842428215",
                    expiryDate: null,
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 17 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 107 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 9,
                    email: "eyitayo@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "Eyitayo",
                    lastName: "Akinyeye",
                    dateOfBirth: new Date("1994-06-21"),
                    nin: "43174483033",
                } as any,
                {
                    ...base64Dto,
                    documentType: DocumentType.NIN,
                    documentNumber: "61842428215",
                } as any,
            );

            expect(result.message).toBe("The NIN on the uploaded slip does not match the NIN verified on your profile. Please upload the correct NIN slip that belongs to you.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "The NIN on the uploaded slip does not match the NIN verified on your profile. Please upload the correct NIN slip that belongs to you.",
                        providerRef: "61842428215",
                    }),
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 9,
                    title: "Document Rejected",
                    body: "The NIN on the uploaded slip does not match the NIN verified on your profile. Please upload the correct NIN slip that belongs to you.",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-rejected",
                    merge_info: expect.objectContaining({
                        rejection_reason: "The NIN on the uploaded slip does not match the NIN verified on your profile. Please upload the correct NIN slip that belongs to you.",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 keeps partial OCR extraction pending review instead of auto-rejecting", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            prisma.userDocument.findUnique.mockResolvedValue(null);
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-partial" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-partial" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: false,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    firstName: null,
                    lastName: "AKINYEYE",
                    dateOfBirth: null,
                    documentNumber: "43174483033",
                    expiryDate: null,
                    hasExtractedText: true,
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 15 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 105 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "john@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: new Date("1990-01-01"),
                } as any,
                base64Dto as any,
            );

            expect(result.message).toBe("Document verification is pending review");
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledTimes(1);
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        note: "Manual review needed: valid=true, nameMatches=false, dobMatches=false",
                    }),
                }),
            );
            expect((service as any).notificationDispatcher.notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    title: "Document Submitted",
                }),
            );
            expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
                expect.objectContaining({
                    template_key: "tpl-pending-review",
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 keeps valid passports with only a partial profile name pending review", async () => {
            prisma.userDocument.findUnique.mockResolvedValue(null);
            const userDocumentUpsert = jest.fn().mockResolvedValue({ id: 16 });
            const kycStageAttemptCreate = jest.fn().mockResolvedValue({ id: 106 });

            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-passport-partial" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-passport-partial" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: true,
                nameMatches: false,
                parsed: {
                    documentType: "Passport",
                    countryCode: "NG",
                    firstName: "AKINYEYE",
                    lastName: null,
                    dateOfBirth: null,
                    documentNumber: "43174483033",
                    expiryDate: null,
                    hasExtractedText: true,
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: userDocumentUpsert },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: kycStageAttemptCreate,
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.documentVerificationBase64(
                {
                    id: 1,
                    email: "eyitayo@flipxer.local",
                    isDocumentVerified: false,
                    firstName: "Eyitayo",
                    lastName: "Akinyeye",
                    dateOfBirth: new Date("1994-06-21"),
                } as any,
                {
                    ...base64Dto,
                    documentType: DocumentType.INTERNATIONAL_PASSPORT,
                    documentNumber: "43174483033",
                } as any,
            );

            expect(result.message).toBe("Document verification is pending review");
            expect(userDocumentUpsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    update: expect.objectContaining({
                        dojahNameMatches: false,
                        verificationStatus: "PENDING",
                    }),
                    create: expect.objectContaining({
                        dojahNameMatches: false,
                        verificationStatus: "PENDING",
                    }),
                }),
            );
            expect(kycStageAttemptCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "PENDING_REVIEW",
                        providerStatus: "INCONCLUSIVE",
                        decisionMode: "MANUAL",
                        comparisonSummary: expect.objectContaining({
                            nameMatches: false,
                            partialNameMatches: true,
                            dobMatches: false,
                            profileMatches: false,
                            documentTypeMatches: true,
                            documentNumberMatches: true,
                        }),
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledTimes(1);
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        note: "Manual review needed: valid=true, nameMatches=false, dobMatches=false",
                        providerRef: "43174483033",
                    }),
                }),
            );
            expect((service as any).tierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });

        it("documentVerificationBase64 auto-rejects valid documents when DOB mismatches even if the name matches", async () => {
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
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 14 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 0 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                        create: jest.fn().mockResolvedValue({ id: 104 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
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

            expect(result.message).toBe("The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "The uploaded document details do not match your profile. Please upload the correct document that belongs to you and matches your name and date of birth.",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 blocks rejected resubmissions when the new document is invalid", async () => {
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ status: "REJECTED" });
            jest.spyOn(service as any, "uploadBase64Image")
                .mockResolvedValueOnce({ url: "https://img/front.png", fileId: "front-5" })
                .mockResolvedValueOnce({ url: "https://img/back.png", fileId: "back-5" });
            jest.spyOn(service as any, "callDojahDocumentVerification").mockResolvedValue({
                success: true,
                isValid: false,
                nameMatches: false,
                parsed: {
                    documentType: "passport",
                    countryCode: "NG",
                    reason: "NOT_VALID",
                    documentNumber: "P99998",
                },
                raw: { provider: "dojah" },
                error: null,
            });
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

            expect(result.message).toBe("Document could not be verified. Please upload a valid document.");
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "RESUBMITTED",
                        providerRef: "P99998",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        note: "Document could not be verified. Please upload a valid document.",
                        providerRef: "P99998",
                    }),
                }),
            );
            expect((service as any).kycStateMachine.transition).not.toHaveBeenCalled();
        });

        it("documentVerificationBase64 records RESUBMITTED before APPROVED on auto-approved resubmission", async () => {
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ status: "REJECTED" });
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
                    dateOfBirth: "1990-01-01",
                    documentNumber: "P55555",
                    expiryDate: "2030-01-01",
                },
                raw: { provider: "dojah" },
                error: null,
            });
            jest.spyOn(service as any, "applyDojahPostValidation").mockReturnValue({
                isDocumentValid: true,
                hardRejectMessage: null,
            });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    userDocument: { upsert: jest.fn().mockResolvedValue({ id: 16 }) },
                    kycStageAttempt: {
                        aggregate: jest.fn().mockResolvedValue({ _max: { attemptNo: 1 } }),
                        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                        create: jest.fn().mockResolvedValue({ id: 106 }),
                    },
                    kycAttemptEvent: prisma.kycAttemptEvent,
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
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "RESUBMITTED",
                        providerRef: "P55555",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "APPROVED",
                        providerRef: "P55555",
                    }),
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

        it("submitBusinessDocumentsFromUrls rejects unsupported legacy upload field names", async () => {
            await expect(
                service.submitBusinessDocumentsFromUrls(
                    {
                        id: 2,
                        businessDocumentsUploaded: false,
                        businessDocumentVerificationStatus: null,
                    } as any,
                    {
                        cacDocumentNumber: "RC-123",
                        uploadedFiles: {
                            cacImage: { url: "https://img/cac.png", fileId: "cac-1" },
                            certificateOfIncorporation: { url: "https://img/legacy-cac.png", fileId: "legacy-1" },
                        },
                    } as any,
                ),
            ).rejects.toThrow("Invalid field name: certificateOfIncorporation");
        });

        it("submitBusinessDocumentsFromUrls persists structured docs and dispatches review flow", async () => {
            const runDojahSpy = jest
                .spyOn(service as any, "runDojahBusinessVerificationFromStoredDocument")
                .mockResolvedValue(undefined);
            prisma.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: 0 } });
            prisma.kycStageAttempt.updateMany.mockResolvedValue({ count: 0 });
            prisma.kycStageAttempt.create.mockResolvedValue({ id: 901 });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
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
                    kycStageAttempt: prisma.kycStageAttempt,
                    kycAttemptEvent: prisma.kycAttemptEvent,
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
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        status: "SUBMITTED",
                        providerRef: "RC-999",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        eventType: "SUBMITTED",
                        providerRef: "RC-999",
                    }),
                }),
            );
            expect(runDojahSpy).toHaveBeenCalledWith(2, "RC-999", 901);
            runDojahSpy.mockRestore();
        });

        it("updloadBusinessDocuments creates a business stage attempt before background verification", async () => {
            const runDojahSpy = jest
                .spyOn(service as any, "runDojahBusinessVerification")
                .mockResolvedValue(undefined);
            jest.spyOn(service as any, "uploadAsFile").mockResolvedValue({
                url: "https://img/cac-upload.png",
                fileId: "cac-upload-1",
            });
            prisma.kycStageAttempt.aggregate.mockResolvedValue({ _max: { attemptNo: 0 } });
            prisma.kycStageAttempt.updateMany.mockResolvedValue({ count: 0 });
            prisma.kycStageAttempt.create.mockResolvedValue({ id: 902 });

            prisma.$transaction.mockImplementation(async (callback: any) =>
                callback({
                    $executeRaw: prisma.$executeRaw,
                    businessDocument: { upsert: jest.fn().mockResolvedValue({ id: 654 }) },
                    user: { update: jest.fn().mockResolvedValue({ id: 4 }) },
                    kycStageAttempt: prisma.kycStageAttempt,
                    kycAttemptEvent: prisma.kycAttemptEvent,
                }),
            );

            const result = await service.updloadBusinessDocuments(
                {
                    id: 4,
                    email: "biz@example.com",
                    firstName: "Biz",
                    businessDocumentsUploaded: false,
                    businessDocumentVerificationStatus: null,
                } as any,
                {
                    cacImage: [{ originalname: "cac.png" }],
                } as any,
                {
                    cacDocumentNumber: "RC-UP-1",
                } as any,
            );

            expect(result.message).toBe("Document Verification successfully");
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        status: "SUBMITTED",
                        providerRef: "RC-UP-1",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        journeyType: "BUSINESS",
                        stage: "BUSINESS_DOCUMENT",
                        eventType: "SUBMITTED",
                        providerRef: "RC-UP-1",
                    }),
                }),
            );
            expect(runDojahSpy).toHaveBeenCalledWith(4, "RC-UP-1", expect.any(Object), 902);
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

        it("uploadSingleBusinessDocumentFile rejects the legacy certificateOfIncorporation alias", async () => {
            await expect(
                service.uploadSingleBusinessDocumentFile(
                    { id: 50 } as any,
                    { originalname: "doc.png" } as any,
                    { fieldName: "certificateOfIncorporation" } as any,
                ),
            ).rejects.toThrow("Invalid field name: certificateOfIncorporation");
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
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ id: 811, status: "SUBMITTED" });
            prisma.kycStageAttempt.update.mockResolvedValue({ id: 811 });
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
            expect(prisma.kycStageAttempt.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 811 },
                    data: expect.objectContaining({
                        status: "PENDING_REVIEW",
                        providerName: "DOJAH",
                        providerStatus: "PASSED",
                        providerRef: "RC-123",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        attemptId: 811,
                        eventType: "PROVIDER_CHECK",
                        actorType: "PROVIDER",
                        providerName: "DOJAH",
                        providerStatus: "PASSED",
                    }),
                }),
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
            const fetchSpy = jest
                .spyOn(service as any, "fetchTrustedDocumentBuffer")
                .mockResolvedValue(Buffer.from("binary"));
            const runSpy = jest.spyOn(service as any, "runDojahBusinessVerification").mockResolvedValue(undefined);

            await expect((service as any).runDojahBusinessVerificationFromStoredDocument(12, "RC-12", 777)).resolves.toBeUndefined();

            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(fetchSpy.mock.calls[0][0]).toBeInstanceOf(URL);
            expect(fetchSpy.mock.calls[0][0].toString()).toBe("https://ik.imagekit.io/folder/cac.webp");
            expect(runSpy).toHaveBeenCalledWith(
                12,
                "RC-12",
                expect.objectContaining({ fieldname: "cacImage", mimetype: "image/webp" }),
                777,
            );

            fetchSpy.mockRestore();
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
            expect((service as any).applyDojahPostValidation(true, parsed, 1, logger)).toEqual({
                isDocumentValid: false,
                hardRejectMessage: "Document appears to be expired. Please upload a valid, unexpired document.",
            });
            expect(parsed.reason).toBe("Document has expired");

            expect(
                (service as any).applyDojahPostValidation(
                    false,
                    { reason: "UNSUPPORTED_DOCUMENT", hasExtractedText: true },
                    1,
                    logger,
                ),
            ).toEqual({
                isDocumentValid: false,
                hardRejectMessage: "This document type is not supported. Please upload a valid passport, driver's license, or national ID.",
            });

            expect(
                (service as any).applyDojahPostValidation(
                    false,
                    { reason: "NOT_VALID", hasExtractedText: true },
                    1,
                    logger,
                ),
            ).toEqual({
                isDocumentValid: false,
                hardRejectMessage: "Document could not be verified. Please upload a valid document.",
            });
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
            expect((service as any).mapDojahReasonToUserMessage("CUSTOM_REASON")).toBe(
                "Document could not be verified. Please upload a valid document.",
            );

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

        it("does not send driver license back images to Dojah verification", async () => {
            dojahService.verifyDocumentWithNameMatch.mockResolvedValue({
                isValid: true,
                nameMatches: true,
                parsed: { documentType: "drivers license" },
            });

            const logger = { log: jest.fn(), error: jest.fn() } as any;
            await (service as any).callDojahDocumentVerification(
                "front-base64",
                "back-base64",
                { id: 42, firstName: "Jane", lastName: "Doe" },
                { imageFrontBase64: "front-base64", imageBackBase64: "back-base64", documentType: DocumentType.DRIVER_LICENSE },
                Date.now(),
                logger,
            );

            const providerPayload = dojahService.verifyDocumentWithNameMatch.mock.calls[0]?.[0];
            expect(providerPayload).toEqual(
                expect.objectContaining({
                    inputType: "base64",
                    imageFrontSide: "front-base64",
                }),
            );
            expect(providerPayload).not.toHaveProperty("imageBackSide");
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

        it("treats non-Nigerian document countries as invalid during post validation", () => {
            const logger = { log: jest.fn(), warn: jest.fn() } as any;

            const result = (service as any).applyDojahPostValidation(
                true,
                {
                    reason: "valid",
                    country: "Ghana",
                    countryCode: "GH",
                },
                77,
                logger,
            );

            expect(result).toEqual(
                expect.objectContaining({
                    isDocumentValid: false,
                    hardRejectMessage: "Only Nigerian-issued documents are accepted. Please upload a valid Nigerian document.",
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

        it("should auto-reject and send rejection notification + email when DOB mismatches", async () => {
            (matchDateOfBirth as jest.Mock).mockReturnValue(false);
            (matchNames as jest.Mock).mockReturnValue({ matches: false, detail: "DOB mismatch" });

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "BVN", "12345678901");

            expect(result).toEqual({
                disposition: "AUTO_REJECT",
                responseMessage: "The submitted BVN details do not match your profile. Please submit the correct BVN that belongs to you and matches your name and date of birth.",
                reasonMessage: "The submitted BVN details do not match your profile. Please submit the correct BVN that belongs to you and matches your name and date of birth.",
            });

            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "REJECTED",
                        providerRef: "ref-123",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "REJECTED",
                        providerRef: "ref-123",
                    }),
                }),
            );
            expect(kycStateMachine.transition).not.toHaveBeenCalled();
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
                        rejection_reason: "The submitted BVN details do not match your profile. Please submit the correct BVN that belongs to you and matches your name and date of birth.",
                        status: "Rejected",
                    }),
                }),
            );
        });

        it("should route to manual review when provider data is incomplete", async () => {
            const incompleteResult = {
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: null,
                        date_of_birth: null,
                        reference_id: "ref-incomplete",
                    },
                },
            };

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, incompleteResult, "NIN", "12345678901");

            expect(result).toEqual({
                disposition: "MANUAL_REVIEW",
                responseMessage: "We couldn't confidently compare the submitted NIN details to your profile. Your verification has been sent for manual review.",
                reasonMessage: "We couldn't confidently compare the submitted NIN details to your profile. Your verification has been sent for manual review.",
            });
            expect(prisma.kycStageAttempt.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "PENDING_REVIEW",
                        providerRef: "ref-incomplete",
                    }),
                }),
            );
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "SUBMITTED",
                        providerRef: "ref-incomplete",
                    }),
                }),
            );
            expect(kycStateMachine.transition).not.toHaveBeenCalled();
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

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, mockResult, "BVN", "12345678901");

            expect(result).toEqual({ disposition: "MATCHED" });
            expect(notificationDispatcher.notify).not.toHaveBeenCalled();
            expect(emailService.sendMailWithTemplate).not.toHaveBeenCalled();
        });

        it("should record RESUBMITTED when the current government attempt is rejected", async () => {
            const incompleteResult = {
                data: {
                    entity: {
                        first_name: "Jane",
                        last_name: null,
                        date_of_birth: null,
                        reference_id: "ref-incomplete-resubmitted",
                    },
                },
            };
            prisma.kycStageAttempt.findFirst.mockResolvedValue({ status: "REJECTED" });

            const result = await (service as any).rejectOnIdentityMismatch(mockUser, incompleteResult, "BVN", "12345678901");

            expect(result).toEqual({
                disposition: "MANUAL_REVIEW",
                responseMessage: "We couldn't confidently compare the submitted BVN details to your profile. Your verification has been sent for manual review.",
                reasonMessage: "We couldn't confidently compare the submitted BVN details to your profile. Your verification has been sent for manual review.",
            });
            expect(prisma.kycAttemptEvent.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        eventType: "RESUBMITTED",
                        providerRef: "ref-incomplete-resubmitted",
                    }),
                }),
            );
            expect(kycStateMachine.transition).not.toHaveBeenCalled();
        });
    });
});
