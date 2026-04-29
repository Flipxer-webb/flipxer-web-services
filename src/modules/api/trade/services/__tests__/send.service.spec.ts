import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { SendService } from "../send.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { Decimal } from "@prisma/client/runtime/library";
import { WsGateway } from "@/modules/api/trade/gateway/v1";
import { TradeHelpersService } from "../trade-helpers.service";
import { WalletAddressService } from "../wallet-address.service";
import { RateLimiterService } from "@/modules/core/rate-limit/services/rate-limiter.service";
import { LedgerService } from "../ledger/ledger.service";
import { WithdrawalQueueService } from "../ledger/withdrawal-queue.service";
import { SweepService } from "../ledger/sweep.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { RateService } from "../rate.service";
import { TransactionMonitorService } from "../ledger/transaction-monitor.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";

function makePrisma() {
    return {
        order: {
            create: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        cryptoWalletAddress: { findFirst: jest.fn() },
        assetWallet: { findFirst: jest.fn() },
        user: { findUnique: jest.fn() },
    };
}

function availableBalance(value: number) {
    return {
        available: {
            lessThan: jest.fn((input: any) => Number(input?.toString?.() ?? input) > value),
            toString: jest.fn(() => value.toString()),
        },
    };
}

describe("SendService", () => {
    let service: SendService;
    let prisma: ReturnType<typeof makePrisma>;
    let tradingProvider: { getWithdrawalFees: jest.Mock; getUserWallet: jest.Mock; createWithdrawal: jest.Mock; cancelWithdrawal: jest.Mock };
    let rateLimiter: { checkLimit: jest.Mock };
    let wsGateway: { notifyTransactionUpdate: jest.Mock; notifyWalletUpdate: jest.Mock; notifyWithdrawalQueued: jest.Mock };
    let ledgerService: {
        getBalance: jest.Mock;
        hold: jest.Mock;
        releaseHold: jest.Mock;
        runWithMultiUserLocks: jest.Mock;
        internalTransfer: jest.Mock;
    };
    let withdrawalQueueService: { addToQueue: jest.Mock };
    let sweepService: { hasPendingSweeps: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidax = {
            getWithdrawalFees: jest.fn(),
            getUserWallet: jest.fn(),
            createWithdrawal: jest.fn(),
            cancelWithdrawal: jest.fn(),
        };
        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
            notifyWithdrawalQueued: jest.fn(),
        };
        const mockTradeHelpers = { normalizeNetworkInput: jest.fn((n: string) => n) };
        const mockWalletAddress = { verifyWalletAddress: jest.fn().mockResolvedValue({ data: { valid: true } }) };
        const mockRateLimiter = { checkLimit: jest.fn().mockResolvedValue({ allowed: true }) };
        const mockLedger = {
            getBalance: jest.fn(),
            hold: jest.fn(),
            releaseHold: jest.fn(),
            runWithMultiUserLocks: jest.fn().mockImplementation(
                async (_userIds: number[], _currency: string, cb: () => any) => cb(),
            ),
            internalTransfer: jest.fn(),
        };
        const mockWithdrawalQueue = { addToQueue: jest.fn() };
        const mockSweep = { hasPendingSweeps: jest.fn().mockResolvedValue(false) };
        const mockSlack = { sendAlert: jest.fn().mockResolvedValue(undefined) };
        const mockRate = {
            getAssetRate: jest.fn().mockResolvedValue({ buyRate: 50000000, sellRate: 49000000 }),
        };
        const mockTransactionMonitor = {
            validateBeforeExecution: jest.fn().mockResolvedValue({ success: true, blocked: false }),
        };
        const mockNotification = { notify: jest.fn().mockResolvedValue(undefined) };
        const mockLock = {
            withLock: jest.fn().mockImplementation(async (_key: string, cb: () => any) => cb()),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                SendService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.TRADING_PROVIDER, useValue: mockQuidax },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: TradeHelpersService, useValue: mockTradeHelpers },
                { provide: WalletAddressService, useValue: mockWalletAddress },
                { provide: RateLimiterService, useValue: mockRateLimiter },
                { provide: LedgerService, useValue: mockLedger },
                { provide: WithdrawalQueueService, useValue: mockWithdrawalQueue },
                { provide: SweepService, useValue: mockSweep },
                { provide: SlackWebhookService, useValue: mockSlack },
                { provide: RateService, useValue: mockRate },
                { provide: TransactionMonitorService, useValue: mockTransactionMonitor },
                { provide: NotificationDispatcher, useValue: mockNotification },
                { provide: DistributedLockService, useValue: mockLock },
            ],
        }).compile();

        service = module.get(SendService);
        tradingProvider = module.get(TradingInjectionToken.TRADING_PROVIDER);
        rateLimiter = module.get(RateLimiterService);
        wsGateway = module.get(WsGateway);
        ledgerService = module.get(LedgerService);
        withdrawalQueueService = module.get(WithdrawalQueueService);
        sweepService = module.get(SweepService);
        notificationDispatcher = module.get(NotificationDispatcher);
    });

    afterEach(() => jest.clearAllMocks());

    // ── getCryptoWithdrawerFee ────────────────────────────────

    describe("getCryptoWithdrawerFee", () => {
        it("should return fee info with flat fee", async () => {
            tradingProvider.getWithdrawalFees.mockResolvedValue({
                data: { type: "flat", fee: 0.001 },
            });

            const result = await service.getCryptoWithdrawerFee({
                amount: 1,
                currency: "btc" as any,
            } as any);

            expect(result.data.networkFee).toBe(0.001);
            expect(result.data.adminFee).toBe(0);
            expect(result.data.totalFee).toBe(0.001);
        });

        it("should return fee info with percentage fee", async () => {
            tradingProvider.getWithdrawalFees.mockResolvedValue({
                data: { type: "percentage", fee: 1.5 }, // 1.5%
            });

            const result = await service.getCryptoWithdrawerFee({
                amount: 100,
                currency: "usdt" as any,
            } as any);

            expect(result.data.networkFee).toBe(1.5); // 100 * 1.5 / 100
            expect(result.data.totalFee).toBe(1.5);
        });

        it("should handle range-based fee", async () => {
            tradingProvider.getWithdrawalFees.mockResolvedValue({
                data: {
                    type: "range",
                    fee: [
                        { min: 0, max: 100, type: "flat", value: 5 },
                        { min: 100, max: 1000, type: "percentage", value: 2 },
                    ],
                },
            });

            const result = await service.getCryptoWithdrawerFee({
                amount: 500,
                currency: "usdt" as any,
            } as any);

            expect(result.data.networkFee).toBe(10); // 500 * 2 / 100
        });

        it("throws when provider returns null data", async () => {
            tradingProvider.getWithdrawalFees.mockResolvedValue({ data: null });

            await expect(
                service.getCryptoWithdrawerFee({
                    amount: 1,
                    currency: "btc" as any,
                } as any),
            ).rejects.toThrow("Fee information is not available");
        });

        it("falls back to fixed fee for simple numeric fee without type", async () => {
            tradingProvider.getWithdrawalFees.mockResolvedValue({
                data: { fee: 0.005 },
            });

            const result = await service.getCryptoWithdrawerFee({
                amount: 1,
                currency: "btc" as any,
            } as any);

            expect(result.data.networkFee).toBe(0.005);
        });
    });

    // ── inferAddressFamily (via reflection) ──────────────────

    describe("address family detection", () => {
        // Access private method via bracket notation
        it("should detect EVM addresses", () => {
            expect((service as any).inferAddressFamily("0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16")).toBe("evm");
        });

        it("should detect TRC20 addresses", () => {
            expect((service as any).inferAddressFamily("TYaLG5i4fhGAZDr7EsJFZEsxTCvNbfqLNi")).toBe("trc20");
        });

        it("should detect BTC addresses", () => {
            expect((service as any).inferAddressFamily("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe("btc");
        });

        it("should detect DOGE addresses", () => {
            expect((service as any).inferAddressFamily("DRapidDiBYggT1zdrELnVhNDqyAHn89cRi")).toBe("doge");
        });

        it("should return unknown for unrecognized addresses", () => {
            expect((service as any).inferAddressFamily("invalid-address")).toBe("unknown");
        });
    });

    // ── assertNotOwnDepositAddress ──────────────────────────

    describe("assertNotOwnDepositAddress", () => {
        it("should block sending to own deposit address", async () => {
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue({
                address: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16",
                network: "erc20",
            });

            await expect(
                (service as any).assertNotOwnDepositAddress(
                    1, "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16", "ETH",
                ),
            ).rejects.toThrow("Cannot withdraw to your own deposit address");
        });

        it("should allow sending to other addresses", async () => {
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue(null);
            prisma.assetWallet.findFirst.mockResolvedValue(null);

            await expect(
                (service as any).assertNotOwnDepositAddress(
                    1, "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16", "ETH",
                ),
            ).resolves.toBeUndefined();
        });

        it("should check AssetWallet fallback", async () => {
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue(null);
            prisma.assetWallet.findFirst.mockResolvedValue({
                depositAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16",
                assetCurrency: "ETH",
            });

            await expect(
                (service as any).assertNotOwnDepositAddress(
                    1, "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16", "ETH",
                ),
            ).rejects.toThrow("Cannot withdraw to your own deposit address");
        });
    });

    // ── checkWithdrawalRateLimits ────────────────────────────

    describe("checkWithdrawalRateLimits (private)", () => {
        it("should allow when under rate limit and no pending", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: true });
            prisma.order.findFirst.mockResolvedValue(null);

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");

            expect(result.allowed).toBe(true);
        });

        it("should block when rate limit exceeded", async () => {
            rateLimiter.checkLimit.mockResolvedValue({
                allowed: false,
                retryAfter: 300,
            });

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("Rate limit exceeded");
        });

        it("should block when pending withdrawal exists for same currency", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: true });
            prisma.order.findFirst.mockResolvedValue({
                id: 1,
                orderReference: "ref-1",
                amount: 0.5,
                status: "submitted",
                createdAt: new Date(), // recent — not stuck
            });

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");

            expect(result.allowed).toBe(false);
            expect(result.reason).toContain("pending");
        });

        it("should auto-fail stale pending withdrawal and allow new request", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: true });
            prisma.order.findFirst.mockResolvedValue({
                id: 1,
                orderReference: "ref-1",
                amount: 0.5,
                status: "pending",
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            });
            prisma.order.update.mockResolvedValue({ id: 1 });
            ledgerService.releaseHold.mockResolvedValue({ success: true });

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");

            expect(result.allowed).toBe(true);
            expect(prisma.order.update).toHaveBeenCalled();
            expect(ledgerService.releaseHold).toHaveBeenCalledWith(
                "withdrawal:ref-1",
                false,
                "Stuck order auto-failed",
            );
        });
    });

    // ── isNetworkCompatibleWithAddress ────────────────────────

    describe("isNetworkCompatibleWithAddress", () => {
        it("should allow EVM address with ERC-20 network", () => {
            expect(
                (service as any).isNetworkCompatibleWithAddress("erc20", "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16"),
            ).toBe(true);
        });

        it("should reject TRC-20 address with ERC-20 network", () => {
            expect(
                (service as any).isNetworkCompatibleWithAddress("erc20", "TYaLG5i4fhGAZDr7EsJFZEsxTCvNbfqLNi"),
            ).toBe(false);
        });

        it("should allow when no network specified", () => {
            expect(
                (service as any).isNetworkCompatibleWithAddress(undefined, "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16"),
            ).toBe(true);
        });
    });

    describe("withdrawerRequest", () => {
        const user = { id: 42, email: "user@example.com" } as any;
        const dto = {
            currency: "eth",
            amount: 1,
            recipientWalletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16",
            network: "erc20",
            narration: "test withdrawal",
            transaction_note: "note",
        } as any;

        beforeEach(() => {
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue(null);
            prisma.assetWallet.findFirst.mockResolvedValue(null);
            prisma.order.findFirst.mockResolvedValue(null);
            tradingProvider.getWithdrawalFees.mockResolvedValue({
                data: { type: "flat", fee: 0.001 },
            });
            ledgerService.getBalance.mockResolvedValue(availableBalance(10));
            ledgerService.hold.mockResolvedValue({ success: true, entryId: "hold-1" });
            sweepService.hasPendingSweeps.mockResolvedValue(false);
            prisma.order.create.mockResolvedValue({
                id: 99,
                transactionId: "txn-99",
                status: "processing",
                streamlinedStatus: "pending",
                orderCategory: "SEND",
                amount: new Decimal(1),
                currency: "ETH",
                fee: new Decimal(0.001),
                total: new Decimal(1.001),
                recipient: dto.recipientWalletAddress,
                createdAt: new Date("2026-03-29T12:00:00Z"),
                updatedAt: new Date("2026-03-29T12:00:00Z"),
                orderReference: "ref-99",
                narration: "test withdrawal",
                transaction_note: "note",
            });
        });

        it("executes withdrawal immediately when liquidity is available", async () => {
            tradingProvider.getUserWallet.mockResolvedValue({
                data: { currency: "eth", balance: "100" },
            });
            tradingProvider.createWithdrawal.mockResolvedValue({
                data: { id: "provider-1", fee: "0.001", total: "1.001" },
            });

            const result = await service.withdrawerRequest(user, dto);

            expect(result.message).toContain("placed successfully");
            expect(tradingProvider.createWithdrawal).toHaveBeenCalled();
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { id: 99 },
                }),
            );
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(user.id);
            expect(notificationDispatcher.notify).toHaveBeenCalled();
        });

        it("queues withdrawal when liquidity is low", async () => {
            tradingProvider.getUserWallet.mockResolvedValue({
                data: { currency: "eth", balance: "0.1" },
            });
            prisma.order.create.mockResolvedValue({
                id: 100,
                transactionId: "txn-100",
                status: "pending",
                streamlinedStatus: "pending",
                orderCategory: "SEND",
                amount: new Decimal(1),
                currency: "ETH",
                fee: new Decimal(0.001),
                total: new Decimal(1.001),
                recipient: dto.recipientWalletAddress,
                createdAt: new Date("2026-03-29T12:00:00Z"),
                updatedAt: new Date("2026-03-29T12:00:00Z"),
                orderReference: "ref-100",
            });
            withdrawalQueueService.addToQueue.mockResolvedValue({
                success: true,
                queueEntry: { id: "q-1", position: 1 },
            });

            const result = await service.withdrawerRequest(user, dto);

            expect(result.data.status).toBe("queued");
            expect(withdrawalQueueService.addToQueue).toHaveBeenCalled();
            expect(wsGateway.notifyWithdrawalQueued).toHaveBeenCalledWith(
                user.id,
                expect.objectContaining({ queueId: "q-1" }),
            );
        });

        it("releases hold and throws when queue add fails", async () => {
            tradingProvider.getUserWallet.mockResolvedValue({
                data: { currency: "eth", balance: "0.1" },
            });
            withdrawalQueueService.addToQueue.mockResolvedValue({ success: false });

            await expect(service.withdrawerRequest(user, dto)).rejects.toThrow(
                "Failed to process withdrawal",
            );
            expect(ledgerService.releaseHold).toHaveBeenCalledWith(
                expect.stringContaining("withdrawal:"),
                false,
                "Failed to queue withdrawal",
            );
        });

        it("throws when recipient address is missing", async () => {
            await expect(
                service.withdrawerRequest(user, {
                    ...dto,
                    recipientWalletAddress: "",
                }),
            ).rejects.toThrow("Recipient wallet address is required");
        });

        it("throws when rate limiter blocks withdrawal", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: false, retryAfter: 20 });

            await expect(service.withdrawerRequest(user, dto)).rejects.toThrow(
                "Rate Limit Exceeded",
            );
        });
    });

    describe("cancelWithdrawerRequest", () => {
        it("cancels via main wallet when crypto sub-account is missing", async () => {
            tradingProvider.cancelWithdrawal.mockResolvedValue({
                data: { id: "wd-1", status: "cancelled" },
            });

            const result = await service.cancelWithdrawerRequest(
                { id: 1, cryptoSubAccountId: null } as any,
                { withdrawal_id: "wd-1" } as any,
            );

            expect(result.data.id).toBe("wd-1");
            expect(tradingProvider.cancelWithdrawal).toHaveBeenCalledWith({
                userId: "me",
                withdrawalId: "wd-1",
            });
        });

        it("delegates cancel to provider", async () => {
            tradingProvider.cancelWithdrawal.mockResolvedValue({
                data: { id: "wd-1", status: "cancelled" },
            });

            const result = await service.cancelWithdrawerRequest(
                { id: 1, cryptoSubAccountId: "sub-1" } as any,
                { withdrawal_id: "wd-1" } as any,
            );

            expect(result.data.id).toBe("wd-1");
            expect(tradingProvider.cancelWithdrawal).toHaveBeenCalledWith({
                userId: "me",
                withdrawalId: "wd-1",
            });
        });

        it("falls back to sub-account when main wallet cancel fails", async () => {
            tradingProvider.cancelWithdrawal
                .mockRejectedValueOnce(new Error("Not found on main"))
                .mockResolvedValueOnce({ data: { id: "wd-1", status: "cancelled" } });

            const result = await service.cancelWithdrawerRequest(
                { id: 1, cryptoSubAccountId: "sub-1" } as any,
                { withdrawal_id: "wd-1" } as any,
            );

            expect(result.data.status).toBe("cancelled");
            expect(tradingProvider.cancelWithdrawal).toHaveBeenCalledTimes(2);
            expect(tradingProvider.cancelWithdrawal).toHaveBeenLastCalledWith({
                userId: "sub-1",
                withdrawalId: "wd-1",
            });
        });

        it("throws original Error when all cancel attempts fail", async () => {
            tradingProvider.cancelWithdrawal
                .mockRejectedValueOnce(new Error("fail-me"))
                .mockRejectedValueOnce(new Error("fail-sub"));

            await expect(
                service.cancelWithdrawerRequest(
                    { id: 1, cryptoSubAccountId: "sub-1" } as any,
                    { withdrawal_id: "wd-1" } as any,
                ),
            ).rejects.toThrow("fail-sub");
        });

        it("throws GeneralTransactionException for non-Error failures", async () => {
            tradingProvider.cancelWithdrawal.mockRejectedValue("string error");

            await expect(
                service.cancelWithdrawerRequest(
                    { id: 1, cryptoSubAccountId: null } as any,
                    { withdrawal_id: "wd-1" } as any,
                ),
            ).rejects.toThrow("Unable to cancel withdrawal request");
        });
    });

    describe("internal transfers", () => {
        const sender = { id: 9, email: "sender@example.com" } as any;
        const baseDto = {
            isInternal: true,
            currency: "usdt",
            amount: 50,
            recipientEmail: "recipient@example.com",
            narration: "internal",
            transaction_note: "note",
        } as any;

        beforeEach(() => {
            prisma.user.findUnique.mockResolvedValue({
                id: 20,
                email: "recipient@example.com",
                firstName: "Rec",
                lastName: "User",
            });
            prisma.order.findFirst.mockResolvedValue(null);
            ledgerService.getBalance.mockResolvedValue(availableBalance(100));
            ledgerService.internalTransfer.mockResolvedValue({
                success: true,
                entryId: "debit-1",
                creditEntryId: "credit-1",
            });
            prisma.order.create.mockResolvedValue({ id: 1 });
        });

        it("processes internal transfer successfully", async () => {
            const result = await service.withdrawerRequest(sender, baseDto);

            expect(result.data.status).toBe("completed");
            expect(ledgerService.runWithMultiUserLocks).toHaveBeenCalledWith(
                [sender.id, 20],
                "USDT",
                expect.any(Function),
            );
            expect(ledgerService.internalTransfer).toHaveBeenCalled();
            expect(prisma.order.create).toHaveBeenCalledTimes(2);
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(sender.id);
            expect(wsGateway.notifyWalletUpdate).toHaveBeenCalledWith(20);
        });

        it("records failed internal transfer attempts", async () => {
            ledgerService.runWithMultiUserLocks.mockRejectedValue(new Error("lock-failed"));

            await expect(service.withdrawerRequest(sender, baseDto)).rejects.toThrow("lock-failed");
            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        status: "failed",
                        orderCategory: "SEND",
                    }),
                }),
            );
        });

        it("requires recipient email for internal transfers", async () => {
            await expect(
                service.withdrawerRequest(sender, {
                    ...baseDto,
                    recipientEmail: undefined,
                }),
            ).rejects.toThrow("Recipient email is required");
        });
    });

    // ── resolveNetwork (private) ────────────────────────────

    describe("resolveNetwork", () => {
        it("returns explicit network when provided", () => {
            const result = (service as any).resolveNetwork(1, "erc20", "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16");
            expect(result).toBe("erc20");
        });

        it("auto-detects erc20 from EVM address", () => {
            const result = (service as any).resolveNetwork(1, undefined, "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16");
            expect(result).toBe("erc20");
        });

        it("auto-detects trc20 from TRC20 address", () => {
            const result = (service as any).resolveNetwork(1, undefined, "TYaLG5i4fhGAZDr7EsJFZEsxTCvNbfqLNi");
            expect(result).toBe("trc20");
        });

        it("auto-detects btc from Bitcoin address", () => {
            const result = (service as any).resolveNetwork(1, undefined, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
            expect(result).toBe("btc");
        });

        it("returns undefined for unrecognizable addresses", () => {
            const result = (service as any).resolveNetwork(1, undefined, "unknown-addr-format");
            expect(result).toBeUndefined();
        });
    });

    // ── validateDestinationTagRequirements (private) ─────────

    describe("validateDestinationTagRequirements", () => {
        it("passes when currency does not require tag", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("ETH", undefined, undefined, undefined),
            ).not.toThrow();
        });

        it("passes when valid numeric tag provided for XRP", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("XRP", "ripple", "12345", undefined),
            ).not.toThrow();
        });

        it("throws when non-numeric tag provided for XRP", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("XRP", "ripple", "abc", undefined),
            ).toThrow("Destination tag must be numeric");
        });

        it("throws when tag is missing and not confirmed", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("XRP", "ripple", undefined, false),
            ).toThrow("Destination tag/memo is required");
        });

        it("allows tag omission when explicitly confirmed", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("XRP", "ripple", undefined, true),
            ).not.toThrow();
        });

        it("allows tag omission when confirmed with empty string", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("XRP", "ripple", "  ", true),
            ).not.toThrow();
        });

        it("uses network-based check for stellar", () => {
            expect(() =>
                (service as any).validateDestinationTagRequirements("USDC", "stellar", undefined, false),
            ).toThrow("Destination tag/memo is required");
        });
    });

    // ── withdrawerRequest — execution failure → queue ────────

    describe("withdrawerRequest — execution failure fallback", () => {
        const user = { id: 42, email: "user@example.com" } as any;
        const dto = {
            currency: "eth",
            amount: 1,
            recipientWalletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bC16",
            network: "erc20",
            narration: "test",
            transaction_note: "note",
        } as any;

        beforeEach(() => {
            prisma.cryptoWalletAddress.findFirst.mockResolvedValue(null);
            prisma.assetWallet.findFirst.mockResolvedValue(null);
            prisma.order.findFirst.mockResolvedValue(null);
            tradingProvider.getWithdrawalFees.mockResolvedValue({ data: { type: "flat", fee: 0.001 } });
            ledgerService.getBalance.mockResolvedValue(availableBalance(10));
            ledgerService.hold.mockResolvedValue({ success: true, entryId: "hold-1" });
            sweepService.hasPendingSweeps.mockResolvedValue(false);
            prisma.order.create.mockResolvedValue({
                id: 100, transactionId: "txn-100", status: "processing",
                streamlinedStatus: "pending", orderCategory: "SEND",
                amount: new Decimal(1),
                currency: "ETH",
                fee: new Decimal(0.001),
                total: new Decimal(1.001),
                recipient: dto.recipientWalletAddress,
                createdAt: new Date(), updatedAt: new Date(),
                orderReference: "ref-100", narration: "test", transaction_note: "note",
            });
            // Liquidity available but execution fails
            tradingProvider.getUserWallet.mockResolvedValue({
                data: { currency: "eth", balance: "100" },
            });
        });

        it("queues withdrawal when provider execution throws", async () => {
            tradingProvider.createWithdrawal.mockRejectedValue(new Error("Provider timeout"));
            withdrawalQueueService.addToQueue.mockResolvedValue({
                success: true,
                queueEntry: { id: "q-exec-fail", position: 1 },
            });

            const result = await service.withdrawerRequest(user, dto);

            expect(result.data.status).toBe("queued");
            expect(withdrawalQueueService.addToQueue).toHaveBeenCalled();
            expect(prisma.order.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: "pending" }),
                }),
            );
        });
    });

    // ── checkWithdrawalRateLimits — hold release edge cases ──

    describe("checkWithdrawalRateLimits — hold release edge cases", () => {
        it("allows new request when release for stuck order has no hold entry", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: true });
            prisma.order.findFirst.mockResolvedValue({
                id: 2, orderReference: "ref-2", amount: 0.5, status: "pending",
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            });
            prisma.order.update.mockResolvedValue({ id: 2 });
            ledgerService.releaseHold.mockResolvedValue({ success: false, error: "No hold entry found" });

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");
            expect(result.allowed).toBe(true);
        });

        it("allows new request when releaseHold throws", async () => {
            rateLimiter.checkLimit.mockResolvedValue({ allowed: true });
            prisma.order.findFirst.mockResolvedValue({
                id: 3, orderReference: "ref-3", amount: 0.5, status: "pending",
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
            });
            prisma.order.update.mockResolvedValue({ id: 3 });
            ledgerService.releaseHold.mockRejectedValue(new Error("Redis down"));

            const result = await (service as any).checkWithdrawalRateLimits(1, "BTC");
            expect(result.allowed).toBe(true);
        });
    });
});

