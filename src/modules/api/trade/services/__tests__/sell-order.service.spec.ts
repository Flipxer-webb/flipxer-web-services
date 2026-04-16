import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { SellOrderService } from "../sell-order.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { WsGateway } from "../../gateway/v1";
import { TradeHelpersService } from "../trade-helpers.service";
import { WalletAddressService } from "../wallet-address.service";
import { WalletManagementService } from "@/modules/api/operations/services/wallet-management.service";
import { WithdrawalWebhookHandler } from "../webhook-handlers/withdrawal-webhook.handler";
import { LedgerService } from "../ledger/ledger.service";
import { TransactionMonitorService } from "../ledger/transaction-monitor.service";
import { RateService } from "../rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";

function makePrisma() {
    return {
        bankDetail: { findFirst: jest.fn() },
        assetWallet: { findFirst: jest.fn() },
        order: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
}

const mockUser = {
    id: 1,
    email: "test@flipxer.com",
    firstName: "Test",
    lastName: "User",
    cryptoSubAccountId: "quidax-123",
    createdAt: new Date(),
    updatedAt: new Date(),
} as any;

describe("SellOrderService", () => {
    let service: SellOrderService;
    let prisma: ReturnType<typeof makePrisma>;
    let ledgerService: {
        hold: jest.Mock;
        releaseHold: jest.Mock;
        releaseHoldWithPlatformEntry: jest.Mock;
        pairedCredit: jest.Mock;
    };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockRate = {
            getAssetRate: jest.fn().mockResolvedValue({ buyRate: 70000000, sellRate: 69000000 }),
        };
        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };
        const mockTradeHelpers = { calculateFee: jest.fn() };
        const mockWallet = { syncWallet: jest.fn().mockResolvedValue(undefined) };
        const mockWalletMgmt = { invalidateWalletCache: jest.fn() };
        const mockWithdrawalHandler = {
            handle: jest.fn().mockResolvedValue(undefined),
            initiateFiatPayout: jest.fn().mockResolvedValue(undefined),
        };
        const mockLedger = {
            hold: jest.fn().mockResolvedValue({ success: true, entry: { id: 1 } }),
            releaseHold: jest.fn().mockResolvedValue({ success: true }),
            releaseHoldWithPlatformEntry: jest.fn().mockResolvedValue({
                success: true,
                userEntry: { id: 10 },
            }),
            pairedCredit: jest.fn().mockResolvedValue({ success: true }),
        };
        const mockTransactionMonitor = {
            validateBeforeExecution: jest.fn().mockResolvedValue({ success: true, blocked: false }),
        };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_k: string, fn: () => Promise<any>) => fn()),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SellOrderService,
                { provide: PrismaService, useValue: prisma },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: TradeHelpersService, useValue: mockTradeHelpers },
                { provide: WalletAddressService, useValue: mockWallet },
                { provide: WalletManagementService, useValue: mockWalletMgmt },
                { provide: WithdrawalWebhookHandler, useValue: mockWithdrawalHandler },
                { provide: LedgerService, useValue: mockLedger },
                { provide: TransactionMonitorService, useValue: mockTransactionMonitor },
                { provide: RateService, useValue: mockRate },
                { provide: NotificationDispatcher, useValue: mockNotification },
                { provide: SlackWebhookService, useValue: mockSlack },
                { provide: DistributedLockService, useValue: mockLock },
            ],
        }).compile();

        service = module.get(SellOrderService);
        ledgerService = module.get(LedgerService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── calculateSellQuote ───────────────────────────────────

    describe("calculateSellQuote", () => {
        it("should throw when user has no crypto account", async () => {
            const user = { ...mockUser, cryptoSubAccountId: null };

            await expect(
                service.calculateSellQuote(user, { asset: "btc", amount: 0.1 } as any),
            ).rejects.toThrow("Please complete your account setup");
        });

        it("should return sell quote with correct calculations", async () => {
            prisma.bankDetail.findFirst.mockResolvedValue({
                accountName: "Test User",
                accountNumber: "1234567890",
                bankName: "GTBank",
            });
            prisma.assetWallet.findFirst.mockResolvedValue({
                depositAddress: "addr-1",
                defaultNetwork: "btc",
            });

            const result = await service.calculateSellQuote(
                mockUser,
                { asset: "btc", amount: 0.1 } as any,
                true,
            );

            expect(result.sellRate).toBe(70000000);
            expect(result.cryptoSellAmount).toBe(0.1);
            expect(result.totalToReceiveInFiat).toBe(7000000); // 0.1 * 70M
            expect(result.currency).toBe("NGN");
        });

        it("should throw when asset wallet not found", async () => {
            prisma.bankDetail.findFirst.mockResolvedValue({ accountName: "Test" });
            prisma.assetWallet.findFirst.mockResolvedValue(null);

            await expect(
                service.calculateSellQuote(mockUser, { asset: "xyz", amount: 1 } as any),
            ).rejects.toThrow("not found");
        });

        it("should throw when no bank detail for non-internal call", async () => {
            prisma.bankDetail.findFirst.mockResolvedValue(null);
            prisma.assetWallet.findFirst.mockResolvedValue({
                depositAddress: "addr-1",
                defaultNetwork: "btc",
            });

            await expect(
                service.calculateSellQuote(
                    mockUser,
                    { asset: "btc", amount: 0.1 } as any,
                    false,
                ),
            ).rejects.toThrow("bank detail");
        });
    });

    // ── sellCryptoQuoteRequest ───────────────────────────────

    describe("sellCryptoQuoteRequest", () => {
        it("should return a formatted sell quote response", async () => {
            prisma.bankDetail.findFirst.mockResolvedValue({
                accountName: "Test",
                accountNumber: "123",
                bankName: "GTBank",
            });
            prisma.assetWallet.findFirst.mockResolvedValue({
                depositAddress: "addr-1",
                defaultNetwork: "btc",
            });

            const result = await service.sellCryptoQuoteRequest(mockUser, {
                asset: "btc",
                amount: 0.5,
            } as any);

            expect(result.message).toContain("Quotation");
            expect(result.data.sellRate).toBe(70000000);
        });
    });

    // ── sellCryptoOrder ──────────────────────────────────────

    describe("sellCryptoOrder", () => {
        const dto = {
            asset: "btc",
            amount: 0.1,
            idempotencyKey: "idem-key-1",
            bankDetail: {
                bankName: "GTBank",
                accountNumber: "1234567890",
                accountName: "Test User",
                bankCode: "058",
            },
        } as any;

        beforeEach(() => {
            prisma.bankDetail.findFirst.mockResolvedValue({
                accountName: "Test User",
                accountNumber: "1234567890",
                bankName: "GTBank",
            });
            prisma.assetWallet.findFirst.mockResolvedValue({
                depositAddress: "addr-1",
                defaultNetwork: "btc",
            });
        });

        it("should return existing order on duplicate idempotency key", async () => {
            prisma.order.findFirst.mockResolvedValue({ id: 99, status: "completed" });

            const result = await service.sellCryptoOrder(mockUser, dto);

            expect(result.message).toContain("Duplicate");
            expect(ledgerService.hold).not.toHaveBeenCalled();
        });

        it("should throw when transaction monitor blocks", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            const monitor = service["transactionMonitorService"] as any;
            monitor.validateBeforeExecution.mockResolvedValue({
                success: false,
                reason: "High risk detected",
            });

            await expect(service.sellCryptoOrder(mockUser, dto)).rejects.toThrow(
                "High risk detected",
            );
        });

        it("should throw when hold fails (insufficient balance)", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            ledgerService.hold.mockResolvedValue({
                success: false,
                error: "Insufficient balance",
            });

            await expect(service.sellCryptoOrder(mockUser, dto)).rejects.toThrow(
                "Insufficient",
            );
        });

        it("should create order and trigger payout on success", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            prisma.order.create.mockResolvedValue({
                id: 1,
                transactionId: "TX-1",
                status: "processing",
                streamlinedStatus: "processing",
                orderCategory: "SELL",
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            });
            prisma.order.findUnique.mockResolvedValue({
                id: 1,
                status: "processing",
                streamlinedStatus: "processing",
            });

            const result = await service.sellCryptoOrder(mockUser, dto);
            const withdrawalHandler = service["withdrawalWebhookHandler"] as any;

            expect(ledgerService.hold).toHaveBeenCalled();
            expect(ledgerService.releaseHoldWithPlatformEntry).toHaveBeenCalledWith(
                expect.objectContaining({ settle: true }),
            );
            expect(prisma.order.create).toHaveBeenCalled();
            expect(withdrawalHandler.initiateFiatPayout).toHaveBeenCalled();
            expect(result.message).toContain("Order placed");
        });

        it("should release hold if settlement fails", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            ledgerService.releaseHoldWithPlatformEntry.mockResolvedValue({
                success: false,
                error: "Settlement failed",
            });

            await expect(service.sellCryptoOrder(mockUser, dto)).rejects.toThrow();

            expect(ledgerService.releaseHold).toHaveBeenCalled();
        });

        // ── WebSocket state emission ──────────────────────────────

        it("emits processing status via WebSocket immediately after order creation", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            const createdOrder = {
                id: 5,
                transactionId: "TX-WS-PROC",
                status: "processing",
                streamlinedStatus: "processing",
                orderCategory: "SELL",
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            prisma.order.create.mockResolvedValue(createdOrder);
            prisma.order.findUnique.mockResolvedValue(createdOrder);

            const wsGateway = service["wsGateway"] as any;

            await service.sellCryptoOrder(mockUser, dto);

            expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
                mockUser.id,
                expect.objectContaining({
                    type: "transaction_update",
                    transaction: expect.objectContaining({
                        transactionId: "TX-WS-PROC",
                        streamlinedStatus: "processing",
                        status: "processing",
                    }),
                }),
            );
        });

        it("emits failed status via WebSocket when payout initiation fails", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            const createdOrder = {
                id: 6,
                transactionId: "TX-WS-FAIL",
                status: "processing",
                streamlinedStatus: "processing",
                orderCategory: "SELL",
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            prisma.order.create.mockResolvedValue(createdOrder);
            prisma.order.update.mockResolvedValue({
                ...createdOrder,
                status: "failed",
                streamlinedStatus: "failed",
            });

            // Payout handler throws
            const withdrawalHandler = service["withdrawalWebhookHandler"] as any;
            withdrawalHandler.initiateFiatPayout.mockRejectedValueOnce(new Error("Nomba unavailable"));

            // Refund succeeds so we get to the WebSocket emit
            ledgerService.pairedCredit.mockResolvedValue({ success: true, userEntry: { id: 88 } });

            const wsGateway = service["wsGateway"] as any;

            await expect(service.sellCryptoOrder(mockUser, dto)).rejects.toThrow();

            // First call = processing, second call = failed
            const calls = wsGateway.notifyTransactionUpdate.mock.calls;
            const failedCall = calls.find(
                ([_uid, payload]: [number, any]) =>
                    payload?.transaction?.streamlinedStatus === "failed",
            );
            expect(failedCall).toBeDefined();
            expect(failedCall[0]).toBe(mockUser.id);
            expect(failedCall[1].transaction.status).toBe("failed");
            expect(failedCall[1].transaction.transactionId).toBe("TX-WS-FAIL");
        });

        it("does not emit failed WebSocket when sell order succeeds end-to-end", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            const createdOrder = {
                id: 7,
                transactionId: "TX-WS-OK",
                status: "processing",
                streamlinedStatus: "processing",
                orderCategory: "SELL",
                amount: 0.1,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
            };
            prisma.order.create.mockResolvedValue(createdOrder);
            prisma.order.findUnique.mockResolvedValue(createdOrder);

            const wsGateway = service["wsGateway"] as any;

            await service.sellCryptoOrder(mockUser, dto);

            const failedEmit = wsGateway.notifyTransactionUpdate.mock.calls.find(
                ([_uid, payload]: [number, any]) =>
                    payload?.transaction?.streamlinedStatus === "failed",
            );
            expect(failedEmit).toBeUndefined();
        });
    });

    // ── executeInternalSell ──────────────────────────────────

    describe("executeInternalSell", () => {
        it("should hold and settle funds for swap sell leg", async () => {
            await service.executeInternalSell(mockUser, 0.1, "BTC", "swap-ref-1");

            expect(ledgerService.hold).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    currency: "BTC",
                    amount: 0.1,
                }),
            );
            expect(ledgerService.releaseHoldWithPlatformEntry).toHaveBeenCalledWith(
                expect.objectContaining({ settle: true }),
            );
        });

        it("should throw when hold fails", async () => {
            ledgerService.hold.mockResolvedValue({
                success: false,
                error: "Insufficient funds",
            });

            await expect(
                service.executeInternalSell(mockUser, 1, "BTC", "swap-ref-2"),
            ).rejects.toThrow("Insufficient");
        });
    });
});
