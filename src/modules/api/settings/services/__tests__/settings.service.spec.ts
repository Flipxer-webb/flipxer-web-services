import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";

jest.mock("ipaddr.js", () => ({
    isValid: jest.fn(),
    parse: jest.fn(),
}));

jest.mock("otplib", () => ({
    authenticator: {
        generateSecret: jest.fn().mockReturnValue("TESTBASE32SECRET"),
        keyuri: jest.fn().mockReturnValue("otpauth://totp/Flipxer:test@test.com?secret=TEST"),
        verify: jest.fn(),
    },
}));

jest.mock("qrcode", () => ({
    toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,QRCODE"),
}));

jest.mock("bcryptjs", () => ({
    hash: jest.fn().mockResolvedValue("hashed_value"),
    compare: jest.fn(),
}));

jest.mock("@/modules/api/auth/utils/backup-codes.util", () => ({
    generateBackupCodes: jest.fn().mockReturnValue(["CODE1", "CODE2"]),
    hashBackupCodes: jest.fn().mockResolvedValue(["hashed1", "hashed2"]),
    verifyBackupCode: jest.fn(),
}));

jest.mock("@/utils", () => ({
    ...jest.requireActual("@/utils"),
    encryptField: jest.fn().mockReturnValue("encrypted_secret"),
    decryptField: jest.fn().mockReturnValue("TESTBASE32SECRET"),
}));

jest.mock("@/config", () => ({
    jwtSecret: "test-jwt-secret",
    jwt_refresh_secret: "test-jwt-refresh-secret",
    TOKEN_EXPIRATION: "1h",
    REFRESH_TOKEN_EXPIRATION: "7d",
    COMPANY_NAME: "Flipxer",
    isProdEnvironment: false,
    emailTemplateConfig: {},
    mailConfig: { senderMail: "noreply@test.com" },
    storageDirConfig: {},
    cloudinaryConfig: {},
    imagekitConfig: {},
}));

import { SettingService } from "../index";
import { PrismaService } from "@/modules/core/prisma/services";
import { SmsService } from "@/modules/core/sms/services";
import { EmailService } from "@/modules/core/email/services";
import * as ipaddr from "ipaddr.js";
import { authenticator } from "otplib";
import * as bcrypt from "bcryptjs";
import { verifyBackupCode } from "@/modules/api/auth/utils/backup-codes.util";

function makePrisma() {
    return {
        allowedIp: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
        },
        cryptoRate: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
        },
        transactionFee: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
        },
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
    };
}

describe("SettingService", () => {
    let service: SettingService;
    let prisma: ReturnType<typeof makePrisma>;

    const mockUser = {
        id: 1,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
        tier: 1,
    } as any;

    beforeEach(async () => {
        prisma = makePrisma();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SettingService,
                { provide: PrismaService, useValue: prisma },
                { provide: SmsService, useValue: { sendSms: jest.fn() } },
                { provide: EmailService, useValue: { sendEmail: jest.fn() } },
                { provide: JwtService, useValue: { sign: jest.fn(), verify: jest.fn() } },
            ],
        }).compile();

        service = module.get<SettingService>(SettingService);
    });

    // ==================== Allowed IPs ====================

    describe("getAllowedList", () => {
        it("should return the list of allowed IPs for a user", async () => {
            const ips = [{ id: 1, ip: "1.2.3.4", isActive: true, label: "Office", userId: 1 }];
            prisma.allowedIp.findMany.mockResolvedValue(ips);

            const result = await service.getAllowedList(mockUser);

            expect(result).toMatchObject({ message: "Allowed ips list retrieved", data: ips });
            expect(prisma.allowedIp.findMany).toHaveBeenCalledWith({
                where: { userId: 1, isActive: true },
                select: expect.any(Object),
            });
        });
    });

    describe("addAllowedIp", () => {
        it("should reject non-public IPs", async () => {
            (ipaddr.isValid as jest.Mock).mockReturnValue(true);
            (ipaddr.parse as jest.Mock).mockReturnValue({ range: () => "private" });

            await expect(service.addAllowedIp(mockUser, { ip: "192.168.1.1" } as any))
                .rejects.toThrow("Only public IPs are allowed.");
        });

        it("should reject invalid IPs", async () => {
            (ipaddr.isValid as jest.Mock).mockReturnValue(false);

            await expect(service.addAllowedIp(mockUser, { ip: "not-ip" } as any))
                .rejects.toThrow("Only public IPs are allowed.");
        });

        it("should throw if IP already active", async () => {
            (ipaddr.isValid as jest.Mock).mockReturnValue(true);
            (ipaddr.parse as jest.Mock).mockReturnValue({ range: () => "unicast" });
            prisma.allowedIp.findUnique.mockResolvedValue({ isActive: true });

            await expect(service.addAllowedIp(mockUser, { ip: "8.8.8.8" } as any))
                .rejects.toThrow();
        });

        it("should reactivate an inactive IP", async () => {
            (ipaddr.isValid as jest.Mock).mockReturnValue(true);
            (ipaddr.parse as jest.Mock).mockReturnValue({ range: () => "unicast" });
            prisma.allowedIp.findUnique.mockResolvedValue({ isActive: false, label: "Old" });
            prisma.allowedIp.update.mockResolvedValue({});

            const result = await service.addAllowedIp(mockUser, { ip: "8.8.8.8", label: "New" } as any);
            expect(result.message).toBe("Allowed IP added successfully");
            expect(prisma.allowedIp.update).toHaveBeenCalled();
        });

        it("should create a new IP if not existing", async () => {
            (ipaddr.isValid as jest.Mock).mockReturnValue(true);
            (ipaddr.parse as jest.Mock).mockReturnValue({ range: () => "unicast" });
            prisma.allowedIp.findUnique.mockResolvedValue(null);
            prisma.allowedIp.create.mockResolvedValue({});

            const result = await service.addAllowedIp(mockUser, { ip: "8.8.8.8", label: "DNS" } as any);
            expect(result.message).toBe("Allowed IP added successfully");
            expect(prisma.allowedIp.create).toHaveBeenCalled();
        });
    });

    describe("updateAllowedIp", () => {
        it("should throw if IP not found", async () => {
            prisma.allowedIp.findUnique.mockResolvedValue(null);

            await expect(service.updateAllowedIp(mockUser, "8.8.8.8", { label: "X" } as any))
                .rejects.toThrow();
        });

        it("should update an existing IP", async () => {
            prisma.allowedIp.findUnique.mockResolvedValue({ label: "Old", isActive: true });
            prisma.allowedIp.update.mockResolvedValue({ label: "New" });

            const result = await service.updateAllowedIp(mockUser, "8.8.8.8", { label: "New" } as any);
            expect(result.message).toBe("Allowed IP updated successfully");
        });
    });

    describe("deleteAllowedIp", () => {
        it("should throw if IP not owned by user", async () => {
            prisma.allowedIp.findUnique.mockResolvedValue({ id: 1, userId: 999 });

            await expect(service.deleteAllowedIp(mockUser, 1)).rejects.toThrow();
        });

        it("should soft-delete an IP", async () => {
            prisma.allowedIp.findUnique.mockResolvedValue({ id: 1, userId: 1, isActive: true });
            prisma.allowedIp.update.mockResolvedValue({});

            const result = await service.deleteAllowedIp(mockUser, 1);
            expect(result.message).toBe("Allowed ip removed successfully");
        });
    });

    // ==================== Crypto Rates ====================

    describe("getCryptoRateList", () => {
        it("should return all crypto rates", async () => {
            const rates = [{ id: 1, buyRate: 100, sellRate: 95, currency: "BTC" }];
            prisma.cryptoRate.findMany.mockResolvedValue(rates);

            const result = await service.getCryptoRateList();
            expect(result.data).toEqual(rates);
        });
    });

    describe("getCryptoRatePerAsset", () => {
        it("should return rate for a valid asset", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue({ id: 1, currency: "BTC" });
            const result = await service.getCryptoRatePerAsset("btc");
            expect(result.data).toMatchObject({ currency: "BTC" });
        });

        it("should throw for unknown asset", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            await expect(service.getCryptoRatePerAsset("FAKE")).rejects.toThrow();
        });
    });

    describe("getCryptoTransactionFeesCategories", () => {
        it("should return fee categories", async () => {
            const result = await service.getCryptoTransactionFeesCategories();
            expect(result.data).toBeInstanceOf(Array);
        });
    });

    describe("getCryptoTransactionFeeList", () => {
        it("should return all transaction fees", async () => {
            prisma.transactionFee.findMany.mockResolvedValue([{ id: 1 }]);
            const result = await service.getCryptoTransactionFeeList();
            expect(result.data).toHaveLength(1);
        });
    });

    describe("getCryptoTransactionFeePerAsset", () => {
        it("should return fee for a valid asset + category", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue({ id: 1, fee: 10 });
            const result = await service.getCryptoTransactionFeePerAsset({ category: "BUY" } as any, "btc");
            expect(result.data).toBeDefined();
        });

        it("should throw for unknown asset fee", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue(null);
            await expect(service.getCryptoTransactionFeePerAsset({ category: "BUY" } as any, "FAKE"))
                .rejects.toThrow();
        });
    });

    describe("getCryptoRateDetail", () => {
        it("should return rate detail", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue({ id: 1 });
            const result = await service.getCryptoRateDetail(1);
            expect(result.data).toBeDefined();
        });

        it("should throw if rate not found", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            await expect(service.getCryptoRateDetail(999)).rejects.toThrow();
        });
    });

    describe("getCryptoTransactionFeeDetail", () => {
        it("should return fee detail", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue({ id: 1 });
            const result = await service.getCryptoTransactionFeeDetail(1);
            expect(result.data).toBeDefined();
        });

        it("should throw if fee not found", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue(null);
            await expect(service.getCryptoTransactionFeeDetail(999)).rejects.toThrow();
        });
    });

    describe("createOrUpdateCryptoRate", () => {
        it("should upsert a crypto rate", async () => {
            prisma.cryptoRate.upsert.mockResolvedValue({ id: 1, currency: "BTC" });
            const result = await service.createOrUpdateCryptoRate({ currency: "btc", buyRate: 100, sellRate: 95 } as any);
            expect(result.message).toBe("Crypto rate updated successfully");
        });
    });

    describe("createOrUpdateCryptoTransactionFee", () => {
        it("should upsert a transaction fee", async () => {
            prisma.transactionFee.upsert.mockResolvedValue({ id: 1 });
            const result = await service.createOrUpdateCryptoTransactionFee({
                category: "BUY", currency: "btc", fee: 10,
            } as any);
            expect(result.message).toBe("Crypto transaction fee updated successfully");
        });
    });

    describe("deleteCryptoRate", () => {
        it("should delete a rate", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue({ id: 1 });
            prisma.cryptoRate.delete.mockResolvedValue({});
            const result = await service.deleteCryptoRate(1);
            expect(result.message).toBe("Crypto rate removed successfully");
        });

        it("should throw if rate not found", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            await expect(service.deleteCryptoRate(999)).rejects.toThrow();
        });
    });

    describe("deleteCryptoTransactionFee", () => {
        it("should delete a fee", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue({ id: 1 });
            prisma.transactionFee.delete.mockResolvedValue({});
            const result = await service.deleteCryptoTransactionFee(1);
            expect(result.message).toBe("Crypto transaction fee removed successfully");
        });

        it("should throw if fee not found", async () => {
            prisma.transactionFee.findUnique.mockResolvedValue(null);
            await expect(service.deleteCryptoTransactionFee(999)).rejects.toThrow();
        });
    });

    // ==================== 2FA ====================

    describe("setup2FA", () => {
        it("should throw if 2FA already enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: true });
            await expect(service.setup2FA(mockUser)).rejects.toThrow("2FA is already enabled");
        });

        it("should generate QR code and backup codes", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            prisma.user.update.mockResolvedValue({});

            const result = await service.setup2FA(mockUser);
            expect(result.data.qrCodeUrl).toContain("data:image");
            expect(result.data.secret).toBe("TESTBASE32SECRET");
            expect(result.data.backupCodes).toEqual(["CODE1", "CODE2"]);
        });
    });

    describe("enable2FA", () => {
        it("should throw if no 2FA secret set up", async () => {
            prisma.user.findUnique.mockResolvedValue({ twoFactorSecret: null });
            await expect(service.enable2FA(mockUser, { code: "123456" } as any)).rejects.toThrow();
        });

        it("should verify and enable 2FA for the first time", async () => {
            prisma.user.findUnique
                .mockResolvedValueOnce({ twoFactorSecret: "encrypted", isTwoFactorEnabled: false })
                .mockResolvedValueOnce({ securityMethods: {} });
            prisma.twoFactorBackupCode.count.mockResolvedValue(2);
            (authenticator.verify as jest.Mock).mockReturnValue(true);
            prisma.user.update.mockResolvedValue({});

            const result = await service.enable2FA(mockUser, { code: "123456" } as any);
            expect(result.message).toContain("enabled successfully");
        });

        it("should throw if code is invalid", async () => {
            prisma.user.findUnique.mockResolvedValue({ twoFactorSecret: "encrypted", isTwoFactorEnabled: false });
            (authenticator.verify as jest.Mock).mockReturnValue(false);

            await expect(service.enable2FA(mockUser, { code: "000000" } as any)).rejects.toThrow();
        });

        it("should return success if already enabled and code is valid", async () => {
            prisma.user.findUnique.mockResolvedValue({ twoFactorSecret: "encrypted", isTwoFactorEnabled: true });
            (authenticator.verify as jest.Mock).mockReturnValue(true);

            const result = await service.enable2FA(mockUser, { code: "123456" } as any);
            expect(result.message).toContain("already enabled");
        });
    });

    describe("disable2FA", () => {
        it("should throw if 2FA not enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            await expect(service.disable2FA(mockUser, { code: "123456", password: "pw" } as any)).rejects.toThrow();
        });

        it("should throw if password is wrong", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
                twoFactorSecret: "encrypted",
                password: "hashed",
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);

            await expect(service.disable2FA(mockUser, { code: "123456", password: "wrong" } as any)).rejects.toThrow();
        });

        it("should throw if TOTP code is invalid", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
                twoFactorSecret: "encrypted",
                password: "hashed",
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            (authenticator.verify as jest.Mock).mockReturnValue(false);

            await expect(service.disable2FA(mockUser, { code: "000000", password: "pw" } as any)).rejects.toThrow();
        });

        it("should disable 2FA when password and code are valid", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
                twoFactorSecret: "encrypted",
                password: "hashed",
            });
            (bcrypt.compare as jest.Mock).mockResolvedValue(true);
            (authenticator.verify as jest.Mock).mockReturnValue(true);
            prisma.user.update.mockResolvedValue({});

            const result = await service.disable2FA(mockUser, { code: "123456", password: "pw" } as any);
            expect(result.message).toContain("disabled successfully");
        });
    });

    describe("get2FAStatus", () => {
        it("should return enabled status", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: true });
            const result = await service.get2FAStatus(mockUser);
            expect(result.data.isEnabled).toBe(true);
        });

        it("should return disabled status", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            const result = await service.get2FAStatus(mockUser);
            expect(result.data.isEnabled).toBe(false);
        });
    });

    describe("verify2FACode", () => {
        it("should return true if 2FA not enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            const result = await service.verify2FACode(1, "123456");
            expect(result).toBe(true);
        });

        it("should verify code via authenticator", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: true, twoFactorSecret: "enc" });
            (authenticator.verify as jest.Mock).mockReturnValue(true);

            const result = await service.verify2FACode(1, "123456");
            expect(result).toBe(true);
        });
    });

    describe("verifyBackupCode", () => {
        it("should return false if 2FA not enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            const result = await service.verifyBackupCode(1, "CODE");
            expect(result).toBe(false);
        });

        it("should verify and mark used backup code", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
            });
            prisma.twoFactorBackupCode.findMany.mockResolvedValue([
                { id: 1, codeHash: "hash1", usedAt: null },
                { id: 2, codeHash: "hash2", usedAt: null },
            ]);
            (verifyBackupCode as jest.Mock).mockResolvedValue(0);
            prisma.twoFactorBackupCode.update.mockResolvedValue({});

            const result = await service.verifyBackupCode(1, "CODE1");
            expect(result).toBe(true);
            expect(prisma.twoFactorBackupCode.update).toHaveBeenCalledWith({
                where: { id: 1 },
                data: { usedAt: expect.any(Date) },
            });
        });

        it("should return false if code not found", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
            });
            prisma.twoFactorBackupCode.findMany.mockResolvedValue([
                { id: 1, codeHash: "hash1", usedAt: null },
            ]);
            (verifyBackupCode as jest.Mock).mockResolvedValue(-1);

            const result = await service.verifyBackupCode(1, "WRONG");
            expect(result).toBe(false);
        });

        it("should return false if no backup codes exist", async () => {
            prisma.user.findUnique.mockResolvedValue({
                isTwoFactorEnabled: true,
            });
            prisma.twoFactorBackupCode.findMany.mockResolvedValue([]);

            const result = await service.verifyBackupCode(1, "CODE");
            expect(result).toBe(false);
        });
    });

    describe("verify2FAForTransaction", () => {
        it("should throw if 2FA not enabled", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: false });
            await expect(service.verify2FAForTransaction(mockUser, { code: "123" })).rejects.toThrow();
        });

        it("should throw if code is invalid", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: true, twoFactorSecret: "enc" });
            (authenticator.verify as jest.Mock).mockReturnValue(false);

            await expect(service.verify2FAForTransaction(mockUser, { code: "000" })).rejects.toThrow();
        });

        it("should succeed for valid code", async () => {
            prisma.user.findUnique.mockResolvedValue({ isTwoFactorEnabled: true, twoFactorSecret: "enc" });
            (authenticator.verify as jest.Mock).mockReturnValue(true);

            const result = await service.verify2FAForTransaction(mockUser, { code: "123456" });
            expect(result.data.verified).toBe(true);
        });
    });

    // ==================== Security Preferences ====================

    describe("getSecurityPreferences", () => {
        it("should return security preferences with method details", async () => {
            prisma.user.findUnique.mockResolvedValue({
                securityMethods: { sms: true, email: false, authenticator: false, tradingPassword: false, biometric: false },
                requiredMethodCount: 1,
                isTwoFactorEnabled: false,
                isPhoneVerified: true,
                isEmailVerified: true,
                tradingPassword: null,
                tier: 1,
            });
            prisma.twoFactorBackupCode.aggregate.mockResolvedValue({
                _count: 1,
                _max: { createdAt: new Date() },
            });

            const result = await service.getSecurityPreferences(mockUser);
            expect(result.data.methods.sms.enabled).toBe(true);
            expect(result.data.methods.sms.verified).toBe(true);
            expect(result.data.minimumRequired).toBe(1);
        });
    });

    describe("updateSecurityPreferences", () => {
        it("should throw if enabling SMS without verified phone", async () => {
            prisma.user.findUnique.mockResolvedValue({
                securityMethods: {},
                isPhoneVerified: false,
                isEmailVerified: true,
                isTwoFactorEnabled: false,
                tradingPassword: null,
                tier: 1,
            });

            await expect(service.updateSecurityPreferences(mockUser, { methods: { sms: true } }))
                .rejects.toThrow("Phone must be verified");
        });

        it("should throw if enabling email without verified email", async () => {
            prisma.user.findUnique.mockResolvedValue({
                securityMethods: {},
                isPhoneVerified: true,
                isEmailVerified: false,
                isTwoFactorEnabled: false,
                tradingPassword: null,
                tier: 1,
            });

            await expect(service.updateSecurityPreferences(mockUser, { methods: { email: true } }))
                .rejects.toThrow("Email must be verified");
        });

        it("should update preferences when valid", async () => {
            prisma.user.findUnique.mockResolvedValue({
                securityMethods: { sms: false },
                requiredMethodCount: 1,
                isPhoneVerified: true,
                isEmailVerified: true,
                isTwoFactorEnabled: false,
                tradingPassword: null,
                tier: 1,
            });
            prisma.user.update.mockResolvedValue({});

            const result = await service.updateSecurityPreferences(mockUser, { methods: { sms: true } });
            expect(result.message).toContain("updated successfully");
        });
    });

    describe("setTradingPassword", () => {
        it("should throw if account password is wrong", async () => {
            prisma.user.findUnique.mockResolvedValue({ password: "hashed" });
            (bcrypt.compare as jest.Mock).mockResolvedValue(false);

            await expect(
                service.setTradingPassword(mockUser, { tradingPassword: "tp", accountPassword: "wrong" })
            ).rejects.toThrow();
        });

        it("should throw if trading password same as account password", async () => {
            prisma.user.findUnique.mockResolvedValue({ password: "hashed" });
            (bcrypt.compare as jest.Mock)
                .mockResolvedValueOnce(true)   // account password valid
                .mockResolvedValueOnce(true);  // trading password same as account

            await expect(
                service.setTradingPassword(mockUser, { tradingPassword: "same", accountPassword: "pw" })
            ).rejects.toThrow("different from your account password");
        });

        it("should set trading password successfully", async () => {
            prisma.user.findUnique.mockResolvedValue({
                password: "hashed",
                tradingPassword: null,
                securityMethods: {},
            });
            (bcrypt.compare as jest.Mock)
                .mockResolvedValueOnce(true)
                .mockResolvedValueOnce(false);
            prisma.twoFactorBackupCode.count.mockResolvedValue(0);
            prisma.user.update.mockResolvedValue({});

            const result = await service.setTradingPassword(mockUser, { tradingPassword: "newtp", accountPassword: "pw" });
            expect(result.message).toContain("Trading password");
        });
    });
});
