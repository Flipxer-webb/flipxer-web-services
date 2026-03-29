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
