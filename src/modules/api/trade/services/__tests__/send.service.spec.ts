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

describe("SendService", () => {
    let service: SendService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidaxService: { getWithdrawerFees: jest.Mock; getUserWalletList: jest.Mock; createWithdrawerRequest: jest.Mock; cancelWithdrawerRequest: jest.Mock };
    let rateLimiter: { checkLimit: jest.Mock };

    beforeEach(async () => {
        prisma = makePrisma();
        const mockQuidax = {
            getWithdrawerFees: jest.fn(),
            getUserWalletList: jest.fn(),
            createWithdrawerRequest: jest.fn(),
            cancelWithdrawerRequest: jest.fn(),
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
                { provide: TradingInjectionToken.QUIDAX, useValue: mockQuidax },
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
        quidaxService = module.get(TradingInjectionToken.QUIDAX);
        rateLimiter = module.get(RateLimiterService);
    });

    afterEach(() => jest.clearAllMocks());

    // ── getCryptoWithdrawerFee ────────────────────────────────

    describe("getCryptoWithdrawerFee", () => {
        it("should return fee info with flat fee", async () => {
            quidaxService.getWithdrawerFees.mockResolvedValue({
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
            quidaxService.getWithdrawerFees.mockResolvedValue({
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
            quidaxService.getWithdrawerFees.mockResolvedValue({
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
});
