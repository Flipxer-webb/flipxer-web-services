import { Test, TestingModule } from "@nestjs/testing";
import { HttpException, ForbiddenException } from "@nestjs/common";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class { server = { to: jest.fn() } },
}));

jest.mock("@/config", () => ({
    storageDirConfig: {
        document: "/var/lib/flipxer/test-docs",
        documentDir: "/var/lib/flipxer/test-docs",
    },
    emailTemplateConfig: {},
    COMPANY_NAME: "Flipxer",
    mailConfig: { senderMail: "noreply@test.com" },
    cloudinaryConfig: {},
    imagekitConfig: {},
    jwtSecret: "test",
}));

jest.mock("@/core/validators/file-validator", () => ({
    validateDocumentFile: jest.fn(),
}));

jest.mock("@/libs/ocr", () => ({
    validateAddressDocument: jest.fn(),
    validateIncomeDocument: jest.fn(),
}));

jest.mock("bcryptjs", () => ({
    hash: jest.fn().mockResolvedValue("hashed"),
    compare: jest.fn(),
}));

import { TierVerificationService } from "../tier-verification.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { UploadFactory } from "@/modules/core/upload/services";
import { EmailService } from "@/modules/core/email/services";
import { TierService } from "../tier.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { validateDocumentFile } from "@/core/validators/file-validator";
import { validateAddressDocument, validateIncomeDocument } from "@/libs/ocr";

function makePrisma() {
    return {
        user: { findUnique: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
        kycVerification: { create: jest.fn() },
    };
}

let testSecretCounter = 0;
function createTestSecret(): string {
    testSecretCounter += 1;
    return `test-secret-${testSecretCounter}`;
}

describe("TierVerificationService", () => {
    let service: TierVerificationService;
    let prisma: ReturnType<typeof makePrisma>;
    let mockTierService: any;
    let mockNotificationDispatcher: any;
    let mockUploadService: any;
    let mockWsGateway: any;

    const mockFile = {
        buffer: Buffer.from("test"),
        mimetype: "image/png",
        size: 1000,
        originalname: "doc.png",
    } as Express.Multer.File;

    const mockUser = {
        id: 1,
        email: "test@test.com",
        firstName: "John",
        lastName: "Doe",
        isAddressVerified: false,
        isIncomeVerified: false,
        isBvnVerified: false,
        isNinVerified: false,
    } as any;

    beforeEach(async () => {
        prisma = makePrisma();
        mockTierService = { syncTierAndCache: jest.fn() };
        mockNotificationDispatcher = { notify: jest.fn() };
        mockWsGateway = { server: { to: jest.fn() }, notifyProfileUpdate: jest.fn() };
        prisma.user.findFirst.mockResolvedValue(null);
        mockUploadService = {
            upload: jest.fn().mockResolvedValue({ url: "https://cdn.test.com/doc.png" }),
            uploadCompressedImage: jest.fn().mockResolvedValue({ url: "https://cdn.test.com/doc.png" }),
        };

        const mockUploadFactory = {
            build: jest.fn().mockReturnValue(mockUploadService),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TierVerificationService,
                { provide: PrismaService, useValue: prisma },
                { provide: UploadFactory, useValue: mockUploadFactory },
                { provide: TierService, useValue: mockTierService },
                { provide: EmailService, useValue: { sendEmail: jest.fn(), sendMailWithTemplate: jest.fn() } },
                { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
                { provide: WsGateway, useValue: mockWsGateway },
            ],
        }).compile();

        service = module.get<TierVerificationService>(TierVerificationService);
    });

    // ==================== Address Verification (File Upload) ====================

    describe("verifyAddress", () => {
        it("should return early if address is already verified", async () => {
            const verifiedUser = { ...mockUser, isAddressVerified: true };
            const result = await service.verifyAddress(verifiedUser, mockFile);
            expect(result.message).toBe("Address is already verified");
        });

        it("should throw if file validation fails", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({
                isValid: false,
                error: "File too large",
            });

            await expect(service.verifyAddress(mockUser, mockFile)).rejects.toThrow(HttpException);
        });

        it("should flag for manual review when OCR requires it", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.4,
                matchedName: false,
                matchedAddress: true,
                requiresManualReview: true,
                reason: "Low confidence",
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyAddress(mockUser, mockFile);
            expect(result.message).toContain("reviewed by our team");
            expect(result.data.status).toBe("PENDING");
        });

        it("should auto-approve when OCR passes", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateAddressDocument as jest.Mock).mockResolvedValue({
                confidence: 0.95,
                matchedName: true,
                matchedAddress: true,
                requiresManualReview: false,
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyAddress(mockUser, mockFile);
            expect(result.message).toBe("Address verified successfully");
            expect(result.data.status).toBe("VERIFIED");
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });
    });

    // ==================== Income Verification (File Upload) ====================

    describe("verifyIncome", () => {
        it("should return early if income is already verified", async () => {
            const verifiedUser = { ...mockUser, isIncomeVerified: true };
            const result = await service.verifyIncome(verifiedUser, mockFile);
            expect(result.message).toBe("Income is already verified");
        });

        it("should throw if file validation fails", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({
                isValid: false,
                error: "Invalid mime type",
            });

            await expect(service.verifyIncome(mockUser, mockFile)).rejects.toThrow(HttpException);
        });

        it("should flag for manual review", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                confidence: 0.3,
                matchedName: false,
                requiresManualReview: true,
                reason: "Name mismatch",
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyIncome(mockUser, mockFile);
            expect(result.data.status).toBe("PENDING");
        });

        it("should auto-approve when OCR passes", async () => {
            (validateDocumentFile as jest.Mock).mockReturnValue({ isValid: true });
            (validateIncomeDocument as jest.Mock).mockResolvedValue({
                confidence: 0.9,
                matchedName: true,
                requiresManualReview: false,
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyIncome(mockUser, mockFile);
            expect(result.message).toBe("Income verified successfully");
            expect(result.data.status).toBe("VERIFIED");
        });
    });

    // ==================== Trading Password ====================

    describe("createTradingPassword", () => {
        it("should throw when trading password confirmation does not match", async () => {
            const tradingPassword = createTestSecret();
            const confirmTradingPassword = createTestSecret();
            const accountPassword = createTestSecret();

            await expect(
                service.createTradingPassword(mockUser, {
                    tradingPassword,
                    confirmTradingPassword,
                    accountPassword,
                } as any)
            ).rejects.toThrow("Passwords do not match");
        });

        it("should throw if account password is wrong", async () => {
            const bcrypt = require("bcryptjs");
            bcrypt.compare.mockResolvedValue(false);
            prisma.user.findUnique.mockResolvedValue({ password: createTestSecret() });
            const tradingPassword = createTestSecret();
            const accountPassword = createTestSecret();

            await expect(
                service.createTradingPassword(mockUser, {
                    tradingPassword,
                    accountPassword,
                } as any)
            ).rejects.toThrow();
        });
    });

    describe("status and notification helpers", () => {
        it("hasTradingPassword returns false when password is missing", async () => {
            prisma.user.findUnique.mockResolvedValue({ tradingPassword: null });

            const result = await service.hasTradingPassword(mockUser);
            expect(result.data.hasTradingPassword).toBe(false);
        });

        it("hasTradingPassword returns true when password exists", async () => {
            prisma.user.findUnique.mockResolvedValue({ tradingPassword: createTestSecret() });

            const result = await service.hasTradingPassword(mockUser);
            expect(result.data.hasTradingPassword).toBe(true);
        });

        it("getVerificationStatus throws when user is not found", async () => {
            prisma.user.findUnique.mockResolvedValue(null);

            await expect(service.getVerificationStatus(mockUser)).rejects.toThrow("User not found");
        });

        it("sendReviewNotification returns early when user has no email", async () => {
            prisma.user.findUnique.mockResolvedValue({ email: null, firstName: "NoMail" });

            await expect(service.sendReviewNotification(1, "address", true)).resolves.toBeUndefined();
        });

        it("approveDocument handles business documents flow", async () => {
            prisma.user.update.mockResolvedValue({});

            const result = await service.approveDocument(1, "business");

            expect(result.message).toContain("approved successfully");
            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        businessDocumentVerificationStatus: expect.any(String),
                        isDocumentVerified: true,
                    }),
                })
            );
            expect(mockNotificationDispatcher.notify).toHaveBeenCalled();
            expect(mockWsGateway.notifyProfileUpdate).toHaveBeenCalledWith(1);
        });

        it("rejectDocument handles business documents flow", async () => {
            prisma.user.update.mockResolvedValue({});

            const result = await service.rejectDocument(1, "business", "invalid docs");

            expect(result.message).toContain("rejected");
            expect(prisma.user.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        businessDocumentVerificationStatus: expect.any(String),
                        businessDocumentsUploaded: false,
                    }),
                })
            );
            expect(mockNotificationDispatcher.notify).toHaveBeenCalled();
            expect(mockWsGateway.notifyProfileUpdate).toHaveBeenCalledWith(1);
        });
    });
});
