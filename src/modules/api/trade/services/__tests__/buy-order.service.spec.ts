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
import { BankInjectionToken } from "@/modules/factory/bank/types";
import { WalletAddressService } from "../wallet-address.service";
import { WsGateway } from "../../gateway/v1";
import { TradeHelpersService } from "../trade-helpers.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { LedgerService } from "../ledger/ledger.service";
import { RateService } from "../rate.service";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { DistributedLockService } from "@/modules/core/redisCache/services/distributed-lock.service";
import { IncompleteAccountSetupException } from "../../errors";
import { OrderStatus, TransactionStatus } from "@prisma/client";

describe("BuyOrderService", () => {
    let service: BuyOrderService;
    let prismaService: any;

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

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BuyOrderService,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: BankInjectionToken.NOMBA, useValue: {} },
                { provide: WalletAddressService, useValue: mockWalletAddressService },
                { provide: WsGateway, useValue: mockWsGateway },
                { provide: TradeHelpersService, useValue: { calculateFee: jest.fn() } },
                { provide: SlackWebhookService, useValue: { sendWebhookFailureAlert: jest.fn() } },
                { provide: LedgerService, useValue: { pairedCredit: jest.fn() } },
                { provide: RateService, useValue: mockRateService },
                { provide: NotificationDispatcher, useValue: { notify: jest.fn() } },
                { provide: DistributedLockService, useValue: { withLock: jest.fn((key, fn) => fn()) } },
            ],
        }).compile();

        service = module.get<BuyOrderService>(BuyOrderService);
        prismaService = module.get(PrismaService);
    });

    it("should be defined", () => {
        expect(service).toBeDefined();
    });

    describe("buyCryptoQuoteRequest", () => {
        const quoteDto = {
            asset: "btc",
            amount: 0.01,
        };

        it("should throw IncompleteAccountSetupException when user has no crypto account", async () => {
            const userWithoutAccount = { ...mockUser, cryptoSubAccountId: null } as any;

            await expect(
                service.buyCryptoQuoteRequest(userWithoutAccount, quoteDto)
            ).rejects.toThrow(IncompleteAccountSetupException);
        });

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
        it("should calculate quote correctly", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1q...",
                defaultNetwork: "btc",
            });
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

        it("throws when requested asset wallet is missing", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue(null);

            await expect(
                service.calculateBuyQuote(mockUser as any, { asset: "XRP", amount: 0.2 } as any),
            ).rejects.toThrow("Asset XRP not found for the user");
        });

        it("throws when wallet exists without a deposit address/network", async () => {
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: null,
                defaultNetwork: null,
            });

            await expect(
                service.calculateBuyQuote(mockUser as any, { asset: "BTC", amount: 0.2 } as any),
            ).rejects.toThrow("No wallet address found for asset BTC");
        });
    });

    describe("buyCryptoOrder", () => {
        const orderDto = {
            asset: "btc",
            amount: 0.01,
            buyRate: 70000000,
            charge: 750,
        } as any;

        it("should throw when user has no crypto account", async () => {
            const userWithoutAccount = { ...mockUser, cryptoSubAccountId: null } as any;

            await expect(
                service.buyCryptoOrder(userWithoutAccount, orderDto)
            ).rejects.toThrow();
        });

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
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1qnewaddress",
                defaultNetwork: "btc",
            });

            (service as any).nombaService.initializePaymentViaVirtualAccount = jest
                .fn()
                .mockResolvedValue({
                    data: {
                        reference: "va-ref-1",
                        accountNumber: "0099009900",
                        accountName: "Flipxer User",
                        bankName: "Nomba",
                        bankCode: "0900",
                        expiryAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    },
                });

            prismaService.$transaction = jest.fn().mockImplementation(async (cb: any) =>
                cb({
                    order: {
                        create: jest.fn().mockResolvedValue({
                            id: 303,
                            amount: 0.01,
                            currency: "BTC",
                            status: OrderStatus.pending,
                            streamlinedStatus: "pending",
                            orderCategory: OrderStatus.pending,
                            transactionId: "tx-303",
                            createdAt: new Date(),
                            updatedAt: new Date(),
                        }),
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

        it("falls back to hosted checkout when the Nomba sandbox VA cap is reached", async () => {
            prismaService.payment.findUnique.mockResolvedValue(null);
            prismaService.payment.findFirst.mockResolvedValue(null);
            prismaService.assetWallet.findFirst.mockResolvedValue({
                ...mockAssetWallet,
                depositAddress: "bc1qcheckoutaddress",
                defaultNetwork: "btc",
            });

            (service as any).nombaService.initializePaymentViaVirtualAccount = jest
                .fn()
                .mockRejectedValue(
                    new Error("Only 2 sandbox virtual accounts are allowed per account holder")
                );
            (service as any).nombaService.initializePayment = jest
                .fn()
                .mockResolvedValue({
                    data: {
                        reference: "checkout-ref-1",
                        link: "https://checkout.nomba.test/session-1",
                        amount: 100,
                    },
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

            expect((service as any).nombaService.initializePayment).toHaveBeenCalledTimes(1);
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
        it("getBuyOrderStatus handles missing payment and status mapping", async () => {
            prismaService.payment.findFirst.mockResolvedValueOnce(null);
            await expect(service.getBuyOrderStatus("ref-1", 1)).resolves.toMatchObject({
                data: { status: "not_found" },
            });

            prismaService.payment.findFirst
                .mockResolvedValueOnce({ status: TransactionStatus.SUCCESS, order: { id: 1, status: OrderStatus.completed, transactionId: "tx-1" } })
                .mockResolvedValueOnce({ status: TransactionStatus.FAILED, order: { id: 2, status: OrderStatus.failed, transactionId: "tx-2" } })
                .mockResolvedValueOnce({ status: TransactionStatus.APPROVED, order: { id: 3, status: OrderStatus.processing, transactionId: "tx-3" } })
                .mockResolvedValueOnce({ status: TransactionStatus.PENDING, order: { id: 4, status: OrderStatus.pending, transactionId: "tx-4" } });

            await expect(service.getBuyOrderStatus("ref-1", 1)).resolves.toMatchObject({ data: { status: "completed" } });
            await expect(service.getBuyOrderStatus("ref-2", 1)).resolves.toMatchObject({ data: { status: "failed" } });
            await expect(service.getBuyOrderStatus("ref-3", 1)).resolves.toMatchObject({ data: { status: "processing" } });
            await expect(service.getBuyOrderStatus("ref-4", 1)).resolves.toMatchObject({ data: { status: "pending" } });
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

            prismaService.payment.findFirst.mockResolvedValue({
                id: 11,
                orderId: 101,
                order: { id: 101, amount: 0.2, currency: "BTC", transactionId: "tx-101" },
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
                status: TransactionStatus.FAILED,
            });

            await expect(service.fulfillBuyOrder("failed-ref-1")).resolves.toBeUndefined();
            expect(slack).toHaveBeenCalledWith(
                "nomba",
                "failed-ref-1",
                expect.stringContaining("Manual refund required"),
                expect.objectContaining({ orderId: 600, userId: 700 }),
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

        it("cancelUnderpaidBuyOrders cancels underpaid orders and sends ops alert", async () => {
            const notify = (service as any).notificationDispatcher.notify as jest.Mock;
            const slack = (service as any).slackWebhookService.sendWebhookFailureAlert as jest.Mock;

            prismaService.payment.findMany.mockResolvedValue([
                {
                    id: 701,
                    reference: "pay-701",
                    orderId: 901,
                    userId: 88,
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
});
