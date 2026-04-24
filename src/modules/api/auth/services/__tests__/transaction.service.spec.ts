import { Test, TestingModule } from "@nestjs/testing";

jest.mock("uuid", () => ({
    v4: jest.fn().mockReturnValue("test-uuid-123"),
}));

jest.mock("@/config", () => ({
    jwtSecret: "test",
    jwt_refresh_secret: "test",
    TOKEN_EXPIRATION: "1h",
    REFRESH_TOKEN_EXPIRATION: "7d",
    COMPANY_NAME: "Flipxer",
    isProdEnvironment: false,
    emailTemplateConfig: { flagged_account: "tpl-flagged" },
    mailConfig: { senderMail: "noreply@test.com" },
    storageDirConfig: {},
    cloudinaryConfig: {},
    imagekitConfig: {},
}));

import { TransactionService } from "../transaction.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { EmailService } from "@/modules/core/email/services";
import { TierService } from "../tier.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { GeneralTransactionException } from "@/modules/api/trade/errors";

function makePrisma() {
    return {
        flagged: { findUnique: jest.fn(), upsert: jest.fn() },
        cryptoRate: { findUnique: jest.fn() },
        order: { create: jest.fn(), findMany: jest.fn() },
        user: { update: jest.fn() },
        limitOverride: { findUnique: jest.fn().mockResolvedValue(null) },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
    };
}

describe("TransactionService", () => {
    let service: TransactionService;
    let prisma: ReturnType<typeof makePrisma>;
    let mockLCW: any;
    let mockCoinCap: any;
    let mockTierService: any;
    let mockRedisCache: any;
    let mockEmailService: any;

    const mockUser = {
        id: 1,
        email: "test@test.com",
        firstName: "Test",
        lastName: "User",
        tier: 1,
        userType: "INDIVIDUAL",
    } as any;

    beforeEach(async () => {
        prisma = makePrisma();
        mockLCW = { getPriceInUSD: jest.fn() };
        mockCoinCap = { getPriceInUSD: jest.fn() };
        mockTierService = {
            getWithdrawalLimit: jest.fn().mockReturnValue(5000),
        };
        mockRedisCache = {
            incrbyfloat: jest.fn().mockResolvedValue(null),
            decrbyfloat: jest.fn().mockResolvedValue(null),
            getCounter: jest.fn().mockResolvedValue(0),
            set: jest.fn().mockResolvedValue(undefined),
        };
        mockEmailService = { sendEmail: jest.fn(), sendMailWithTemplate: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                TransactionService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.LIVECOINWATCH, useValue: mockLCW },
                { provide: TradingInjectionToken.COINCAP, useValue: mockCoinCap },
                { provide: EmailService, useValue: mockEmailService },
                { provide: TierService, useValue: mockTierService },
                { provide: RedisCacheService, useValue: mockRedisCache },
            ],
        }).compile();

        service = module.get<TransactionService>(TransactionService);
    });

    describe("validateTransaction", () => {
        it("should throw if user is flagged", async () => {
            prisma.flagged.findUnique.mockResolvedValue({ flagged: true, reason: "Suspicious" });
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransaction(mockUser, 100, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should pass through to validateTransactionLimits if not flagged", async () => {
            prisma.flagged.findUnique.mockResolvedValue(null);

            // Mock getAmountInUSD via CryptoRate
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 }) // BTC rate in NGN
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });    // USDT rate in NGN

            // Redis unavailable, use DB fallback
            mockRedisCache.incrbyfloat.mockResolvedValue(null);
            prisma.$transaction.mockImplementation(async (cb: any) => {
                const tx = {
                    $queryRaw: jest.fn(),
                    order: { findMany: jest.fn().mockResolvedValue([]) },
                    cryptoRate: {
                        findUnique: jest.fn()
                            .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 }),
                    },
                };
                return cb(tx);
            });

            await expect(
                service.validateTransaction(mockUser, 0.001, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).resolves.toBeUndefined();
        });
    });

    describe("validateTransactionLimits", () => {
        it("should throw for invalid currency", async () => {
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 100, "FAKECOIN", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should throw for null currency", async () => {
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 100, null as any, "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should throw for non-string currency", async () => {
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 100, 123 as any, "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should throw when USD conversion fails", async () => {
            // All rate look-ups fail
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            mockLCW.getPriceInUSD.mockResolvedValue(null);
            mockCoinCap.getPriceInUSD.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 100, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should throw if tier 0 user tries to transact", async () => {
            const tier0User = { ...mockUser, tier: 0 };
            mockTierService.getWithdrawalLimit.mockReturnValue(0);

            // Mock successful USD conversion
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(tier0User, 0.001, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow("Complete KYC verification");
        });

        it("should check Redis-based daily limit and throw on excess", async () => {
            // Mock successful USD conversion
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });

            // Redis atomic increment exceeds per-operation daily limit (Tier 1 BUY = $50)
            mockRedisCache.incrbyfloat.mockResolvedValue(60);
            mockRedisCache.decrbyfloat.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 1, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow("Daily buy limit");
        });

        it("should enforce admin override per-operation via Redis", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });

            // Admin set a $200 per-operation daily override
            prisma.limitOverride.findUnique.mockResolvedValue({
                userId: 1, dailyLimitUSD: 200, expiresAt: null, reason: "VIP", grantedBy: 99,
            });

            // Redis returns per-op total exceeding override
            mockRedisCache.incrbyfloat.mockResolvedValue(250);
            mockRedisCache.decrbyfloat.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({});

            await expect(
                service.validateTransactionLimits(mockUser, 1, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).rejects.toThrow("Daily buy limit");

            // Verify it used the per-operation key
            const redisKey = mockRedisCache.incrbyfloat.mock.calls[0][0] as string;
            expect(redisKey).toContain(":daily:buy:");
        });

        it("should pass within admin override per-operation limit via Redis", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });

            // Admin set a $500 per-operation daily override
            prisma.limitOverride.findUnique.mockResolvedValue({
                userId: 1, dailyLimitUSD: 500, expiresAt: null, reason: "VIP", grantedBy: 99,
            });

            // Redis returns per-op total within limit
            mockRedisCache.incrbyfloat.mockResolvedValue(100);

            await expect(
                service.validateTransactionLimits(mockUser, 0.001, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).resolves.toBeUndefined();
        });

        it("should pass when within per-operation daily limit via Redis", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });

            // Tier 1 BUY limit is $50; Redis returns total within limit
            mockRedisCache.incrbyfloat.mockResolvedValueOnce(30);

            await expect(
                service.validateTransactionLimits(mockUser, 0.001, "BTC", "BUY" as any, "/api/v1/buy/order")
            ).resolves.toBeUndefined();
        });

        it("should accept lowercase valid currency", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "BTC", sellRate: 50000000 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1500 });

            // Tier 1 BUY limit is $50; Redis returns total within limit
            mockRedisCache.incrbyfloat.mockResolvedValueOnce(30);

            await expect(
                service.validateTransactionLimits(mockUser, 0.001, "btc", "BUY" as any, "/api/v1/buy/order")
            ).resolves.toBeUndefined();
        });
    });

    describe("getAmountInUSD fallback chain", () => {
        it("should use LiveCoinWatch if in-house rates unavailable", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            mockLCW.getPriceInUSD.mockResolvedValue(45000);

            // Access private method via bracket notation
            const result = await (service as any).getAmountInUSD("btc", 1);
            expect(result.amount).toBe(45000);
        });

        it("should use CoinCap if LiveCoinWatch fails", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            mockLCW.getPriceInUSD.mockRejectedValue(new Error("LCW down"));
            mockCoinCap.getPriceInUSD.mockResolvedValue(44000);

            const result = await (service as any).getAmountInUSD("btc", 1);
            expect(result.amount).toBe(44000);
        });

        it("should return null if all sources fail", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);
            mockLCW.getPriceInUSD.mockRejectedValue(new Error("down"));
            mockCoinCap.getPriceInUSD.mockRejectedValue(new Error("also down"));

            const result = await (service as any).getAmountInUSD("btc", 1);
            expect(result).toBeNull();
        });

        it("should return null for invalid asset", async () => {
            const result = await (service as any).getAmountInUSD(null, 1);
            expect(result).toBeNull();
        });
    });

    describe("recordFailedTransaction", () => {
        it("should determine BUY category from path", async () => {
            prisma.order.create.mockResolvedValue({});
            await service.recordFailedTransaction(mockUser, 100, "BTC", "test", "/api/v1/buy/order", "txn-1");
            expect(prisma.order.create.mock.calls[0][0].data.orderCategory).toBe("BUY");
        });

        it("should determine SELL category from path", async () => {
            prisma.order.create.mockResolvedValue({});
            await service.recordFailedTransaction(mockUser, 100, "BTC", "test", "/api/v1/sell/order", "txn-1");
            expect(prisma.order.create.mock.calls[0][0].data.orderCategory).toBe("SELL");
        });

        it("should determine SWAP category from path", async () => {
            prisma.order.create.mockResolvedValue({});
            await service.recordFailedTransaction(mockUser, 100, "BTC", "test", "/api/v1/request-instant-swap-quote", "txn-1");
            expect(prisma.order.create.mock.calls[0][0].data.orderCategory).toBe("SWAP");
        });

        it("should determine SEND category from path", async () => {
            prisma.order.create.mockResolvedValue({});
            await service.recordFailedTransaction(mockUser, 100, "BTC", "test", "/api/v1/withdrawer-request", "txn-1");
            expect(prisma.order.create.mock.calls[0][0].data.orderCategory).toBe("SEND");
        });

        it("should throw for unknown path", async () => {
            await expect(
                service.recordFailedTransaction(mockUser, 100, "BTC", "test", "/api/v1/unknown", "txn-1")
            ).rejects.toThrow("Invalid path for order category");
        });
    });

    describe("releaseDailyLimitReservationForOrder", () => {
        it("decrements the matching Redis daily-limit key using USD value", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 });

            mockRedisCache.getCounter.mockResolvedValue(7);
            mockRedisCache.decrbyfloat.mockResolvedValue(6);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: "USDT",
                amount: 1,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.getCounter).toHaveBeenCalledWith("limits:user:34:daily:buy:2026-04-16");
            expect(mockRedisCache.decrbyfloat).toHaveBeenCalledWith("limits:user:34:daily:buy:2026-04-16", 1);
        });

        it("does not create a negative key when the current counter is already zero", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 });

            mockRedisCache.getCounter.mockResolvedValue(0);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: "USDT",
                amount: 1,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.decrbyfloat).not.toHaveBeenCalled();
        });

        it("skips if currency, amount, or createdAt is missing", async () => {
            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: null,
                amount: 1,
                createdAt: new Date(),
            });

            expect(mockRedisCache.getCounter).not.toHaveBeenCalled();
        });

        it("warns and returns when USD conversion fails", async () => {
            prisma.cryptoRate.findUnique.mockResolvedValue(null);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "SELL" as any,
                currency: "UNKNOWN",
                amount: 100,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.getCounter).not.toHaveBeenCalled();
        });

        it("warns and returns when Redis getCounter returns null", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 });

            mockRedisCache.getCounter.mockResolvedValue(null);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: "USDT",
                amount: 1,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.decrbyfloat).not.toHaveBeenCalled();
        });

        it("warns and returns when Redis decrbyfloat returns null", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 });

            mockRedisCache.getCounter.mockResolvedValue(5);
            mockRedisCache.decrbyfloat.mockResolvedValue(null);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: "USDT",
                amount: 1,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.decrbyfloat).toHaveBeenCalled();
            expect(mockRedisCache.set).not.toHaveBeenCalled();
        });

        it("resets key to zero when decrbyfloat produces a negative value", async () => {
            prisma.cryptoRate.findUnique
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 })
                .mockResolvedValueOnce({ currency: "USDT", sellRate: 1550 });

            mockRedisCache.getCounter.mockResolvedValue(1);
            mockRedisCache.decrbyfloat.mockResolvedValue(-0.5);

            await service.releaseDailyLimitReservationForOrder({
                userId: 34,
                orderCategory: "BUY" as any,
                currency: "USDT",
                amount: 2,
                createdAt: new Date("2026-04-16T10:00:00.000Z"),
            });

            expect(mockRedisCache.set).toHaveBeenCalledWith(
                "limits:user:34:daily:buy:2026-04-16",
                0,
                expect.any(Number),
            );
        });
    });

    describe("sumOrdersInUsd", () => {
        it("should sum orders using rate cache", () => {
            const orders = [
                { amount: 1, currency: "BTC", createdAt: new Date() },
                { amount: 2, currency: "ETH", createdAt: new Date() },
                { amount: null, currency: "BTC", createdAt: new Date() },
            ];
            const rateCache = { BTC: 45000, ETH: 3000 };

            const result = (service as any).sumOrdersInUsd(orders, null, rateCache);
            expect(result).toBe(51000);
        });

        it("should filter by since date", () => {
            const now = new Date();
            const yesterday = new Date(now.getTime() - 86400000);
            const twoDaysAgo = new Date(now.getTime() - 172800000);

            const orders = [
                { amount: 1, currency: "BTC", createdAt: now },
                { amount: 1, currency: "BTC", createdAt: twoDaysAgo },
            ];
            const rateCache = { BTC: 45000 };

            const result = (service as any).sumOrdersInUsd(orders, yesterday, rateCache);
            expect(result).toBe(45000);
        });

        it("should skip orders with null amount or currency", () => {
            const orders = [
                { amount: null, currency: "BTC", createdAt: new Date() },
                { amount: 1, currency: null, createdAt: new Date() },
            ];
            const result = (service as any).sumOrdersInUsd(orders, null, {});
            expect(result).toBe(0);
        });
    });
});
