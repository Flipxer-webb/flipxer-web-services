// Break circular dependency: auth/services -> @/modules/api/user.
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error {
        constructor() {
            super("Account deleted");
        }
    }
    class UserNotFoundException extends Error {
        constructor() {
            super("User not found");
        }
    }
    class DuplicateUserException extends Error {
        constructor() {
            super("Duplicate user");
        }
    }
    class IncorrectPasswordException extends Error {
        constructor() {
            super("Incorrect password");
        }
    }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class UserModuleMock {
            readonly marker = true;
        },
        AccountDeletedException,
        UserNotFoundException,
        DuplicateUserException,
        IncorrectPasswordException,
        __esModule: true,
    };
});

import { HttpStatus } from "@nestjs/common";
import { UserService } from "../index";

describe("UserService coverage wave", () => {
    const mockUploadService = {
        uploadCompressedImage: jest.fn(),
        removeImage: jest.fn(),
    };

    const prisma = {
        limitOverride: {
            findUnique: jest.fn(),
        },
        order: {
            findMany: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        assetWallet: {
            findMany: jest.fn(),
            count: jest.fn(),
        },
        recoveryEmailVerificationRequest: {
            upsert: jest.fn(),
            findFirst: jest.fn(),
            delete: jest.fn(),
        },
        deviceToken: {
            upsert: jest.fn(),
            deleteMany: jest.fn(),
        },
        $transaction: jest.fn(async (items: any[]) => Promise.all(items)),
    };

    const authService = {
        comparePassword: jest.fn(),
        hashPassword: jest.fn(),
    };

    const individualKycStageService = {
        ensureCurrentIndividualStageAttempts: jest.fn(),
    };

    const emailService = {
        sendMailWithTemplate: jest.fn(),
    };

    const uploadFactory = {
        build: jest.fn().mockReturnValue(mockUploadService),
    };

    const quidaxCacheService = {
        getMarketTickers: jest.fn(),
    };

    const tierService = {
        getWithdrawalLimit: jest.fn().mockReturnValue(100),
        getDailyLimits: jest
            .fn()
            .mockReturnValue({ buy: 100, sell: 100, swap: 100, send: 100 }),
    };

    const liveCoinWatchService = {
        getPriceInUSD: jest.fn(),
        getBatchMarketData: jest.fn(),
    };

    const redisCacheService = {
        del: jest.fn(),
    };

    const ledgerService = {
        getAllBalances: jest.fn(),
    };

    const rateService = {
        getAllRates: jest.fn(),
    };

    let service: UserService;

    const user: any = {
        id: 7,
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@flipxer.dev",
        password: "hashed-password",
        tier: 2,
        photoFileId: "old-file-id",
    };

    beforeEach(() => {
        jest.clearAllMocks();
        service = new UserService(
            prisma as any,
            authService as any,
            individualKycStageService as any,
            emailService as any,
            uploadFactory as any,
            quidaxCacheService as any,
            tierService as any,
            liveCoinWatchService as any,
            redisCacheService as any,
            ledgerService as any,
            rateService as any,
        );
    });

    it("calculates percentage change with valid and invalid inputs", () => {
        expect(
            service.calculatePercentageChange({
                open: "100",
                last: "120",
            } as any),
        ).toBe(20);
        expect(
            service.calculatePercentageChange({
                open: "0",
                last: "120",
            } as any),
        ).toBeNull();
        expect(
            service.calculatePercentageChange({
                open: undefined,
                last: "120",
            } as any),
        ).toBeNull();
    });

    it("computes withdrawal usage with USD conversion", async () => {
        prisma.order.findMany.mockResolvedValue([
            { amount: 2, currency: "BTC", orderCategory: "BUY" },
            { amount: 3, currency: "ETH", orderCategory: "SELL" },
        ]);
        prisma.limitOverride.findUnique.mockResolvedValue(null);
        liveCoinWatchService.getPriceInUSD
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(5);
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);

        expect(result.data.buy.usedToday).toBe(20);
        expect(result.data.sell.usedToday).toBe(15);
        expect(result.data.buy.remainingToday).toBe(80);
        expect(result.data.sell.remainingToday).toBe(85);
    });

    it("fetches each withdrawal usage currency rate once", async () => {
        prisma.order.findMany.mockResolvedValue([
            { amount: 1, currency: "BTC", orderCategory: "BUY" },
            { amount: 2, currency: "BTC", orderCategory: "SELL" },
            { amount: 3, currency: "ETH", orderCategory: "SWAP" },
        ]);
        prisma.limitOverride.findUnique.mockResolvedValue(null);
        liveCoinWatchService.getPriceInUSD.mockImplementation(
            async (currency: string) => {
                return currency === "btc" ? 10 : 5;
            },
        );
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);

        expect(liveCoinWatchService.getPriceInUSD).toHaveBeenCalledTimes(2);
        expect(liveCoinWatchService.getPriceInUSD).toHaveBeenCalledWith("btc");
        expect(liveCoinWatchService.getPriceInUSD).toHaveBeenCalledWith("eth");
        expect(result.data.buy.usedToday).toBe(10);
        expect(result.data.sell.usedToday).toBe(20);
        expect(result.data.swap.usedToday).toBe(15);
    });

    it("handles rate fetch failures in withdrawal usage", async () => {
        prisma.order.findMany.mockResolvedValue([
            { amount: 2, currency: "BTC", orderCategory: "BUY" },
        ]);
        prisma.limitOverride.findUnique.mockResolvedValue(null);
        liveCoinWatchService.getPriceInUSD.mockRejectedValue(
            new Error("rate-api-failed"),
        );
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);
        expect(result.data.buy.usedToday).toBe(0);
    });

    it("uses the active daily limit override for all operations", async () => {
        prisma.order.findMany.mockResolvedValue([
            { amount: 2, currency: "BTC", orderCategory: "BUY" },
        ]);
        prisma.limitOverride.findUnique.mockResolvedValue({
            userId: user.id,
            dailyLimitUSD: 250,
            expiresAt: null,
        });
        liveCoinWatchService.getPriceInUSD.mockResolvedValueOnce(10);
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);

        expect(result.data.buy.usedToday).toBe(20);
        expect(result.data.buy.dailyLimit).toBe(250);
        expect(result.data.buy.remainingToday).toBe(230);
        expect(result.data.sell.dailyLimit).toBe(250);
        expect(result.data.swap.dailyLimit).toBe(250);
        expect(result.data.send.dailyLimit).toBe(250);
    });

    it("returns paginated user list", async () => {
        prisma.user.findMany.mockResolvedValue([
            {
                id: 1,
                firstName: "A",
                lastName: "B",
                email: "a@b.c",
                phone: "0800",
                photo: null,
                status: "active",
                userType: "INDIVIDUAL",
                createdAt: new Date(),
            },
        ]);
        prisma.user.count.mockResolvedValue(1);

        const result = await service.getUserList({
            pageNumber: 1,
            pageSize: 10,
            sortBy: "desc",
            paginated: "true",
        } as any);

        expect(result.success).toBe(true);
        expect(result.data.records).toHaveLength(1);
        expect(result.data.meta).toBeDefined();
    });

    it("updates details and uploads profile image", async () => {
        mockUploadService.uploadCompressedImage.mockResolvedValue({
            url: "https://cdn.example/new.webp",
            fileId: "new-file-id",
        });
        mockUploadService.removeImage.mockResolvedValue({});
        prisma.user.update.mockResolvedValue({
            id: user.id,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@flipxer.dev",
            recoveryEmail: null,
            photo: "https://cdn.example/new.webp",
            phone: "08012345678",
            gender: "female",
            dateOfBirth: null,
            country: "NG",
        });

        const result = await service.updateUserDetails(
            { firstName: "Ada" } as any,
            user,
            { buffer: Buffer.from("image") } as any,
        );

        expect(result.message).toContain("updated successfully");
        expect(mockUploadService.uploadCompressedImage).toHaveBeenCalled();
        expect(mockUploadService.removeImage).toHaveBeenCalled();
        expect(redisCacheService.del).toHaveBeenCalled();
    });

    it("throws generic exception when profile upload fails", async () => {
        mockUploadService.uploadCompressedImage.mockRejectedValue(
            new Error("upload-failed"),
        );

        await expect(
            service.updateUserDetails({ firstName: "Ada" } as any, user, {
                buffer: Buffer.from("image"),
            } as any),
        ).rejects.toMatchObject({
            message: "Failed to update profile image",
            status: HttpStatus.INTERNAL_SERVER_ERROR,
        });
    });

    it("aggregates wallet balance using sell rates", async () => {
        ledgerService.getAllBalances.mockResolvedValue(
            new Map([
                ["BTC", { available: "2", held: "0" }],
                ["ETH", { available: "1", held: "0" }],
            ]),
        );

        rateService.getAllRates.mockResolvedValue([
            { currency: "BTC", sellRate: 100, buyRate: 98 },
            { currency: "ETH", sellRate: 50, buyRate: 48 },
        ]);

        const result = await service.getUserAggregatedWalletBalance(user);
        expect(result.data.total).toBe(250);
        expect(result.data.referenceCurrency).toBe("ngn");
    });

    it("builds user wallets response with dynamic rates and live conversion", async () => {
        prisma.assetWallet.findMany.mockResolvedValue([
            {
                id: 11,
                userId: user.id,
                assetCurrency: "BTC",
                assetName: "Bitcoin",
                createdAt: new Date(),
            },
        ]);
        prisma.assetWallet.count.mockResolvedValue(1);

        rateService.getAllRates.mockResolvedValue([
            { currency: "BTC", buyRate: 95, sellRate: 100 },
        ]);

        quidaxCacheService.getMarketTickers.mockResolvedValue({
            btcngn: {
                ticker: {
                    buy: "95",
                    sell: "100",
                    open: "90",
                    last: "99",
                },
            },
        });

        ledgerService.getAllBalances.mockResolvedValue(
            new Map([["BTC", { available: "2", held: "0.5" }]]),
        );

        liveCoinWatchService.getBatchMarketData.mockResolvedValue({
            btc: { change24h: 1.25 },
        });

        const result = await service.getUserWallets(user.id, {
            pageNumber: 1,
            pageSize: 10,
            sortBy: "desc",
            paginated: "true",
        } as any);

        expect(result.message).toContain("retrieved");
        expect(result.data.tradeMinimums).toEqual({
            buy: 3,
            sell: 3,
            swap: 10,
        });
        expect(result.data.records[0]).toMatchObject({
            balance: "2",
            locked: "0.5",
            convertedBalance: "200.00",
        });
    });

    it("creates synthetic wallets for ledger-only balances", async () => {
        // DB has BTC wallet, ledger has BTC + ETH
        prisma.assetWallet.findMany.mockResolvedValue([
            {
                id: 11,
                userId: user.id,
                assetCurrency: "BTC",
                assetName: "Bitcoin",
                createdAt: new Date(),
            },
        ]);
        prisma.assetWallet.count.mockResolvedValue(1);

        rateService.getAllRates.mockResolvedValue([
            { currency: "BTC", buyRate: 95, sellRate: 100 },
            { currency: "ETH", buyRate: 5000, sellRate: 5500 },
        ]);

        quidaxCacheService.getMarketTickers.mockResolvedValue({});

        ledgerService.getAllBalances.mockResolvedValue(
            new Map([
                ["BTC", { available: "2", held: "0" }],
                ["ETH", { available: "1.5", held: "0.1" }],
            ]),
        );

        liveCoinWatchService.getBatchMarketData.mockResolvedValue({});

        const result = await service.getUserWallets(user.id, {
            sortBy: "desc",
            paginated: "false",
        } as any);

        // Should have BTC from DB + ETH synthetic
        const currencies = result.data.records.map((r: any) => r.assetCurrency);
        expect(currencies).toContain("BTC");
        expect(currencies).toContain("ETH");
        expect(result.data.records.length).toBe(2);
    });

    it("includes catalog assets when includeSupported=true", async () => {
        prisma.assetWallet.findMany.mockResolvedValue([]);
        prisma.assetWallet.count.mockResolvedValue(0);
        rateService.getAllRates.mockResolvedValue([]);
        quidaxCacheService.getMarketTickers.mockResolvedValue({});
        ledgerService.getAllBalances.mockResolvedValue(new Map());
        liveCoinWatchService.getBatchMarketData.mockResolvedValue({});

        const result = await service.getUserWallets(user.id, {
            includeSupported: "true",
            sortBy: "desc",
            paginated: "false",
        } as any);

        // Should include supported catalog assets even with no DB/ledger data
        expect(result.data.records.length).toBeGreaterThan(0);
    });

    it("filters wallets by searchText", async () => {
        prisma.assetWallet.findMany.mockResolvedValue([]);
        prisma.assetWallet.count.mockResolvedValue(0);
        rateService.getAllRates.mockResolvedValue([]);
        quidaxCacheService.getMarketTickers.mockResolvedValue({});
        ledgerService.getAllBalances.mockResolvedValue(
            new Map([
                ["BTC", { available: "1", held: "0" }],
                ["ETH", { available: "1", held: "0" }],
            ]),
        );
        liveCoinWatchService.getBatchMarketData.mockResolvedValue({});

        const result = await service.getUserWallets(user.id, {
            searchText: "btc",
            sortBy: "desc",
            paginated: "false",
        } as any);

        const currencies = result.data.records.map((r: any) => r.assetCurrency);
        expect(currencies).toContain("BTC");
        expect(currencies).not.toContain("ETH");
    });

    it("skips synthetic wallet when ledger balance is zero", async () => {
        prisma.assetWallet.findMany.mockResolvedValue([]);
        prisma.assetWallet.count.mockResolvedValue(0);
        rateService.getAllRates.mockResolvedValue([]);
        quidaxCacheService.getMarketTickers.mockResolvedValue({});
        ledgerService.getAllBalances.mockResolvedValue(
            new Map([["DOGE", { available: "0", held: "0" }]]),
        );
        liveCoinWatchService.getBatchMarketData.mockResolvedValue({});

        const result = await service.getUserWallets(user.id, {
            sortBy: "desc",
            paginated: "false",
        } as any);

        const currencies = result.data.records.map((r: any) => r.assetCurrency);
        expect(currencies).not.toContain("DOGE");
    });

    it("rejects password update when old password is incorrect", async () => {
        authService.comparePassword.mockResolvedValue(false);

        await expect(
            service.updateProfilePassword(
                { oldPassword: "bad", newPassword: "new" } as any,
                user,
            ),
        ).rejects.toThrow("does not match");
    });

    it("rejects password update when new password matches old", async () => {
        authService.comparePassword.mockResolvedValue(true);

        await expect(
            service.updateProfilePassword(
                { oldPassword: "same", newPassword: "same" } as any,
                user,
            ),
        ).rejects.toThrow("must be different");
    });

    it("updates password when inputs are valid", async () => {
        authService.comparePassword.mockResolvedValue(true);
        authService.hashPassword.mockResolvedValue("new-hash");
        prisma.user.update.mockResolvedValue({});
        const passwordPayload = {
            ["oldPassword"]: ["old"].join(""),
            ["newPassword"]: ["new", "pass"].join("-"),
        } as any;

        const result = await service.updateProfilePassword(
            passwordPayload,
            user,
        );

        expect(result.message).toContain("successfully updated");
    });

    it("sends recovery email OTP", async () => {
        prisma.recoveryEmailVerificationRequest.upsert.mockResolvedValue({});
        emailService.sendMailWithTemplate.mockResolvedValue({});

        const result = await service.sendRecoveryEmailOtp(
            { email: " recovery@flipxer.dev " } as any,
            user,
        );

        expect(result.message).toContain(user.email);
        expect(
            prisma.recoveryEmailVerificationRequest.upsert,
        ).toHaveBeenCalled();

        const upsertPayload =
            prisma.recoveryEmailVerificationRequest.upsert.mock.calls[0][0];
        expect(upsertPayload.update.email).toBe("recovery@flipxer.dev");
        expect(upsertPayload.update.code).toMatch(/^\d{6}$/);
    });

    it("verifies recovery email OTP in the valid path", async () => {
        const now = new Date();
        prisma.recoveryEmailVerificationRequest.findFirst.mockResolvedValue({
            id: 12,
            userId: user.id,
            email: "recovery@flipxer.dev",
            code: "123456",
            isVerified: false,
            updatedAt: now,
        });
        prisma.user.update.mockResolvedValue({});
        prisma.recoveryEmailVerificationRequest.delete.mockResolvedValue({});
        prisma.$transaction.mockResolvedValue([{}, {}]);

        const result = await service.verifyRecoveryEmailOtp(
            { otp: "123456" } as any,
            user,
        );

        expect(result.message).toContain("verified successfully");
    });

    it("rejects invalid, duplicate, and expired recovery email OTP", async () => {
        prisma.recoveryEmailVerificationRequest.findFirst.mockResolvedValueOnce(
            null,
        );
        await expect(
            service.verifyRecoveryEmailOtp({ otp: "000000" } as any, user),
        ).rejects.toThrow("Invalid verification code");

        prisma.recoveryEmailVerificationRequest.findFirst.mockResolvedValueOnce(
            {
                isVerified: true,
                updatedAt: new Date(),
            },
        );
        await expect(
            service.verifyRecoveryEmailOtp({ otp: "111111" } as any, user),
        ).rejects.toThrow("already verified");

        prisma.recoveryEmailVerificationRequest.findFirst.mockResolvedValueOnce(
            {
                isVerified: false,
                updatedAt: new Date(Date.now() - 31 * 60 * 1000),
            },
        );
        await expect(
            service.verifyRecoveryEmailOtp({ otp: "222222" } as any, user),
        ).rejects.toThrow("has expired");
    });

    it("updates notification token for enable and disable flows", async () => {
        prisma.deviceToken.upsert.mockResolvedValue({});
        prisma.user.update.mockResolvedValue({});
        prisma.deviceToken.deleteMany.mockResolvedValue({ count: 2 });

        const enabled = await service.updateNotificationToken(
            user,
            "token-abc",
            "Pixel",
            "android",
        );
        expect(enabled.message).toContain("enabled");

        const disabled = await service.updateNotificationToken(user, null);
        expect(disabled.message).toContain("disabled");
        expect(redisCacheService.del).toHaveBeenCalled();
    });

    it("falls back to legacy notification token update when deviceToken upsert fails", async () => {
        prisma.deviceToken.upsert.mockRejectedValue(new Error("upsert-failed"));
        prisma.user.update.mockResolvedValue({});

        const result = await service.updateNotificationToken(
            user,
            "legacy-token",
        );
        expect(result.message).toContain("enabled");
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: user.id },
            data: { notificationToken: "legacy-token" },
        });
    });

    it("returns user by email and throws when user does not exist", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            id: 99,
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@flipxer.dev",
            photo: null,
            status: "active",
        });

        const result = await service.getUserByEmail(" ADA@FLIPXER.DEV ");
        expect(result.message).toBe("User found");
        expect(result.data.id).toBe(99);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        await expect(
            service.getUserByEmail("missing@flipxer.dev"),
        ).rejects.toThrow("User not found");
    });

    it("returns null for expired limit override", async () => {
        prisma.order.findMany.mockResolvedValue([]);
        prisma.limitOverride.findUnique.mockResolvedValue({
            userId: user.id,
            dailyLimitUSD: 500,
            expiresAt: new Date("2020-01-01"),
        });
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);
        expect(result.data.buy.dailyLimit).toBe(100);
    });

    it("falls back to tier defaults when limitOverride query throws", async () => {
        prisma.order.findMany.mockResolvedValue([]);
        prisma.limitOverride.findUnique.mockRejectedValue(
            new Error("db error"),
        );
        tierService.getDailyLimits.mockReturnValue({
            buy: 100,
            sell: 100,
            swap: 100,
            send: 100,
        });

        const result = await service.getWithdrawalUsage(user);
        expect(result.data.buy.dailyLimit).toBe(100);
    });
});
