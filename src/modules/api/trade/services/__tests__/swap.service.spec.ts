import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

jest.mock("@/config", () => ({
    ...jest.requireActual("@/config"),
    quidaxConfig: { mainAccountId: "main-account-uuid" },
}));

import { SwapService } from "../swap.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { SellOrderService } from "../sell-order.service";
import { BuyOrderService } from "../buy-order.service";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { TransactionService } from "@/modules/api/auth/services/transaction.service";
import { WalletAddressService } from "../wallet-address.service";
import { WsGateway } from "../../gateway/v1";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { WalletManagementService } from "@/modules/api/operations/services/wallet-management.service";
import { RateService } from "../rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { FailedRollbackQueueService } from "../failed-rollback-queue.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { OrderCategory, OrderStatus } from "@prisma/client";

function makePrisma() {
    return {
        swapPair: { findUnique: jest.fn() },
        order: {
            create: jest.fn(),
            update: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
        },
        ledgerEntry: { findFirst: jest.fn() },
        user: { findUnique: jest.fn() },
    };
}

const mockUser = {
    id: 1,
    email: "test@flipxer.com",
    firstName: "Test",
    lastName: "User",
    username: "testuser",
    identifier: "USR-001",
    cryptoSubAccountId: "quidax-123",
    createdAt: new Date(),
    updatedAt: new Date(),
} as any;

describe("SwapService", () => {
    let service: SwapService;
    let prisma: ReturnType<typeof makePrisma>;
    let sellOrderService: { calculateSellQuote: jest.Mock; executeInternalSell: jest.Mock };
    let buyOrderService: { executeInternalBuy: jest.Mock };
    let redisCache: { set: jest.Mock; getDel: jest.Mock };
    let rateService: { getAssetRate: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockSell = {
            calculateSellQuote: jest.fn(),
            executeInternalSell: jest.fn().mockResolvedValue(undefined),
        };
        const mockBuy = {
            executeInternalBuy: jest.fn().mockResolvedValue(undefined),
        };
        const mockRedis = {
            set: jest.fn().mockResolvedValue(undefined),
            getDel: jest.fn(),
        };
        const mockTransaction = {
            validateTransaction: jest.fn().mockResolvedValue(undefined),
        };
        const mockWallet = { syncWallet: jest.fn().mockResolvedValue(undefined) };
        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };
        const mockWalletMgmt = { invalidateWalletCache: jest.fn() };
        const mockRate = {
            getAssetRate: jest.fn().mockResolvedValue({ buyRate: 70000000, sellRate: 69000000 }),
        };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockFailedRollback = { addToQueue: jest.fn().mockResolvedValue("rb-1") };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_k: string, fn: () => Promise<any>) => fn()),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SwapService,
                { provide: PrismaService, useValue: prisma },
                { provide: SellOrderService, useValue: mockSell },
                { provide: BuyOrderService, useValue: mockBuy },
                { provide: RedisCacheService, useValue: mockRedis },
                { provide: TransactionService, useValue: mockTransaction },
                { provide: WalletAddressService, useValue: mockWallet },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: SlackWebhookService, useValue: mockSlack },
                { provide: WalletManagementService, useValue: mockWalletMgmt },
                { provide: RateService, useValue: mockRate },
                { provide: NotificationDispatcher, useValue: mockNotification },
                { provide: FailedRollbackQueueService, useValue: mockFailedRollback },
                { provide: DistributedLockService, useValue: mockLock },
            ],
        }).compile();

        service = module.get(SwapService);
        sellOrderService = module.get(SellOrderService);
        buyOrderService = module.get(BuyOrderService);
        redisCache = module.get(RedisCacheService);
        rateService = module.get(RateService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── createInstantSwap ────────────────────────────────────

    describe("createInstantSwap", () => {
        it("should throw when user has no crypto account", async () => {
            const user = { ...mockUser, cryptoSubAccountId: null };

            await expect(
                service.createInstantSwap(user, {
                    from_currency: "BTC",
                    to_currency: "ETH",
                    from_amount: 0.1,
                } as any),
            ).rejects.toThrow("Please complete your account setup");
        });

        it("should use admin swap pair rate when active", async () => {
            (prisma as any).swapPair.findUnique.mockResolvedValue({
                isActive: true,
                rate: 15.5,
            });

            const result = await service.createInstantSwap(mockUser, {
                from_currency: "BTC",
                to_currency: "ETH",
                from_amount: 1,
            } as any);

            expect(result.data.rate).toBe("15.5");
            expect(result.data.from_currency).toBe("BTC");
            expect(result.data.to_currency).toBe("ETH");
            expect(redisCache.set).toHaveBeenCalled();
        });

        it("should use derived cross-rate when no swap pair", async () => {
            (prisma as any).swapPair.findUnique.mockResolvedValue(null);
            sellOrderService.calculateSellQuote.mockResolvedValue({
                totalToReceiveInFiat: 7000000, // 0.1 BTC * 70M
            });
            rateService.getAssetRate.mockResolvedValue({ buyRate: 4000000, sellRate: 3900000 });

            const result = await service.createInstantSwap(mockUser, {
                from_currency: "BTC",
                to_currency: "ETH",
                from_amount: 0.1,
            } as any);

            expect(result.data).toBeDefined();
            expect(redisCache.set).toHaveBeenCalled();
        });
    });

    // ── refreshInstantSwap ───────────────────────────────────

    describe("refreshInstantSwap", () => {
        it("should delegate to createInstantSwap", async () => {
            (prisma as any).swapPair.findUnique.mockResolvedValue({ isActive: true, rate: 15 });

            const result = await service.refreshInstantSwap(mockUser, {
                from_currency: "BTC",
                to_currency: "ETH",
                from_amount: 0.1,
            } as any);

            expect(result.data).toBeDefined();
        });
    });

    // ── confirmInstantSwapQuote ──────────────────────────────

    describe("confirmInstantSwapQuote", () => {
        const quoteData = {
            id: "quote-1",
            user_id: 1,
            from_currency: "BTC",
            to_currency: "ETH",
            from_amount: 0.1,
            to_amount: 1.5,
            fiat_amount: 7000000,
            rate: 15,
            expires_at: new Date(Date.now() + 60000).toISOString(),
        };

        it("should throw when user has no crypto account", async () => {
            const user = { ...mockUser, cryptoSubAccountId: null };

            await expect(
                service.confirmInstantSwapQuote(user, { quotationId: "q-1" } as any),
            ).rejects.toThrow("Please complete your account setup");
        });

        it("should throw when quote expired", async () => {
            redisCache.getDel.mockResolvedValue(null);

            await expect(
                service.confirmInstantSwapQuote(mockUser, { quotationId: "q-1" } as any),
            ).rejects.toThrow();
        });

        it("should return existing order for duplicate quotation", async () => {
            redisCache.getDel.mockResolvedValue(quoteData);
            prisma.order.findFirst.mockResolvedValue({ id: 99, transactionId: "TX-99" });

            const result = await service.confirmInstantSwapQuote(mockUser, {
                quotationId: "quote-1",
            } as any);

            expect(result.data.id).toBe(99);
            expect(prisma.order.create).not.toHaveBeenCalled();
        });

        it("should execute sell and buy legs on success", async () => {
            redisCache.getDel.mockResolvedValue(quoteData);
            prisma.order.findFirst.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({
                id: 1,
                transactionId: "TX-1",
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.processing,
                streamlinedStatus: "processing",
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            prisma.order.update.mockResolvedValue({
                id: 1,
                status: OrderStatus.completed,
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            const result = await service.confirmInstantSwapQuote(mockUser, {
                quotationId: "quote-1",
            } as any);

            expect(sellOrderService.executeInternalSell).toHaveBeenCalled();
            expect(buyOrderService.executeInternalBuy).toHaveBeenCalled();
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.completed }),
                }),
            );
            expect(result.message).toContain("confirmed");
        });

        it("should rollback on buy leg failure", async () => {
            redisCache.getDel.mockResolvedValue(quoteData);
            prisma.order.findFirst.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({
                id: 2,
                transactionId: "TX-2",
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.processing,
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            // Sell succeeds, buy fails
            buyOrderService.executeInternalBuy.mockRejectedValue(new Error("Buy failed"));
            prisma.order.update.mockResolvedValue({});

            await expect(
                service.confirmInstantSwapQuote(mockUser, { quotationId: "quote-1" } as any),
            ).rejects.toThrow("Swap failed");

            // Rollback buy was called (credit back source currency)
            expect(buyOrderService.executeInternalBuy).toHaveBeenCalledTimes(2); // buy leg + rollback
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.failed }),
                }),
            );
        });
    });

    // ── retryPendingSwap ─────────────────────────────────────

    describe("retryPendingSwap", () => {
        it("should throw when order not found", async () => {
            prisma.order.findUnique.mockResolvedValue(null);

            await expect(service.retryPendingSwap(999)).rejects.toThrow("not found");
        });

        it("should throw when not a swap order", async () => {
            prisma.order.findUnique.mockResolvedValue({
                id: 1,
                orderCategory: OrderCategory.BUY,
                status: OrderStatus.pending,
            });

            await expect(service.retryPendingSwap(1)).rejects.toThrow("Not a Swap");
        });

        it("should throw when order not in retryable state", async () => {
            prisma.order.findUnique.mockResolvedValue({
                id: 1,
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.completed,
            });

            await expect(service.retryPendingSwap(1)).rejects.toThrow("not in PENDING or FAILED");
        });

        it("should skip if buy leg already completed", async () => {
            prisma.order.findUnique.mockResolvedValue({
                id: 1,
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.pending,
                toCurrency: "ETH",
                toAmount: 1.5,
                orderReference: "ref-1",
                userId: 1,
            });
            prisma.ledgerEntry.findFirst.mockResolvedValue({ id: 10 }); // Already exists

            const result = await service.retryPendingSwap(1);

            expect(result.message).toContain("already completed");
            expect(buyOrderService.executeInternalBuy).not.toHaveBeenCalled();
        });

        it("should execute buy leg and complete order", async () => {
            prisma.order.findUnique
                .mockResolvedValueOnce({
                    id: 1,
                    orderCategory: OrderCategory.SWAP,
                    status: OrderStatus.pending,
                    toCurrency: "ETH",
                    toAmount: 1.5,
                    orderReference: "ref-1",
                    userId: 1,
                    amount: 0.1,
                    currency: "BTC",
                    transactionId: "TX-1",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .mockResolvedValueOnce({ id: 1, email: "test@flipxer.com", firstName: "Test" }); // user lookup
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);
            prisma.user.findUnique.mockResolvedValue(mockUser);
            prisma.order.update.mockResolvedValue({});

            const result = await service.retryPendingSwap(1);

            expect(buyOrderService.executeInternalBuy).toHaveBeenCalledWith(
                mockUser,
                1.5,
                "ETH",
                "ref-1_buy",
            );
            expect(result.message).toContain("retried and completed");
        });

        it("should parse narration if toCurrency not stored", async () => {
            prisma.order.findUnique.mockResolvedValueOnce({
                id: 1,
                orderCategory: OrderCategory.SWAP,
                status: OrderStatus.failed,
                toCurrency: null,
                toAmount: null,
                rateAtConversion: 15,
                narration: "Swap BTC -> ETH",
                orderReference: "ref-2",
                userId: 1,
                amount: 0.1,
                currency: "BTC",
                transactionId: "TX-2",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            prisma.ledgerEntry.findFirst.mockResolvedValue(null);
            prisma.user.findUnique.mockResolvedValue(mockUser);
            prisma.order.update.mockResolvedValue({});

            await service.retryPendingSwap(1);

            expect(buyOrderService.executeInternalBuy).toHaveBeenCalledWith(
                mockUser,
                1.5, // 0.1 * 15
                "ETH",
                "ref-2_buy",
            );
        });
    });
});
