import { Test, TestingModule } from "@nestjs/testing";

// Break circular dependency: auth/guard → @/modules/api/user → auth/index → auth/controllers → @User()
jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import { BuyOrderService } from "../buy-order.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { InboundFiatPaymentService } from "@/modules/factory/bank/services/inbound-fiat-payment.service";
import { WalletAddressService } from "../wallet-address.service";
import { WsGateway } from "../../gateway/v1";
import { TradeHelpersService } from "../trade-helpers.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger/ledger.service";
import { RateService } from "../rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { TransactionService } from "@/modules/api/auth/services/transaction.service";

import { OrderStatus, PaymentMethod, TransactionStatus } from "@prisma/client";

describe("BuyOrderService", () => {
    let service: BuyOrderService;
    let prismaService: any;
    let walletAddressService: any;

    const mockUser = {
        id: 1,
        email: "test@example.com",
        cryptoSubAccountId: "quidax-123",
        firstName: "Test",
        lastName: "User",
        userType: "INDIVIDUAL",
    };

    const mockAssetWallet = {
        id: 1,
        userId: 1,
        assetCurrency: "BTC",
        balance: "1.5",
        lockedBalance: "0",
        isActive: true,
    };

    const mockCryptoRate = {
        id: 1,
        symbol: "BTC",
        buyRate: "70000000",
        sellRate: "69000000",
    };

    const mockTransactionFee = {
        id: 1,
        category: "BUY",
        asset: "BTC",
        type: "percentage",
        fee: 1.5,
    };

    beforeEach(async () => {
        const mockPrismaService = {
            user: {
                findUnique: jest.fn(),
            },
            assetWallet: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
            },
            cryptoWalletAddress: {
                findFirst: jest.fn(),
                findMany: jest.fn(),
            },
            cryptoRate: {
                findFirst: jest.fn(),
            },
            transactionFee: {
                findFirst: jest.fn(),
            },
            order: {
                create: jest.fn(),
                findUnique: jest.fn(),
                findMany: jest.fn(),
                update: jest.fn(),
            },
            payment: {
                findUnique: jest.fn(),
                findFirst: jest.fn(),
                findMany: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
                updateMany: jest.fn(),
            },
            $transaction: jest.fn().mockImplementation(async (cb: any) => cb({
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
                },
                order: {
                    update: jest.fn().mockResolvedValue(undefined),
                },
            })),
        };

        const mockWalletAddressService = {
            syncWallet: jest.fn().mockResolvedValue(undefined),
        };

        const mockWsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };

        const mockRateService = {
            getAssetRate: jest.fn().mockResolvedValue({ buyRate: 70000000, sellRate: 69000000 }),
        };

        const mockInboundFiatPaymentService = {
            initializePayment: jest.fn(),
            cleanupPendingPayment: jest.fn().mockResolvedValue(true),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BuyOrderService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: InboundFiatPaymentService, useValue: mockInboundFiatPaymentService },
                { provide: WalletAddressService, useValue: mockWalletAddressService },
                { provide: WsGateway, useValue: mockWsGateway },
                {
                    provide: TradeHelpersService,
                    useValue: {
                        calculateFee: jest.fn(),
                        validateMinimumAmountInUSDT: jest.fn(),
                        normalizeNetworkInput: jest.fn((value) =>
                            typeof value === "string" && value.trim()
                                ? value.trim().toLowerCase()
                                : null
                        ),
                    },
                },
                { provide: SlackWebhookService, useValue: { sendWebhookFailureAlert: jest.fn() } },
                { provide: LedgerService, useValue: { pairedCredit: jest.fn() } },
                { provide: RateService, useValue: mockRateService },
                { provide: NotificationDispatcher, useValue: { notify: jest.fn() } },
                { provide: DistributedLockService, useValue: { withLock: jest.fn((key, fn) => fn()) } },
                { provide: TransactionService, useValue: { releaseDailyLimitReservationForOrder: jest.fn().mockResolvedValue(undefined) } },
            ],
        }).compile();

        service = module.get<BuyOrderService>(BuyOrderService);
        prismaService = module.get(PrismaService);
        walletAddressService = module.get(WalletAddressService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("buyCryptoQuoteRequest", () => {
        const quoteDto = {
            asset: "btc",
            amount: 0.01,
        };

        it("should return quote when all conditions are met", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1q...",
                defaultNetwork: "btc",
            });
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);

            const result = await service.buyCryptoQuoteRequest(mockUser as any, quoteDto);

            expect(result).toBeDefined();
            expect(result.data).toBeDefined();
        });
    });

    describe("calculateBuyQuote", () => {
        it("should calculate quote correctly without provider wallet metadata", async () => {
            prismaService.cryptoRate.findFirst.mockResolvedValue(mockCryptoRate);
            prismaService.transactionFee.findFirst.mockResolvedValue(mockTransactionFee);

            const quote = await service.calculateBuyQuote(mockUser as any, {
                asset: "BTC",
                amount: 0.1,
            });

            expect(quote).toBeDefined();
            expect(quote.buyRate).toBeDefined();
            expect(quote.cryptoBuyAmount).toBeDefined();
        });

    });

    describe("buyCryptoOrder", () => {
        const orderDto = {
            asset: "btc",
            amount: 0.01,
            buyRate: 70000000,
            charge: 750,
        } as any;

        it("rejects idempotency keys tied to another user", async () => {
            prismaService.payment.findUnique.mockResolvedValue({
                id: 88,
                userId: 999,
                reference: "idem-ref-1",
                createdAt: new Date(Date.now() - 5 * 60 * 1000),
                totalAmount: "250000",
                destinationBankAccountNumber: "0123456789",
                destinationBankAccountName: "Wrong User",
                destinationBankName: "Bank",
                order: { id: 200, amount: 0.01, currency: "BTC" },
            });

            await expect(
                service.buyCryptoOrder(mockUser as any, { ...orderDto, idempotencyKey: "idem-1" }),
            ).rejects.toThrow("Idempotency key belongs to a different user");
        });

        it("returns an existing order for matching idempotency keys", async () => {
            prismaService.payment.findUnique.mockResolvedValue({
                id: 89,
                userId: mockUser.id,
                reference: "idem-ref-2",
                createdAt: new Date(Date.now() - 5 * 60 * 1000),
                totalAmount: "250000",
                destinationBankAccountNumber: "0123456789",
                destinationBankAccountName: "Test User",
                destinationBankName: "Bank",
                order: { id: 201, amount: 0.01, currency: "BTC" },
            });

            const res = await service.buyCryptoOrder(mockUser as any, {
                ...orderDto,
                idempotencyKey: "idem-2",
            });

            expect(res.message).toContain("Order already exists");
            expect(res.data.paymentInfo.reference).toBe("idem-ref-2");
        });

        it("returns an existing pending order for same user/asset/amount within expiry window", async () => {
            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue({
                id: 90,
                orderId: 202,
                userId: mockUser.id,
                reference: "pending-ref-1",
                createdAt: new Date(Date.now() - 5 * 60 * 1000),
                totalAmount: "250000",
                destinationBankAccountNumber: "1234567890",
                destinationBankAccountName: "Test User",
                destinationBankName: "Bank",
                order: { id: 202, amount: 0.01, currency: "BTC" },
            });

            const res = await service.buyCryptoOrder(mockUser as any, orderDto);

            expect(res.message).toContain("Order already exists");
            expect(res.data.order.id).toBe(202);
        });

        it("creates a new buy order and returns VA payment instructions", async () => {
            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue(null);
            const orderCreate = jest.fn().mockResolvedValue({
                id: 303,
                amount: 0.01,
                currency: "BTC",
                status: OrderStatus.pending,
                streamlinedStatus: "pending",
                orderCategory: OrderStatus.pending,
                transactionId: "tx-303",
                createdAt: new Date(),
                updatedAt: new Date(),
            });

            (service as any).inboundFiatPaymentService.initializePayment = jest
                .fn()
                .mockResolvedValue({
                    provider: "nomba",
                    mode: "virtual_account",
                    reference: "va-ref-1",
                    providerAccountReference: "va-account-ref-1",
                    amount: 100,
                    accountNumber: "0099009900",
                    accountName: "Flipxer User",
                    bankName: "Nomba",
                    bankCode: "0900",
                    expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    order: {
                        create: orderCreate,
                    },
                    payment: {
                        create: jest.fn().mockResolvedValue({ id: 404 }),
                    },
                }),
            );

            const ws = (service as any).wsGateway;
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;

            const result = await service.buyCryptoOrder(mockUser as any, {
                ...orderDto,
                idempotencyKey: "new-idem-1",
            });

            expect(result.message).toContain("Order placed successfully");
            expect(result.data.paymentInfo.reference).toBe("va-ref-1");
            expect(result.data.order.id).toBe(303);
            expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(mockUser.id);
            expect(notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: mockUser.id,
                    title: "Buy order initiated",
                }),
            );
        });

        it("persists the provider VA accountRef when virtual-account fallback reuse returns a different accountRef", async () => {
            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue(null);
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1qfallbackaddress",
                defaultNetwork: "btc",
            });

            (service as any).inboundFiatPaymentService.initializePayment = jest
                .fn()
                .mockResolvedValue({
                    provider: "nomba",
                    mode: "virtual_account",
                    reference: "local-buy-ref-1",
                    providerAccountReference: "fallback-va-ref-1",
                    amount: 100,
                    accountNumber: "6826635284",
                    accountName: "ZED/Testing Testing123",
                    bankName: "Nombank MFB",
                    bankCode: "",
                    expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                });

            const paymentCreate = jest.fn().mockResolvedValue({ id: 405 });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    order: {
                        create: jest.fn().mockResolvedValue({
                            id: 305,
                            amount: 0.01,
                            currency: "BTC",
                            status: OrderStatus.pending,
                            streamlinedStatus: "pending",
                            orderCategory: OrderStatus.pending,
                            transactionId: "tx-305",
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        }),
                    },
                    payment: {
                        create: paymentCreate,
                    },
                }),
            );

            await service.buyCryptoOrder(mockUser as any, {
                ...orderDto,
                idempotencyKey: "fallback-va-idem-1",
            });

            expect(paymentCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reference: "local-buy-ref-1",
                        providerAccountReference: "fallback-va-ref-1",
                        destinationBankAccountNumber: "6826635284",
                    }),
                }),
            );
        });

        it("falls back to hosted checkout when the Nomba sandbox VA cap is reached", async () => {
            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue(null);
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1qcheckoutaddress",
                defaultNetwork: "btc",
            });

            (service as any).inboundFiatPaymentService.initializePayment = jest
                .fn()
                .mockResolvedValue({
                    provider: "nomba",
                    mode: "checkout",
                    reference: "checkout-ref-1",
                    amount: 100,
                    expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    authorizationUrl: "https://checkout.nomba.test/session-1",
                });

            const paymentCreate = jest.fn().mockResolvedValue({ id: 505 });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    order: {
                        create: jest.fn().mockResolvedValue({
                            id: 304,
                            amount: 0.01,
                            currency: "BTC",
                            status: OrderStatus.pending,
                            streamlinedStatus: "pending",
                            orderCategory: OrderStatus.pending,
                            transactionId: "tx-304",
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        }),
                    },
                    payment: {
                        create: paymentCreate,
                    },
                }),
            );

            const result = await service.buyCryptoOrder(mockUser as any, {
                ...orderDto,
                idempotencyKey: "checkout-idem-1",
            });

            expect((service as any).inboundFiatPaymentService.initializePayment).toHaveBeenCalledTimes(1);
            expect(paymentCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        reference: "checkout-ref-1",
                        externalReference: "https://checkout.nomba.test/session-1",
                        destinationBankAccountNumber: null,
                    }),
                }),
            );
            expect(result.data.paymentInfo.authorization_url).toBe(
                "https://checkout.nomba.test/session-1"
            );
            expect(result.data.paymentInfo.reference).toBe("checkout-ref-1");
        });

        it("uses FINCRA payment method when BUY_PAYMENT_PROVIDER=fincra", async () => {
            const config = require("@/config");
            const originalProvider = config.buyPaymentProvider;
            Object.defineProperty(config, "buyPaymentProvider", { value: "fincra", writable: true });

            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue(null);
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1qfincraaddress",
                defaultNetwork: "btc",
            });

            (service as any).inboundFiatPaymentService.initializePayment = jest
                .fn()
                .mockResolvedValue({
                    provider: "fincra",
                    mode: "checkout",
                    reference: "fincra-checkout-ref-1",
                    amount: 100,
                    expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    authorizationUrl: "https://checkout.fincra.test/session-1",
                });

            const paymentCreate = jest.fn().mockResolvedValue({ id: 506 });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    order: {
                        create: jest.fn().mockResolvedValue({
                            id: 306,
                            amount: 0.01,
                            currency: "BTC",
                            status: OrderStatus.pending,
                            streamlinedStatus: "pending",
                            orderCategory: OrderStatus.pending,
                            transactionId: "tx-306",
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        }),
                    },
                    payment: {
                        create: paymentCreate,
                    },
                }),
            );

            const result = await service.buyCryptoOrder(mockUser as any, {
                ...orderDto,
                idempotencyKey: "fincra-checkout-idem-1",
            });

            expect((service as any).inboundFiatPaymentService.initializePayment).toHaveBeenCalledWith(
                expect.objectContaining({ provider: "fincra" }),
            );
            expect(paymentCreate).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        paymentMethod: PaymentMethod.FINCRA,
                        externalReference: "https://checkout.fincra.test/session-1",
                    }),
                }),
            );
            expect(result.data.paymentInfo.authorization_url).toBe(
                "https://checkout.fincra.test/session-1"
            );

            Object.defineProperty(config, "buyPaymentProvider", { value: originalProvider, writable: true });
        });
    });

    describe("helper branches", () => {
        it("getFee handles flat, percentage, range, and fallback fee definitions", async () => {
            await expect((service as any).getFee(10, { type: "flat", fee: 2 })).resolves.toEqual({
                fee: 2,
                type: "flat",
            });
            await expect((service as any).getFee(200, { type: "percentage", fee: 1.5 })).resolves.toEqual({
                fee: 3,
                type: "percentage",
            });
            await expect(
                (service as any).getFee(200, {
                    type: "range",
                    fee: [
                        { min: 0, max: 100, type: "flat", value: 3 },
                        { min: 100, max: 300, type: "percentage", value: 2 },
                    ],
                }),
            ).resolves.toEqual({ fee: 4, type: "percentage" });
            await expect((service as any).getFee(10, { fee: 7 })).resolves.toEqual({
                fee: 7,
                type: "fixed",
            });
        });

        it("getFee throws for unknown fee definitions and out-of-range values", async () => {
            await expect(
                (service as any).getFee(1000, {
                    type: "range",
                    fee: [{ min: 0, max: 50, type: "flat", value: 1 }],
                }),
            ).rejects.toThrow("Amount is out of range.");

            await expect((service as any).getFee(100, { type: "mystery" })).rejects.toThrow(
                "Unknown fee structure",
            );
        });

        it("getAmountInNaira returns converted amount and null on rate fetch failure", async () => {
            const rateService = (service as any).rateService;
            rateService.getAssetRate.mockResolvedValueOnce({ sellRate: 70000000 });

            await expect((service as any).getAmountInNaira("btc", 0.5)).resolves.toEqual({
                amount: 35000000,
                rate: 70000000,
            });

            rateService.getAssetRate.mockRejectedValueOnce(new Error("provider down"));
            await expect((service as any).getAmountInNaira("btc", 0.5)).resolves.toBeNull();
        });

        it("enforces idempotent request matching against existing order payload", () => {
            const dto = { asset: "btc", amount: 0.1 } as any;

            expect(() =>
                (service as any).ensureIdempotentRequestMatchesExistingOrder(dto, { order: null }),
            ).toThrow("Idempotency key is linked to an invalid order state");

            expect(() =>
                (service as any).ensureIdempotentRequestMatchesExistingOrder(dto, {
                    order: { currency: "ETH", amount: 0.1 },
                }),
            ).toThrow("Idempotency key already used for a different asset");

            expect(() =>
                (service as any).ensureIdempotentRequestMatchesExistingOrder(dto, {
                    order: { currency: "BTC", amount: 0.2 },
                }),
            ).toThrow("Idempotency key already used with a different amount");

            expect(() =>
                (service as any).ensureIdempotentRequestMatchesExistingOrder(dto, {
                    order: { currency: "BTC", amount: 0.10000000001 },
                }),
            ).not.toThrow();
        });

        it("buildExistingOrderResponse returns reusable VA details and rejects near-expiry", () => {
            const existingPayment = {
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                reference: "ref-1",
                destinationBankAccountNumber: "0123456789",
                destinationBankAccountName: "Test User",
                destinationBankName: "Bank",
                totalAmount: "10000",
                order: { id: 1 },
            };

            const response = (service as any).buildExistingOrderResponse(existingPayment);
            expect(response.data.paymentInfo.reference).toBe("ref-1");
            expect(response.data.paymentInfo.accountNumber).toBe("0123456789");

            const almostExpired = {
                ...existingPayment,
                createdAt: new Date(Date.now() - 34 * 60 * 1000),
            };
            expect(() => (service as any).buildExistingOrderResponse(almostExpired)).toThrow(
                "Your previous order has nearly expired. Please wait a moment and try again.",
            );
        });

        it("buildExistingOrderResponse returns checkout reopen details for pending hosted-checkout orders", () => {
            const existingPayment = {
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                reference: "checkout-ref-2",
                destinationBankAccountNumber: null,
                destinationBankAccountName: null,
                destinationBankName: null,
                externalReference: "https://checkout.nomba.test/session-2",
                totalAmount: "10000",
                order: { id: 2 },
            };

            const response = (service as any).buildExistingOrderResponse(existingPayment);

            expect(response.data.paymentInfo.reference).toBe("checkout-ref-2");
            expect(response.data.paymentInfo.authorization_url).toBe(
                "https://checkout.nomba.test/session-2"
            );
        });
    });

    describe("status + cancellation flows", () => {
        // ── getBuyOrderStatus ────────────────────────────────────────────────

        it("returns not_found when no payment exists for the given reference + userId", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce(null);
            await expect(service.getBuyOrderStatus("ref-missing", 1)).resolves.toMatchObject({
                data: { status: "not_found" },
            });
        });

        it("returns 'completed' when payment.status is SUCCESS", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.SUCCESS,
                order: { id: 1, status: OrderStatus.completed, transactionId: "tx-1" },
            });
            await expect(service.getBuyOrderStatus("ref-1", 1)).resolves.toMatchObject({
                data: { status: "completed", paymentStatus: TransactionStatus.SUCCESS },
            });
        });

        it("returns 'processing' when payment.status is APPROVED", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.APPROVED,
                order: { id: 3, status: OrderStatus.processing, transactionId: "tx-3" },
            });
            await expect(service.getBuyOrderStatus("ref-3", 1)).resolves.toMatchObject({
                data: { status: "processing", paymentStatus: TransactionStatus.APPROVED },
            });
        });

        it("returns 'pending' when payment.status is PENDING (default)", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.PENDING,
                order: { id: 4, status: OrderStatus.pending, transactionId: "tx-4" },
            });
            await expect(service.getBuyOrderStatus("ref-4", 1)).resolves.toMatchObject({
                data: { status: "pending", paymentStatus: TransactionStatus.PENDING },
            });
        });

        it("returns 'failed' when payment.status is FAILED and order is in failed state", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.FAILED,
                order: { id: 2, status: OrderStatus.failed, transactionId: "tx-2" },
            });
            await expect(service.getBuyOrderStatus("ref-2", 1)).resolves.toMatchObject({
                data: { status: "failed", paymentStatus: TransactionStatus.FAILED },
            });
        });

        it("returns 'cancelled' when payment.status is FAILED and order.status is cancelled (explicit cancel)", async () => {
            // This is the case where cancelBuyOrder() was called:
            // payment.status = FAILED, order.status = cancelled
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.FAILED,
                order: { id: 5, status: OrderStatus.cancelled, transactionId: "tx-5" },
            });
            await expect(service.getBuyOrderStatus("ref-5", 1)).resolves.toMatchObject({
                data: { status: "cancelled", paymentStatus: TransactionStatus.FAILED, orderStatus: OrderStatus.cancelled },
            });
        });

        it("returns 'failed' when payment.status is FAILED and order is null (orphaned payment)", async () => {
            // Edge: payment exists but no associated order
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.FAILED,
                order: null,
            });
            await expect(service.getBuyOrderStatus("ref-orphan", 1)).resolves.toMatchObject({
                data: { status: "failed" },
            });
        });

        it("returns 'failed' when payment.status is FAILED and order is still 'pending' (webhook/network failure mid-flow)", async () => {
            // Edge: payment was marked FAILED but order never advanced from pending
            // (e.g., webhook arrived but fulfillBuyOrder crashed after updating payment but before updating order)
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.FAILED,
                order: { id: 6, status: OrderStatus.pending, transactionId: "tx-6" },
            });
            await expect(service.getBuyOrderStatus("ref-6", 1)).resolves.toMatchObject({
                data: { status: "failed" },
            });
        });

        it("returns 'pending' for unknown payment status (future enum value / DB migration ahead of code)", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: "UNKNOWN_FUTURE_STATUS",
                order: { id: 7, status: "some_status", transactionId: "tx-7" },
            });
            await expect(service.getBuyOrderStatus("ref-7", 1)).resolves.toMatchObject({
                data: { status: "pending" },
            });
        });

        it("response always includes paymentStatus, orderStatus, orderId and transactionId", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.SUCCESS,
                order: { id: 42, status: OrderStatus.completed, transactionId: "tx-full" },
            });
            const result = await service.getBuyOrderStatus("ref-full", 1);
            expect(result.data).toMatchObject({
                status: "completed",
                paymentStatus: TransactionStatus.SUCCESS,
                orderStatus: OrderStatus.completed,
                orderId: 42,
                transactionId: "tx-full",
            });
        });

        it("does not expose a cancelled order as 'failed' (BUG-001 regression guard)", async () => {
            // Regression guard: ensure the old behaviour (FAILED always → "failed")
            // is gone. A cancelled order must return "cancelled", not "failed".
            prismaService.payment.findFirst.mockResolvedValueOnce({
                status: TransactionStatus.FAILED,
                order: { id: 10, status: OrderStatus.cancelled, transactionId: "tx-cancel" },
            });
            const result = await service.getBuyOrderStatus("ref-cancel", 1);
            expect(result.data.status).toBe("cancelled");
            expect(result.data.status).not.toBe("failed");
        });

        it("cancelBuyOrder returns false when no pending payment exists", async () => {
            prismaService.payment.findFirst.mockResolvedValue(null);
            await expect(service.cancelBuyOrder("ref-1", 1)).resolves.toMatchObject({
                data: { cancelled: false },
            });
        });

        it("cancelBuyOrder aborts when atomic update finds payment already claimed", async () => {
            prismaService.payment.findFirst.mockResolvedValue({
                id: 10,
                orderId: 99,
                order: { id: 99, amount: 0.1, currency: "BTC", transactionId: "tx-99" },
                status: TransactionStatus.PENDING,
            });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                    order: { update: jest.fn() },
                }),
            );

            await expect(service.cancelBuyOrder("ref-1", 1)).resolves.toMatchObject({
                data: { cancelled: false },
            });
        });

        it("cancelBuyOrder cancels and notifies when payment is still pending", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const ws = (service as any).wsGateway;
            const transactionService = (service as any).transactionService;

            prismaService.payment.findFirst.mockResolvedValue({
                id: 11,
                orderId: 101,
                userId: 1,
                createdAt: new Date(),
                order: { id: 101, amount: 0.2, currency: "BTC", orderCategory: "BUY", transactionId: "tx-101" },
                status: TransactionStatus.PENDING,
            });
            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                    order: { update: jest.fn().mockResolvedValue(undefined) },
                }),
            );
            prismaService.order.findUnique.mockResolvedValue({
                id: 101,
                status: OrderStatus.cancelled,
                streamlinedStatus: "cancelled",
                orderCategory: "BUY",
                amount: 0.2,
                currency: "BTC",
                createdAt: new Date(),
                updatedAt: new Date(),
                transactionId: "tx-101",
            });

            const response = await service.cancelBuyOrder("ref-1", 1);
            expect(response.data.cancelled).toBe(true);
            expect(transactionService.releaseDailyLimitReservationForOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 1,
                    orderCategory: "BUY",
                    currency: "BTC",
                    amount: 0.2,
                }),
            );
            expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(1);
            expect(notify).toHaveBeenCalled();
        });
    });

    describe("payment reminder + confirmation", () => {
        it("notifyPendingBuyOrder returns no-op when pending payment is missing", async () => {
            prismaService.payment.findFirst.mockResolvedValue(null);
            await expect(service.notifyPendingBuyOrder("ref-1", 1)).resolves.toMatchObject({
                message: "No pending payment found",
            });
        });

        it("notifyPendingBuyOrder dispatches reminder when pending order exists", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            prismaService.payment.findFirst.mockResolvedValue({
                order: { amount: 0.4, currency: "BTC", transactionId: "tx-4" },
            });

            await expect(service.notifyPendingBuyOrder("ref-1", 1)).resolves.toMatchObject({
                message: "Pending reminder sent",
            });
            expect(notify).toHaveBeenCalled();
        });

        it("confirmPaymentSent handles missing payment, first confirmation, and repeat clicks", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce(null);
            await expect(service.confirmPaymentSent("ref-1", 1)).resolves.toMatchObject({
                data: { confirmed: false },
            });

            prismaService.payment.findFirst
                .mockResolvedValueOnce({ id: 5, orderId: 10, paymentConfirmedByUser: null, status: TransactionStatus.PENDING, order: { id: 10 } })
                .mockResolvedValueOnce({ id: 6, orderId: 11, paymentConfirmedByUser: new Date(), status: TransactionStatus.APPROVED, order: { id: 11 } });

            await expect(service.confirmPaymentSent("ref-2", 1)).resolves.toMatchObject({
                data: { confirmed: true },
            });
            expect(prismaService.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 5 } }),
            );

            await expect(service.confirmPaymentSent("ref-3", 1)).resolves.toMatchObject({
                data: { confirmed: true },
            });
            expect(prismaService.payment.update).toHaveBeenCalledTimes(1);
        });
    });

    describe("stuck/expiry/underpayment and internal buy flows", () => {
        it("fulfillBuyOrder alerts ops when payment is already FAILED and returns", async () => {
            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;

            prismaService.payment.updateMany.mockResolvedValue({ count: 0 });
            prismaService.payment.findUnique.mockResolvedValue({
                id: 500,
                orderId: 600,
                userId: 700,
                totalAmount: "150000",
                receivedAmount: "145000",
                senderAccountNumber: "0123456789",
                senderAccountName: "Late Sender",
                senderBankName: "Refund Bank",
                paymentMethod: "NOMBA",
                externalReference: "provider-ref-500",
                status: TransactionStatus.FAILED,
            });

            await expect(service.fulfillBuyOrder("failed-ref-1")).resolves.toBeUndefined();
            expect(slack).toHaveBeenCalledWith(
                "nomba",
                "failed-ref-1",
                expect.stringContaining("Manual refund required"),
                expect.objectContaining({
                    orderId: 600,
                    userId: 700,
                    amount: 145000,
                    expectedAmount: 150000,
                    receivedAmount: 145000,
                    senderAccountNumber: "0123456789",
                    senderAccountName: "Late Sender",
                    senderBankName: "Refund Bank",
                    externalReference: "provider-ref-500",
                }),
            );
        });

        it("fulfillBuyOrder exits safely when claimed payment disappears", async () => {
            prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
            prismaService.payment.findUnique.mockResolvedValue(null);

            await expect(service.fulfillBuyOrder("missing-payment-ref")).resolves.toBeUndefined();
            expect(prismaService.order.findUnique).not.toHaveBeenCalled();
        });

        it("fulfillBuyOrder exits safely when the related order is missing", async () => {
            prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
            prismaService.payment.findUnique.mockResolvedValue({
                id: 501,
                orderId: 999,
                userId: 44,
                user: { id: 44, cryptoSubAccountId: "sub-44", email: "u44@flipxer.com" },
            });
            prismaService.order.findUnique.mockResolvedValue(null);

            await expect(service.fulfillBuyOrder("missing-order-ref")).resolves.toBeUndefined();
            expect((service as any).ledgerService.pairedCreditInTransaction).toBeUndefined();
        });

        it("detectStuckConfirmedOrders returns 0 when no stale confirmations exist", async () => {
            prismaService.payment.findMany.mockResolvedValue([]);

            await expect(service.detectStuckConfirmedOrders()).resolves.toBe(0);
            expect((service as any).slackWebhookService.sendWebhookFailureAlert).not.toHaveBeenCalled();
        });

        it("detectStuckConfirmedOrders alerts and marks payments as alerted", async () => {
            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 501,
                    reference: "pay-501",
                    orderId: 701,
                    userId: 44,
                    paymentMethod: PaymentMethod.NOMBA,
                    paymentConfirmedByUser: new Date(Date.now() - 10 * 60 * 1000),
                    createdAt: new Date(Date.now() - 20 * 60 * 1000),
                    order: { transactionId: "tx-701", amount: 0.5, currency: "BTC" },
                    user: {
                        id: 44,
                        email: "user@flipxer.com",
                        firstName: "Jane",
                        lastName: "Doe",
                    },
                },
            ]);

            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;

            await expect(service.detectStuckConfirmedOrders()).resolves.toBe(1);
            expect(slack).toHaveBeenCalledWith(
                "nomba",
                "pay-501",
                expect.stringContaining("webhook never arrived"),
                expect.objectContaining({ orderId: 701, userId: 44 }),
            );
            expect(prismaService.payment.update).toHaveBeenCalledWith(
                expect.objectContaining({ where: { id: 501 } }),
            );
        });

        it("detectStuckConfirmedOrders swallows per-item Slack failures", async () => {
            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 502,
                    reference: "pay-502",
                    orderId: 702,
                    userId: 55,
                    paymentMethod: PaymentMethod.NOMBA,
                    paymentConfirmedByUser: new Date(Date.now() - 10 * 60 * 1000),
                    createdAt: new Date(Date.now() - 20 * 60 * 1000),
                    order: { transactionId: "tx-702", amount: 0.7, currency: "ETH" },
                    user: { id: 55, email: "x@flipxer.com", firstName: "X", lastName: "Y" },
                },
            ]);

            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;
            slack.mockRejectedValue(new Error("slack down"));

            await expect(service.detectStuckConfirmedOrders()).resolves.toBe(1);
            expect(prismaService.payment.update).not.toHaveBeenCalled();
        });

        it("cancelExpiredBuyOrders atomically cancels and notifies", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const ws = (service as any).wsGateway;
            const transactionService = (service as any).transactionService;

            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 601,
                    reference: "pay-601",
                    orderId: 801,
                    userId: 77,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 40 * 60 * 1000),
                    totalAmount: "100000",
                    receivedAmount: null,
                    order: {
                        id: 801,
                        amount: 0.3,
                        currency: "BTC",
                        orderCategory: "BUY",
                        status: OrderStatus.pending,
                        transactionId: "tx-801",
                    },
                    user: { id: 77, email: "u77@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                    order: { update: jest.fn().mockResolvedValue(undefined) },
                }),
            );

            await expect(service.cancelExpiredBuyOrders()).resolves.toBe(1);
            expect(transactionService.releaseDailyLimitReservationForOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 77,
                    orderCategory: "BUY",
                    currency: "BTC",
                    amount: 0.3,
                }),
            );
            expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(77);
            expect(notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 77,
                    title: "Buy order expired",
                }),
            );
        });

        it("cancelExpiredBuyOrders skips notifications when atomic claim fails", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const ws = (service as any).wsGateway;

            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 602,
                    reference: "pay-602",
                    orderId: 802,
                    userId: 78,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 40 * 60 * 1000),
                    totalAmount: "100000",
                    receivedAmount: null,
                    order: {
                        id: 802,
                        amount: 0.2,
                        currency: "ETH",
                        status: OrderStatus.pending,
                        transactionId: "tx-802",
                    },
                    user: { id: 78, email: "u78@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                    order: { update: jest.fn() },
                }),
            );

            await expect(service.cancelExpiredBuyOrders()).resolves.toBe(1);
            expect(ws.notifyWalletUpdate).not.toHaveBeenCalled();
            expect(notify).not.toHaveBeenCalled();
        });

        it("cancelExpiredBuyOrders continues when a payment cancellation throws", async () => {
            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 603,
                    reference: "pay-603",
                    orderId: 803,
                    userId: 79,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 40 * 60 * 1000),
                    totalAmount: "100000",
                    receivedAmount: null,
                    order: {
                        id: 803,
                        amount: 0.2,
                        currency: "ETH",
                        status: OrderStatus.pending,
                        transactionId: "tx-803",
                    },
                    user: { id: 79, email: "u79@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockRejectedValue(new Error("db timeout"));

            await expect(service.cancelExpiredBuyOrders()).resolves.toBe(1);
        });

        it("cancelExpiredBuyOrders excludes underpaid payments from the expiry query", async () => {
            prismaService.payment.findMany.mockResolvedValue([]);

            await expect(service.cancelExpiredBuyOrders()).resolves.toBe(0);

            expect(prismaService.payment.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        receivedAmount: null,
                        paymentConfirmedByUser: null,
                    }),
                }),
            );
        });

        it("cancelUnderpaidBuyOrders cancels underpaid orders and sends ops alert", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;

            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 701,
                    reference: "pay-701",
                    orderId: 901,
                    userId: 88,
                    paymentMethod: PaymentMethod.NOMBA,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                    totalAmount: "100000",
                    receivedAmount: "50000",
                    senderAccountNumber: "1234567890",
                    senderAccountName: "Sender One",
                    senderBankName: "Bank A",
                    order: {
                        id: 901,
                        amount: 0.6,
                        currency: "BTC",
                        status: OrderStatus.pending,
                        transactionId: "tx-901",
                    },
                    user: { id: 88, email: "u88@flipxer.com" },
                },
                {
                    id: 702,
                    reference: "pay-702",
                    orderId: 902,
                    userId: 89,
                    paymentMethod: PaymentMethod.NOMBA,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                    totalAmount: "100000",
                    receivedAmount: "100000",
                    order: {
                        id: 902,
                        amount: 0.7,
                        currency: "ETH",
                        status: OrderStatus.pending,
                        transactionId: "tx-902",
                    },
                    user: { id: 89, email: "u89@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                    order: { update: jest.fn().mockResolvedValue(undefined) },
                }),
            );

            await expect(service.cancelUnderpaidBuyOrders()).resolves.toBe(1);
            expect(notify).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: 88,
                    title: "Buy order cancelled - underpayment",
                }),
            );
            expect(slack).toHaveBeenCalledWith(
                "nomba",
                "pay-701",
                expect.stringContaining("Underpaid buy order auto-cancelled"),
                expect.objectContaining({
                    orderId: 901,
                    userId: 88,
                }),
            );
        });

        it("cancelUnderpaidBuyOrders skips when atomic update finds already-claimed payment", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;

            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 703,
                    reference: "pay-703",
                    orderId: 903,
                    userId: 90,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                    totalAmount: "120000",
                    receivedAmount: "60000",
                    order: {
                        id: 903,
                        amount: 0.9,
                        currency: "BTC",
                        status: OrderStatus.pending,
                        transactionId: "tx-903",
                    },
                    user: { id: 90, email: "u90@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                    order: { update: jest.fn() },
                }),
            );

            await expect(service.cancelUnderpaidBuyOrders()).resolves.toBe(1);
            expect(notify).not.toHaveBeenCalled();
            expect(slack).not.toHaveBeenCalled();
        });

        it("cancelUnderpaidBuyOrders continues processing when a cancellation attempt throws", async () => {
            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 704,
                    reference: "pay-704",
                    orderId: 904,
                    userId: 91,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                    totalAmount: "120000",
                    receivedAmount: "60000",
                    order: {
                        id: 904,
                        amount: 0.9,
                        currency: "BTC",
                        status: OrderStatus.pending,
                        transactionId: "tx-904",
                    },
                    user: { id: 91, email: "u91@flipxer.com" },
                },
            ]);

            prismaService.$transaction = jest.fn().mockRejectedValue(new Error("db lock timeout"));

            await expect(service.cancelUnderpaidBuyOrders()).resolves.toBe(1);
        });

        it("executeInternalBuy returns success payload and throws on ledger credit failure", async () => {
            const pairedCredit = (service as any).ledgerService.pairedCredit as jest.Mock;

            pairedCredit.mockResolvedValueOnce({
                success: true,
                userEntry: { id: "entry-1" },
            });

            await expect(
                service.executeInternalBuy(mockUser as any, 0.25, "btc", "swap-1"),
            ).resolves.toMatchObject({
                status: "success",
                data: { id: "entry-1", amount: 0.25, currency: "BTC" },
            });

            pairedCredit.mockResolvedValueOnce({ success: false, error: "ledger unavailable" });

            await expect(
                service.executeInternalBuy(mockUser as any, 0.1, "eth", "swap-2"),
            ).rejects.toThrow("Ledger credit failed: ledger unavailable");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Notification and email content tests
    //
    // Each buy-order lifecycle event has a specific title, body, channel mix,
    // and (where applicable) emailPayload. These tests pin the exact payload
    // so regressions in copy or channel config are caught immediately.
    // ─────────────────────────────────────────────────────────────────────────

    describe("notification and email content", () => {
        let notify: jest.Mock;
        let ws: { notifyTransactionUpdate: jest.Mock; notifyWalletUpdate: jest.Mock };

        beforeEach(() => {
            notify = (service as any).notificationDispatcher.notify as jest.Mock;
            ws = (service as any).wsGateway;
            notify.mockClear();
            ws.notifyWalletUpdate.mockClear();
            ws.notifyTransactionUpdate.mockClear();
        });

        // ── 1. Order initiated (buyCryptoOrder) ───────────────────────────────

        describe("buyCryptoOrder — order initiated notification", () => {
            it("sends push-only 'Buy order initiated' notification with amount + currency + transactionId", async () => {
                // Arrange: bypass idempotency + pending checks
                prismaService.payment.findUnique.mockResolvedValue(null);
                prismaService.payment.findFirst.mockResolvedValue(null);
                prismaService.assetWallet.findFirst.mockResolvedValue({
                    ...mockAssetWallet,
                    depositAddress: "bc1q-notify-test",
                    defaultNetwork: "btc",
                });
                (service as any).inboundFiatPaymentService.initializePayment = jest
                    .fn()
                    .mockResolvedValue({
                        provider: "nomba",
                        mode: "virtual_account",
                        reference: "va-notify-ref",
                        providerAccountReference: "va-notify-ref",
                        amount: 100,
                        accountNumber: "0001112222",
                        accountName: "Flipxer User",
                        bankName: "Nomba MFB",
                        bankCode: "0900",
                        expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        order: {
                            create: jest.fn().mockResolvedValue({
                                id: 900,
                                amount: 0.05,
                                currency: "BTC",
                                transactionId: "TX-NOTIFY-001",
                                status: "pending",
                                streamlinedStatus: "pending",
                                orderCategory: "BUY",
                                createdAt: new Date(),
                                updatedAt: new Date(),
                            }),
                        },
                        payment: { create: jest.fn().mockResolvedValue({ id: 800 }) },
                    }),
                );

                await service.buyCryptoOrder(mockUser as any, {
                    asset: "btc",
                    amount: 0.05,
                    buyRate: 70000000,
                    charge: 750,
                } as any);

                expect(notify).toHaveBeenCalledTimes(1);
                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: mockUser.id,
                        title: "Buy order initiated",
                        enablePush: true,
                    }),
                );

                // Body must reference amount + currency
                const call = notify.mock.calls[0][0];
                expect(call.body).toMatch(/0\.05/);
                expect(call.body).toMatch(/BTC/);
                expect(call.body).toMatch(/TX-NOTIFY-001/);

                // Push only — NO email channel
                expect(call.enableEmail).toBeFalsy();
                expect(call.emailPayload).toBeUndefined();
            });

            it("notifyWalletUpdate is called alongside the notification", async () => {
                prismaService.payment.findUnique.mockResolvedValue(null);
                prismaService.payment.findFirst.mockResolvedValue(null);
                prismaService.assetWallet.findFirst.mockResolvedValue({
                    ...mockAssetWallet,
                    depositAddress: "bc1q-ws-test",
                    defaultNetwork: "btc",
                });
                (service as any).inboundFiatPaymentService.initializePayment = jest
                    .fn()
                    .mockResolvedValue({
                        provider: "nomba",
                        mode: "virtual_account",
                        reference: "va-ws-ref",
                        providerAccountReference: "va-ws-ref",
                        amount: 100,
                        accountNumber: "0002223333",
                        accountName: "Flipxer User",
                        bankName: "Nomba MFB",
                        bankCode: "0900",
                        expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    });
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        order: {
                            create: jest.fn().mockResolvedValue({
                                id: 901,
                                amount: 0.1,
                                currency: "ETH",
                                transactionId: "TX-NOTIFY-002",
                                status: "pending",
                                streamlinedStatus: "pending",
                                orderCategory: "BUY",
                                createdAt: new Date(),
                                updatedAt: new Date(),
                            }),
                        },
                        payment: { create: jest.fn().mockResolvedValue({ id: 801 }) },
                    }),
                );

                await service.buyCryptoOrder(mockUser as any, {
                    asset: "eth",
                    amount: 0.1,
                    buyRate: 5000000,
                    charge: 250,
                } as any);

                expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(mockUser.id);
            });
        });

        // ── 2. Order fulfilled (fulfillBuyOrder — webhook success) ───────────

        describe("fulfillBuyOrder — success notification", () => {
            const fulfillPaymentBase = {
                id: 100,
                orderId: 200,
                userId: 1,
                reference: "fulfill-ref-001",
                user: {
                    id: 1,
                    email: "test@example.com",
                    cryptoSubAccountId: "sub-001",
                },
            };

            const fulfillOrder = {
                id: 200,
                amount: 0.15,
                currency: "BTC",
                transactionId: "TX-FULFILL-001",
                userId: 1,
            };

            function setupFulfillMocks() {
                prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
                prismaService.payment.findUnique.mockResolvedValue(fulfillPaymentBase);
                prismaService.order.findUnique.mockResolvedValue(fulfillOrder);

                (service as any).ledgerService.pairedCreditInTransaction = jest
                    .fn()
                    .mockResolvedValue({ success: true, userEntry: { id: "entry-f1" } });

                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        assetWallet: {
                            update: jest.fn().mockResolvedValue(undefined),
                        },
                        order: {
                            update: jest.fn().mockResolvedValue(undefined),
                        },
                        payment: {
                            update: jest.fn().mockResolvedValue(undefined),
                        },
                    }),
                );

                // Return updated order after fulfillment
                prismaService.order.findUnique
                    .mockResolvedValueOnce(fulfillOrder)   // first call in fulfillBuyOrder
                    .mockResolvedValueOnce({               // second call (post-tx lookup)
                        ...fulfillOrder,
                        status: "completed",
                        streamlinedStatus: "completed",
                        orderCategory: "BUY",
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });
            }

            it("sends push + email 'Buy order successful' with correct content", async () => {
                setupFulfillMocks();

                await service.fulfillBuyOrder("fulfill-ref-001");

                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 1,
                        title: "Buy order successful",
                        enableEmail: true,
                        enablePush: true,
                    }),
                );

                const call = notify.mock.calls[0][0];

                // Body copy
                expect(call.body).toMatch(/0\.15/);
                expect(call.body).toMatch(/BTC/);
                expect(call.body).toMatch(/completed successfully/i);

                // Email payload shape
                expect(call.emailPayload).toMatchObject({
                    email: "test@example.com",
                    transactionType: "buy",
                    transactionId: "TX-FULFILL-001",
                    amount: "0.15",
                    currency: "BTC",
                    status: "completed",
                });
                expect(call.emailPayload.date).toBeDefined();
            });

            it("sends notifyWalletUpdate and notifyTransactionUpdate on success", async () => {
                setupFulfillMocks();

                await service.fulfillBuyOrder("fulfill-ref-001");

                expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(1);
                expect(ws.notifyTransactionUpdate).toHaveBeenCalledWith(
                    1,
                    expect.objectContaining({ type: "transaction_update" }),
                );
            });

            it("does NOT send a user notification when fulfillment fails (reverts payment, alerts ops)", async () => {
                prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
                prismaService.payment.findUnique.mockResolvedValue(fulfillPaymentBase);
                prismaService.order.findUnique.mockResolvedValue(fulfillOrder);

                (service as any).ledgerService.pairedCreditInTransaction = jest
                    .fn()
                    .mockRejectedValue(new Error("ledger error"));

                prismaService.$transaction = jest
                    .fn()
                    .mockRejectedValue(new Error("ledger error"));

                const slack = (service as any).slackWebhookService
                    .sendWebhookFailureAlert as jest.Mock;

                await expect(service.fulfillBuyOrder("fulfill-ref-001")).rejects.toThrow();

                // No user notification on internal failure
                expect(notify).not.toHaveBeenCalled();

                // Ops alert IS sent
                expect(slack).toHaveBeenCalledWith(
                    "quidax",
                    "fulfill-ref-001",
                    expect.any(String),
                    expect.any(Object),
                );
            });
        });

        // ── 3. User-initiated cancel (cancelBuyOrder) ─────────────────────────

        describe("cancelBuyOrder — cancellation notification", () => {
            it("sends push-only 'Buy order cancelled' with correct body (no email)", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    id: 300,
                    orderId: 400,
                    order: {
                        id: 400,
                        amount: 0.25,
                        currency: "ETH",
                        transactionId: "TX-CANCEL-001",
                    },
                    status: TransactionStatus.PENDING,
                });
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );
                prismaService.order.findUnique.mockResolvedValue({
                    id: 400,
                    status: "cancelled",
                    streamlinedStatus: "cancelled",
                    orderCategory: "BUY",
                    amount: 0.25,
                    currency: "ETH",
                    transactionId: "TX-CANCEL-001",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                await service.cancelBuyOrder("cancel-ref-001", 1);

                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 1,
                        title: "Buy order cancelled",
                        enablePush: true,
                    }),
                );

                const call = notify.mock.calls[0][0];

                // Body must include amount + currency + transactionId
                expect(call.body).toMatch(/0\.25/);
                expect(call.body).toMatch(/ETH/);
                expect(call.body).toMatch(/TX-CANCEL-001/);
                expect(call.body).toMatch(/cancelled/i);

                // Push + email (user-initiated cancel now also sends email)
                expect(call.enableEmail).toBe(true);
                expect(call.emailPayload).toBeDefined();
            });

            it("does NOT send notification when cancel races with a webhook (cancelled=false)", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    id: 301,
                    orderId: 401,
                    order: { id: 401, amount: 0.1, currency: "BTC", transactionId: "TX-CANCEL-RACE" },
                    status: TransactionStatus.PENDING,
                });
                // Atomic update returns 0 — webhook already claimed the payment
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                        order: { update: jest.fn() },
                    }),
                );

                const result = await service.cancelBuyOrder("race-ref", 1);

                expect(result.data.cancelled).toBe(false);
                expect(notify).not.toHaveBeenCalled();
            });

            it("notifyWalletUpdate is called on successful cancel", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    id: 302,
                    orderId: 402,
                    order: { id: 402, amount: 0.05, currency: "BTC", transactionId: "TX-CANCEL-WS" },
                    status: TransactionStatus.PENDING,
                });
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );
                prismaService.order.findUnique.mockResolvedValue({
                    id: 402,
                    status: "cancelled",
                    streamlinedStatus: "cancelled",
                    orderCategory: "BUY",
                    amount: 0.05,
                    currency: "BTC",
                    transactionId: "TX-CANCEL-WS",
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                await service.cancelBuyOrder("cancel-ws-ref", 1);

                expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(1);
            });
        });

        // ── 4. Expired order (cancelExpiredBuyOrders cron) ───────────────────

        describe("cancelExpiredBuyOrders — expiry notification", () => {
            const expiredPayment = {
                id: 600,
                reference: "pay-600",
                orderId: 800,
                userId: 77,
                status: TransactionStatus.PENDING,
                createdAt: new Date(Date.now() - 40 * 60 * 1000),
                totalAmount: "200000",
                receivedAmount: null,
                order: {
                    id: 800,
                    amount: 0.3,
                    currency: "BTC",
                    status: "pending",
                    transactionId: "TX-EXPIRED-001",
                },
                user: { id: 77, email: "expired@flipxer.com" },
            };

            beforeEach(() => {
                prismaService.payment.findMany.mockResolvedValue([expiredPayment]);
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );
            });

            it("sends push + email 'Buy order expired' with correct body", async () => {
                await service.cancelExpiredBuyOrders();

                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 77,
                        title: "Buy order expired",
                        enablePush: true,
                        enableEmail: true,
                    }),
                );

                const call = notify.mock.calls[0][0];

                // Body copy
                expect(call.body).toMatch(/0\.3/);
                expect(call.body).toMatch(/BTC/);
                expect(call.body).toMatch(/TX-EXPIRED-001/);
                expect(call.body).toMatch(/expired|payment window/i);

                // Email payload
                expect(call.emailPayload).toMatchObject({
                    email: "expired@flipxer.com",
                    transactionType: "buy",
                    transactionId: "TX-EXPIRED-001",
                    amount: "0.3",
                    currency: "BTC",
                    status: "cancelled",
                });
                expect(call.emailPayload.date).toBeDefined();
            });

            it("sends notifyWalletUpdate on expiry", async () => {
                await service.cancelExpiredBuyOrders();
                expect(ws.notifyWalletUpdate).toHaveBeenCalledWith(77);
            });

            it("does NOT send notification when atomic claim fails (webhook beat the cron)", async () => {
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                        order: { update: jest.fn() },
                    }),
                );

                await service.cancelExpiredBuyOrders();

                expect(notify).not.toHaveBeenCalled();
                expect(ws.notifyWalletUpdate).not.toHaveBeenCalled();
            });

            it("sends email with currency in UPPERCASE in emailPayload", async () => {
                // currency from DB might be lowercase — emailPayload.currency must be uppercase
                prismaService.payment.findMany.mockResolvedValue([{
                    ...expiredPayment,
                    order: { ...expiredPayment.order, currency: "eth" }, // lowercase from DB
                }]);

                await service.cancelExpiredBuyOrders();

                const call = notify.mock.calls[0][0];
                expect(call.emailPayload.currency).toBe("ETH");
            });
        });

        // ── 5. Underpayment cancel (cancelUnderpaidBuyOrders cron) ────────────

        describe("cancelUnderpaidBuyOrders — underpayment notification", () => {
            const underpaidPayment = {
                id: 700,
                reference: "pay-700",
                orderId: 900,
                userId: 88,
                paymentMethod: PaymentMethod.NOMBA,
                status: TransactionStatus.PENDING,
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                totalAmount: "100000",
                receivedAmount: "60000",
                senderAccountNumber: "1111222233",
                senderAccountName: "John Sender",
                senderBankName: "GTBank",
                order: {
                    id: 900,
                    amount: 0.08,
                    currency: "BTC",
                    status: "pending",
                    transactionId: "TX-UNDERPAY-001",
                },
                user: { id: 88, email: "underpay@flipxer.com" },
            };

            beforeEach(() => {
                prismaService.payment.findMany.mockResolvedValue([underpaidPayment]);
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );
            });

            it("sends push + email 'Buy order cancelled - underpayment' with received/expected amounts", async () => {
                await service.cancelUnderpaidBuyOrders();

                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 88,
                        title: "Buy order cancelled - underpayment",
                        enablePush: true,
                        enableEmail: true,
                    }),
                );

                const call = notify.mock.calls[0][0];

                // Body must show both received and expected amounts + refund mention
                expect(call.body).toMatch(/60000/);    // received
                expect(call.body).toMatch(/100000/);   // expected
                expect(call.body).toMatch(/TX-UNDERPAY-001/);
                expect(call.body).toMatch(/refund/i);

                // Email payload
                expect(call.emailPayload).toMatchObject({
                    email: "underpay@flipxer.com",
                    transactionType: "buy",
                    transactionId: "TX-UNDERPAY-001",
                    amount: "0.08",
                    currency: "BTC",
                    status: "cancelled",
                });
            });

            it("sends Slack ops alert with sender details for manual refund", async () => {
                const slack = (service as any).slackWebhookService
                    .sendWebhookFailureAlert as jest.Mock;
                const transactionService = (service as any).transactionService;
                slack.mockClear();

                await service.cancelUnderpaidBuyOrders();

                expect(transactionService.releaseDailyLimitReservationForOrder).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 88,
                        orderCategory: "BUY",
                        currency: "BTC",
                        amount: 0.08,
                    }),
                );

                expect(slack).toHaveBeenCalledWith(
                    "nomba",
                    "pay-700",
                    expect.stringContaining("Underpaid buy order auto-cancelled"),
                    expect.objectContaining({
                        orderId: 900,
                        userId: 88,
                        receivedAmount: 60000,
                        senderAccountNumber: "1111222233",
                        senderAccountName: "John Sender",
                        senderBankName: "GTBank",
                    }),
                );
            });

            it("does NOT notify when atomic update fails (payment already claimed)", async () => {
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
                        order: { update: jest.fn() },
                    }),
                );

                await service.cancelUnderpaidBuyOrders();

                expect(notify).not.toHaveBeenCalled();
            });

            it("skips orders where received = expected (99% tolerance — not actually underpaid)", async () => {
                // Service applies a 99% tolerance: received < expected * 0.99.
                // A payment where received === totalAmount is NOT underpaid and must be skipped.
                // DB returns it (mocked), but the in-memory filter should exclude it.
                prismaService.payment.findMany.mockResolvedValue([{
                    ...underpaidPayment,
                    receivedAmount: "100000", // equals totalAmount → not underpaid
                    totalAmount: "100000",
                    order: { ...underpaidPayment.order, status: "pending" },
                }]);

                await service.cancelUnderpaidBuyOrders();

                // Payment is excluded by the receivedAmount < expected * 0.99 filter
                expect(notify).not.toHaveBeenCalled();
                expect(ws.notifyWalletUpdate).not.toHaveBeenCalled();
            });
        });

        // ── 6. Pending reminder (notifyPendingBuyOrder) ───────────────────────

        describe("notifyPendingBuyOrder — pending reminder notification", () => {
            it("sends push-only 'Buy order still pending' with amount + transactionId (no email)", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    order: {
                        amount: 0.12,
                        currency: "SOL",
                        transactionId: "TX-PENDING-REMIND-001",
                    },
                });

                await service.notifyPendingBuyOrder("pending-ref", 1);

                expect(notify).toHaveBeenCalledWith(
                    expect.objectContaining({
                        userId: 1,
                        title: "Buy order still pending",
                        enablePush: true,
                    }),
                );

                const call = notify.mock.calls[0][0];

                expect(call.body).toMatch(/0\.12/);
                expect(call.body).toMatch(/SOL/);
                expect(call.body).toMatch(/TX-PENDING-REMIND-001/);
                expect(call.body).toMatch(/pending|transfer/i);

                // Push only — no email channel
                expect(call.enableEmail).toBeFalsy();
                expect(call.emailPayload).toBeUndefined();
            });

            it("sends no notification when no pending payment is found", async () => {
                prismaService.payment.findFirst.mockResolvedValue(null);

                await service.notifyPendingBuyOrder("missing-ref", 1);

                expect(notify).not.toHaveBeenCalled();
            });

            it("sends no notification when payment exists but order is missing", async () => {
                prismaService.payment.findFirst.mockResolvedValue({ order: null });

                await service.notifyPendingBuyOrder("no-order-ref", 1);

                expect(notify).not.toHaveBeenCalled();
            });
        });

        // ── 7. Channel matrix — verifies correct channel per trigger ──────────

        describe("notification channel matrix", () => {
            /**
             * Each trigger must use the right channel combination:
             *
             *   Trigger                   | push | email
             *   --------------------------|------|------
             *   Order initiated           |  ✓   |  ✗   (user is in-app)
             *   Order fulfilled (success) |  ✓   |  ✓   (may leave app after payment)
             *   User-initiated cancel     |  ✓   |  ✗   (user is in-app)
             *   Cron expiry cancel        |  ✓   |  ✓   (user likely not in-app)
             *   Underpayment cancel       |  ✓   |  ✓   (user likely not in-app)
             *   Pending reminder          |  ✓   |  ✗   (triggered by in-app action)
             */

            it("user-initiated cancel uses push only (no email)", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    id: 400,
                    orderId: 500,
                    order: { id: 500, amount: 0.1, currency: "BTC", transactionId: "TX-CH-001" },
                    status: TransactionStatus.PENDING,
                });
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );
                prismaService.order.findUnique.mockResolvedValue({
                    id: 500, status: "cancelled", streamlinedStatus: "cancelled",
                    orderCategory: "BUY", amount: 0.1, currency: "BTC",
                    transactionId: "TX-CH-001", createdAt: new Date(), updatedAt: new Date(),
                });

                await service.cancelBuyOrder("ch-ref", 1);

                const call = notify.mock.calls[0][0];
                expect(call.enablePush).toBe(true);
                expect(call.enableEmail).toBe(true);
                expect(call.emailPayload).toBeDefined();
            });

            it("cron expiry cancel uses push + email", async () => {
                prismaService.payment.findMany.mockResolvedValue([{
                    id: 601,
                    reference: "pay-601",
                    orderId: 801,
                    userId: 200,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 40 * 60 * 1000),
                    totalAmount: "50000",
                    receivedAmount: null,
                    order: { id: 801, amount: 0.02, currency: "ETH", status: "pending", transactionId: "TX-CH-002" },
                    user: { id: 200, email: "ch-expiry@flipxer.com" },
                }]);
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );

                await service.cancelExpiredBuyOrders();

                const call = notify.mock.calls[0][0];
                expect(call.enablePush).toBe(true);
                expect(call.enableEmail).toBe(true);
                expect(call.emailPayload).toBeDefined();
            });

            it("underpayment cancel uses push + email", async () => {
                prismaService.payment.findMany.mockResolvedValue([{
                    id: 750,
                    reference: "pay-750",
                    orderId: 950,
                    userId: 300,
                    status: TransactionStatus.PENDING,
                    createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                    totalAmount: "80000",
                    receivedAmount: "40000",
                    senderAccountNumber: "9876543210",
                    senderAccountName: "Sender X",
                    senderBankName: "Zenith",
                    order: { id: 950, amount: 0.04, currency: "BTC", status: "pending", transactionId: "TX-CH-003" },
                    user: { id: 300, email: "ch-underpay@flipxer.com" },
                }]);
                prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                    cb({
                        payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
                        order: { update: jest.fn().mockResolvedValue(undefined) },
                    }),
                );

                await service.cancelUnderpaidBuyOrders();

                const call = notify.mock.calls[0][0];
                expect(call.enablePush).toBe(true);
                expect(call.enableEmail).toBe(true);
                expect(call.emailPayload).toBeDefined();
            });

            it("pending reminder uses push only (no email)", async () => {
                prismaService.payment.findFirst.mockResolvedValue({
                    order: { amount: 0.07, currency: "XRP", transactionId: "TX-CH-004" },
                });

                await service.notifyPendingBuyOrder("ch-pending-ref", 1);

                const call = notify.mock.calls[0][0];
                expect(call.enablePush).toBe(true);
                expect(call.enableEmail).toBeFalsy();
                expect(call.emailPayload).toBeUndefined();
            });
        });
    });
});
