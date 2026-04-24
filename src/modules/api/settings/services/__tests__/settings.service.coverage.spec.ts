import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { authenticator } from "otplib";
import {
    generateBackupCodes,
    hashBackupCodes,
    verifyBackupCode,
} from "@/modules/api/auth/utils/backup-codes.util";
import { SettingService } from "../index";

jest.mock("otplib", () => ({
    authenticator: {
        verify: jest.fn(),
    },
}));

jest.mock("bcryptjs", () => ({
    compare: jest.fn(),
    hash: jest.fn(),
}));

jest.mock("@/modules/api/auth/utils/backup-codes.util", () => ({
    generateBackupCodes: jest.fn().mockReturnValue(["CODE-1", "CODE-2"]),
    hashBackupCodes: jest.fn().mockResolvedValue(["HASH-1", "HASH-2"]),
    verifyBackupCode: jest.fn(),
}));

jest.mock("@/utils", () => ({
    ...jest.requireActual("@/utils"),
    decryptField: jest.fn().mockReturnValue("DECRYPTED-SECRET"),
}));

function makePrisma() {
    return {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        twoFactorBackupCode: {
            findMany: jest.fn(),
            count: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
            aggregate: jest.fn(),
        },
        $transaction: jest.fn().mockImplementation((ops) => Promise.resolve(ops)),
        $executeRaw: jest.fn(),
        $queryRaw: jest.fn(),
    };
}

describe("SettingService coverage wave", () => {
    const mockUser = { id: 7, email: "user@test.com", firstName: "User", tier: 2 } as any;
    const STORED_TRADING_HASH = "stored-trading-value";

    let prisma: ReturnType<typeof makePrisma>;
    let service: SettingService;
    let smsService: { sendVerificationCode: jest.Mock };
    let emailService: { sendMail: jest.Mock; sendMailWithTemplate: jest.Mock };
    let jwtService: Pick<JwtService, "signAsync">;

    beforeEach(() => {
        prisma = makePrisma();
        smsService = { sendVerificationCode: jest.fn() };
        emailService = { sendMail: jest.fn(), sendMailWithTemplate: jest.fn() };
        jwtService = { signAsync: jest.fn().mockResolvedValue("verification-token") };

        service = new SettingService(
            prisma as any,
            smsService as any,
            emailService as any,
            jwtService as any
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("generates and persists new backup codes", async () => {
        const result = await service.generateNewBackupCodes(mockUser);

        expect(generateBackupCodes).toHaveBeenCalledWith(5);
        expect(hashBackupCodes).toHaveBeenCalledWith(["CODE-1", "CODE-2"]);
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(result.message).toContain("New backup codes generated successfully");
    });

    it("returns backup code count", async () => {
        prisma.twoFactorBackupCode.aggregate.mockResolvedValue({
            _count: 3,
            _max: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
        });

        const result = await service.getBackupCodesCount(mockUser);

        expect(result.data.count).toBe(3);
    });

    it("verifySecurityMethod rejects unsupported methods", async () => {
        prisma.user.findUnique.mockResolvedValue({});

        await expect(
            service.verifySecurityMethod(mockUser, { method: "unknown", code: "123456" })
        ).rejects.toThrow("Invalid security method");
    });

    it("verifySecurityMethod handles authenticator success and failure", async () => {
        prisma.user.findUnique.mockResolvedValue({ twoFactorSecret: "encrypted" });

        (authenticator.verify as jest.Mock).mockReturnValueOnce(false);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "authenticator", code: "000000" })
        ).rejects.toThrow("Invalid authenticator code");

        (authenticator.verify as jest.Mock).mockReturnValueOnce(true);
        const result = await service.verifySecurityMethod(mockUser, {
            method: "authenticator",
            code: "123456",
            contextHash: "ctx-hash",
        });

        expect(result.verified).toBe(true);
        expect(result.verificationToken).toBe("verification-token");
        expect(jwtService.signAsync).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: mockUser.id,
                method: "authenticator",
                contextHash: "ctx-hash",
            }),
            { expiresIn: "5m" }
        );
    });

    it("verifySecurityMethod handles trading password validation", async () => {
        prisma.user.findUnique.mockResolvedValue({ tradingPassword: STORED_TRADING_HASH });

        (bcrypt.compare as jest.Mock).mockResolvedValueOnce(false);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "tradingPassword", code: "wrong" })
        ).rejects.toThrow("Invalid trading password");

        (bcrypt.compare as jest.Mock).mockResolvedValueOnce(true);
        const result = await service.verifySecurityMethod(mockUser, {
            method: "tradingPassword",
            code: "correct",
        });

        expect(result.verified).toBe(true);
    });

    it("verifySecurityMethod handles backup code flow", async () => {
        prisma.user.findUnique.mockResolvedValue({});

        const verifySpy = jest.spyOn(service, "verifyBackupCode");
        verifySpy.mockResolvedValueOnce(false);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "backupCode", code: "BAD" })
        ).rejects.toThrow("Invalid or already used backup code");

        verifySpy.mockResolvedValueOnce(true);
        const result = await service.verifySecurityMethod(mockUser, {
            method: "backupCode",
            code: "GOOD",
        });

        expect(result.verified).toBe(true);
    });

    it("verifySecurityMethod validates sms/email OTP through storage checks", async () => {
        prisma.user.findUnique.mockResolvedValue({ phone: "+123", email: "user@test.com" });

        prisma.$queryRaw.mockResolvedValueOnce([]);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "sms", code: "111111" })
        ).rejects.toThrow("Invalid or expired OTP");

        prisma.$queryRaw.mockResolvedValueOnce([
            { code: "222222", expiresAt: new Date(Date.now() - 1000) },
        ]);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "email", code: "222222" })
        ).rejects.toThrow("Invalid or expired OTP");

        prisma.$queryRaw.mockResolvedValueOnce([
            { code: "333333", expiresAt: new Date(Date.now() + 60000) },
        ]);
        await expect(
            service.verifySecurityMethod(mockUser, { method: "sms", code: "WRONG" })
        ).rejects.toThrow("Invalid or expired OTP");

        prisma.$queryRaw.mockResolvedValueOnce([
            { code: "444444", expiresAt: new Date(Date.now() + 60000) },
        ]);
        prisma.$executeRaw.mockResolvedValue(1);

        const result = await service.verifySecurityMethod(mockUser, {
            method: "email",
            code: "444444",
        });

        expect(result.verified).toBe(true);
        expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it("sendTransactionOtp enforces verification requirements", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            phone: null,
            isPhoneVerified: false,
            isEmailVerified: true,
            email: "user@test.com",
            firstName: "User",
        });

        await expect(service.sendTransactionOtp(mockUser, "sms")).rejects.toThrow("Phone not verified");

        prisma.user.findUnique.mockResolvedValueOnce({
            phone: "+123",
            isPhoneVerified: true,
            isEmailVerified: false,
            email: null,
            firstName: "User",
        });

        await expect(service.sendTransactionOtp(mockUser, "email")).rejects.toThrow("Email not verified");
    });

    it("sendTransactionOtp sends sms and email OTPs", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            phone: "+1234567890",
            email: "user@test.com",
            isPhoneVerified: true,
            isEmailVerified: true,
            firstName: "User",
        });
        prisma.$executeRaw.mockResolvedValue(1);

        const smsResult = await service.sendTransactionOtp(mockUser, "sms");
        expect(smsResult.data.method).toBe("sms");
        expect(smsService.sendVerificationCode).toHaveBeenCalled();

        prisma.user.findUnique.mockResolvedValueOnce({
            phone: "+1234567890",
            email: "user@test.com",
            isPhoneVerified: true,
            isEmailVerified: true,
            firstName: "User",
        });
        prisma.$executeRaw.mockResolvedValue(1);

        const emailResult = await service.sendTransactionOtp(mockUser, "email");
        expect(emailResult.data.method).toBe("email");
        expect(emailService.sendMailWithTemplate).toHaveBeenCalled();
    });

    it("getTransactionSecurityRequirements computes tier thresholds", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            tier: 1,
            requiredMethodCount: 1,
            securityMethods: { sms: true, email: false, authenticator: false, tradingPassword: false, biometric: false },
        });

        const belowThreshold = await service.getTransactionSecurityRequirements(mockUser, 30000);
        expect(belowThreshold.data.requiresVerification).toBe(false);
        expect(belowThreshold.data.requiredMethodCount).toBe(0);

        prisma.user.findUnique.mockResolvedValueOnce({
            tier: 2,
            requiredMethodCount: 1,
            securityMethods: { sms: true, email: true, authenticator: true, tradingPassword: false, biometric: false },
        });

        const aboveThreshold = await service.getTransactionSecurityRequirements(mockUser, 150000);
        expect(aboveThreshold.data.requiresVerification).toBe(true);
        expect(aboveThreshold.data.requiredMethodCount).toBe(2);
        expect(aboveThreshold.data.enabledMethods).toEqual(
            expect.arrayContaining(["sms", "email", "authenticator"])
        );
    });

    it("verifyBackupCode returns false for invalid states and true for successful use", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            isTwoFactorEnabled: false,
        });
        expect(await service.verifyBackupCode(mockUser.id, "CODE-1")).toBe(false);

        prisma.user.findUnique.mockResolvedValueOnce({
            isTwoFactorEnabled: true,
        });
        prisma.twoFactorBackupCode.findMany.mockResolvedValueOnce([
            { id: 1, codeHash: "HASH-1", usedAt: null },
            { id: 2, codeHash: "HASH-2", usedAt: null },
        ]);
        (verifyBackupCode as jest.Mock).mockResolvedValueOnce(-1);
        expect(await service.verifyBackupCode(mockUser.id, "BAD")).toBe(false);

        prisma.user.findUnique.mockResolvedValueOnce({
            isTwoFactorEnabled: true,
        });
        prisma.twoFactorBackupCode.findMany.mockResolvedValueOnce([
            { id: 1, codeHash: "HASH-1", usedAt: null },
            { id: 2, codeHash: "HASH-2", usedAt: null },
        ]);
        (verifyBackupCode as jest.Mock).mockResolvedValueOnce(0);
        prisma.twoFactorBackupCode.update.mockResolvedValue({});

        expect(await service.verifyBackupCode(mockUser.id, "CODE-1")).toBe(true);
        expect(prisma.twoFactorBackupCode.update).toHaveBeenCalledWith({
            where: { id: 1 },
            data: { usedAt: expect.any(Date) },
        });
    });
});
