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
    storageDirConfig: { documentDir: "/tmp/docs" },
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
import { IdentityComplianceInjectionToken } from "@/modules/factory/identityCompliance/types";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { validateDocumentFile } from "@/core/validators/file-validator";
import { validateAddressDocument, validateIncomeDocument } from "@/libs/ocr";

function makePrisma() {
    return {
        user: { findUnique: jest.fn(), update: jest.fn() },
        kycVerification: { create: jest.fn() },
    };
}

describe("TierVerificationService", () => {
    let service: TierVerificationService;
    let prisma: ReturnType<typeof makePrisma>;
    let mockTierService: any;
    let mockDojahService: any;
    let mockNotificationDispatcher: any;
    let mockUploadService: any;

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
        mockDojahService = { getVerificationResult: jest.fn() };
        mockNotificationDispatcher = { notify: jest.fn() };
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
                { provide: EmailService, useValue: { sendEmail: jest.fn() } },
                { provide: IdentityComplianceInjectionToken.DOJAH, useValue: mockDojahService },
                { provide: NotificationDispatcher, useValue: mockNotificationDispatcher },
                { provide: WsGateway, useValue: { server: { to: jest.fn() } } },
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

    // ==================== Dojah Address Verification ====================

    describe("verifyAddressWithDojah", () => {
        it("should return early if already verified", async () => {
            const verifiedUser = { ...mockUser, isAddressVerified: true };
            const result = await service.verifyAddressWithDojah(verifiedUser, {
                verificationId: "v1",
            } as any);
            expect(result.message).toBe("Address is already verified");
        });

        it("should throw if Dojah verification fails", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({
                verified: false,
                status: "FAILED",
            });

            await expect(
                service.verifyAddressWithDojah(mockUser, { verificationId: "v1" } as any)
            ).rejects.toThrow(ForbiddenException);
        });

        it("should verify address with Dojah and sync tier", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({
                verified: true,
                status: "VERIFIED",
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyAddressWithDojah(mockUser, {
                verificationId: "v1",
                address: {
                    street: "123 Main St",
                    city: "Lagos",
                    lga: "Ikeja",
                    state: "Lagos",
                    country: "Nigeria",
                    postalCode: "100001",
                },
            } as any);

            expect(result.message).toBe("Address verified successfully");
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });
    });

    // ==================== Dojah Income Verification ====================

    describe("verifyIncomeWithDojah", () => {
        it("should return early if already verified", async () => {
            const verifiedUser = { ...mockUser, isIncomeVerified: true };
            const result = await service.verifyIncomeWithDojah(verifiedUser, {
                verificationId: "v1",
            } as any);
            expect(result.message).toBe("Income is already verified");
        });

        it("should throw if Dojah verification fails", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({
                verified: false,
                status: "FAILED",
            });

            await expect(
                service.verifyIncomeWithDojah(mockUser, { verificationId: "v1" } as any)
            ).rejects.toThrow(ForbiddenException);
        });

        it("should verify income with Dojah and sync tier", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({
                verified: true,
                status: "VERIFIED",
            });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyIncomeWithDojah(mockUser, {
                verificationId: "v1",
                document: { documentUrl: "https://cdn.test.com/income.pdf" },
            } as any);

            expect(result.message).toBe("Income verified successfully");
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });
    });

    // ==================== Dojah Government ID Verification ====================

    describe("verifyGovernmentIdWithDojah", () => {
        it("should return early if BVN already verified", async () => {
            const verifiedUser = { ...mockUser, isBvnVerified: true };
            const result = await service.verifyGovernmentIdWithDojah(verifiedUser, {
                verificationId: "v1",
                government: { idType: "bvn", idNumber: "12345678901", firstName: "John", lastName: "Doe" },
            } as any);
            expect(result.message).toBe("BVN is already verified");
        });

        it("should return early if NIN already verified", async () => {
            const verifiedUser = { ...mockUser, isNinVerified: true };
            const result = await service.verifyGovernmentIdWithDojah(verifiedUser, {
                verificationId: "v1",
                government: { idType: "nin", idNumber: "12345678901", firstName: "John", lastName: "Doe" },
            } as any);
            expect(result.message).toBe("NIN is already verified");
        });

        it("should throw if Dojah government verification fails", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({
                verified: false,
                status: "FAILED",
            });

            await expect(
                service.verifyGovernmentIdWithDojah(mockUser, {
                    verificationId: "v1",
                    government: { idType: "bvn", idNumber: "123", firstName: "J", lastName: "D" },
                } as any)
            ).rejects.toThrow(ForbiddenException);
        });

        it("should verify BVN with Dojah", async () => {
            mockDojahService.getVerificationResult.mockResolvedValue({ verified: true });
            prisma.user.update.mockResolvedValue({});
            prisma.kycVerification.create.mockResolvedValue({});

            const result = await service.verifyGovernmentIdWithDojah(mockUser, {
                verificationId: "v1",
                government: {
                    idType: "bvn",
                    idNumber: "12345678901",
                    firstName: "John",
                    lastName: "Doe",
                    dateOfBirth: "1990-01-01",
                },
            } as any);

            expect(result.message).toContain("verified successfully");
            expect(mockTierService.syncTierAndCache).toHaveBeenCalledWith(1);
        });
    });

    // ==================== Trading Password ====================

    describe("createTradingPassword", () => {
        it("should throw if account password is wrong", async () => {
            const bcrypt = require("bcryptjs");
            bcrypt.compare.mockResolvedValue(false);
            prisma.user.findUnique.mockResolvedValue({ password: "hashed" });

            await expect(
                service.createTradingPassword(mockUser, {
                    tradingPassword: "tp123",
                    accountPassword: "wrong",
                } as any)
            ).rejects.toThrow();
        });
    });
});
