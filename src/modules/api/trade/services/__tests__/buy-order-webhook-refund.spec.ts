import { Test, TestingModule } from "@nestjs/testing";
import { OrderCategory, OrderStatus, TransactionStatus } from "@prisma/client";

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
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class {
            readonly __stub = true;
        },
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
import {
    BUY_REFUND_REASON,
    BuyRefundOrchestratorService,
} from "../buy-refund-orchestrator.service";

function makePrisma() {
    return {
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
        refundAttempt: {
            update: jest.fn(),
        },
        $transaction: jest.fn(),
    };
}

describe("BuyOrderService BUY webhook refund behavior", () => {
    let service: BuyOrderService;
    let prismaService: ReturnType<typeof makePrisma>;
    let wsGateway: { notifyTransactionUpdate: jest.Mock; notifyWalletUpdate: jest.Mock };
    let slackWebhookService: { sendWebhookFailureAlert: jest.Mock };
    let notificationDispatcher: { notify: jest.Mock };
    let transactionService: { releaseDailyLimitReservationForOrder: jest.Mock };
    let buyRefundOrchestratorService: {
        ensureRefundPayoutForPayment: jest.Mock;
    };

    beforeEach(async () => {
        prismaService = makePrisma();
        wsGateway = {
            notifyTransactionUpdate: jest.fn(),
            notifyWalletUpdate: jest.fn(),
        };
        slackWebhookService = {
            sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined),
        };
        notificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };
        transactionService = {
            releaseDailyLimitReservationForOrder: jest
                .fn()
                .mockResolvedValue(undefined),
        };
        buyRefundOrchestratorService = {
            ensureRefundPayoutForPayment: jest.fn().mockResolvedValue({
                id: 7001,
                reference: "refund-attempt-1",
                status: TransactionStatus.PENDING,
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                BuyOrderService,
                { provide: PrismaService, useValue: prismaService },
                {
                    provide: InboundFiatPaymentService,
                    useValue: {
                        initializePayment: jest.fn(),
                        cleanupPendingPayment: jest.fn().mockResolvedValue(true),
                    },
                },
                {
                    provide: WalletAddressService,
                    useValue: { syncWallet: jest.fn().mockResolvedValue(undefined) },
                },
                { provide: WsGateway, useValue: wsGateway },
                {
                    provide: TradeHelpersService,
                    useValue: {
                        calculateFee: jest.fn(),
                        ensureSupportedTradeAsset: jest.fn((asset: string) => asset),
                        validateMinimumAmountInUSDT: jest.fn().mockResolvedValue(undefined),
                        normalizeNetworkInput: jest.fn(),
                    },
                },
                { provide: SlackWebhookService, useValue: slackWebhookService },
                { provide: LedgerService, useValue: { pairedCredit: jest.fn() } },
                {
                    provide: RateService,
                    useValue: { getAssetRate: jest.fn() },
                },
                { provide: NotificationDispatcher, useValue: notificationDispatcher },
                {
                    provide: DistributedLockService,
                    useValue: { withLock: jest.fn((_: string, fn: () => unknown) => fn()) },
                },
                { provide: TransactionService, useValue: transactionService },
                {
                    provide: BuyRefundOrchestratorService,
                    useValue: buyRefundOrchestratorService,
                },
            ],
        }).compile();

        service = module.get(BuyOrderService);
    });

    it("keeps active wrong-amount payments open for resend and flags the refund attempt", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
        prismaService.payment.findUnique.mockResolvedValue({
            id: 811,
            orderId: 911,
            userId: 61,
            totalAmount: "100000",
            receivedAmount: "90000",
            reference: "active-wrong-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [],
            order: {
                id: 911,
                amount: 0.05,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-ACTIVE-WRONG-1",
            },
            user: { id: 61, email: "wrong@flipxer.com" },
        });

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 811,
                orderId: 911,
                userId: 61,
                totalAmount: "100000",
                reference: "active-wrong-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 90000,
                providerReference: "prov-active-wrong-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Sender One",
                senderBankName: "Bank One",
            } as any,
            reference: "active-wrong-ref",
            provider: "nomba",
        });

        expect(prismaService.payment.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 61,
                title: "Incorrect payment amount received",
                body: expect.stringContaining(
                    "Your order remains open until the payment window expires",
                ),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 811,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 90000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 90000,
                varianceLabel: "underpayment",
                wrongAmountRetryCount: 0,
                combinedInvalidPaymentCount: 1,
            },
        });
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "active-wrong-ref",
            expect.stringContaining("order remains open for resend"),
            expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 90000,
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("closes an active buy after the maximum wrong-amount resend cap is reached", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);
        const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const orderUpdate = jest.fn().mockResolvedValue(undefined);

        prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
        prismaService.payment.findUnique.mockResolvedValue({
            id: 813,
            orderId: 913,
            userId: 63,
            totalAmount: "100000",
            receivedAmount: "95000",
            reference: "active-cap-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.REVERSAL,
            senderAccountNumber: "0123456789",
            senderAccountName: "Sender One",
            senderBankName: "Bank One",
            refundAttempts: [
                {
                    id: 7002,
                    reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                    retryCount: 1,
                },
            ],
            order: {
                id: 913,
                amount: 0.05,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-ACTIVE-CAP-1",
            },
            user: { id: 63, email: "retrycap@flipxer.com" },
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: paymentUpdateMany,
                },
                order: {
                    update: orderUpdate,
                },
            }),
        );
        buyRefundOrchestratorService.ensureRefundPayoutForPayment.mockResolvedValue({
            id: 7002,
            reference: "refund-attempt-cap-1",
            status: TransactionStatus.FAILED,
        });

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 813,
                orderId: 913,
                userId: 63,
                totalAmount: "100000",
                reference: "active-cap-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 95000,
                providerReference: "prov-active-cap-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Sender One",
                senderBankName: "Bank One",
            } as any,
            reference: "active-cap-ref",
            provider: "nomba",
        });

        expect(prismaService.refundAttempt.update).toHaveBeenCalledWith({
            where: { id: 7002 },
            data: { retryCount: 2 },
        });
        expect(paymentUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(orderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.reversed,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(
            transactionService.releaseDailyLimitReservationForOrder,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 63,
                currency: "BTC",
                amount: 0.05,
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 813,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 95000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 95000,
                varianceLabel: "underpayment",
                wrongAmountRetryCount: 2,
                combinedInvalidPaymentCount: 3,
                maxWrongAmountResendsReached: true,
                combinedInvalidPaymentCapReached: true,
                orderClosedByRetryCap: true,
            },
        });
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 63,
                title: "Buy order closed after repeated incorrect payments",
                body: expect.stringContaining(
                    "maximum wrong-amount resend limit has been reached",
                ),
                emailPayload: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
        );
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "active-cap-ref",
            expect.stringContaining("Maximum wrong-amount resend cap reached"),
            expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 95000,
                retryCount: 2,
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("closes expired late payments as refunded and releases the reserved BUY limit", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);
        const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const orderUpdate = jest.fn().mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 812,
            orderId: 912,
            userId: 62,
            totalAmount: "100000",
            receivedAmount: "100000",
            reference: "late-pay-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.PENDING,
            order: {
                id: 912,
                amount: 0.07,
                currency: "BTC",
                status: OrderStatus.pending,
                orderCategory: OrderCategory.BUY,
                transactionId: "TX-LATE-1",
            },
            user: { id: 62, email: "late@flipxer.com" },
            createdAt: new Date(Date.now() - 40 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: paymentUpdateMany,
                    update: jest.fn().mockResolvedValue(undefined),
                },
                order: {
                    update: orderUpdate,
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 812,
                orderId: 912,
                userId: 62,
                totalAmount: "100000",
                reference: "late-pay-ref",
                createdAt: new Date(Date.now() - 40 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 100000,
                providerReference: "prov-late-1",
                senderAccountNumber: "0987654321",
                senderAccountName: "Late Sender",
                senderBankName: "Refund Bank",
            } as any,
            reference: "late-pay-ref",
            provider: "nomba",
        });

        expect(paymentUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(orderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.reversed,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(
            transactionService.releaseDailyLimitReservationForOrder,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 62,
                currency: "BTC",
                amount: 0.07,
            }),
        );
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 62,
                title: "Buy order expired",
                body: expect.stringContaining(
                    "after the payment window expired. The order is now closed.",
                ),
                emailPayload: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 812,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.EXPIRED_LATE_PAYMENT,
            refundAmount: 100000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 100000,
                closedOrder: true,
                closedOrderReason: "payment_window_expired",
            },
        });
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "late-pay-ref",
            expect.stringContaining("Order closed as refunded"),
            expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 100000,
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("refunds a late payment after user cancellation without sending another user notification", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 814,
            orderId: 914,
            userId: 64,
            totalAmount: "100000",
            receivedAmount: "100000",
            reference: "late-after-cancel-ref",
            status: TransactionStatus.FAILED,
            paymentStatus: TransactionStatus.FAILED,
            order: {
                id: 914,
                amount: 0.09,
                currency: "BTC",
                status: OrderStatus.cancelled,
                orderCategory: OrderCategory.BUY,
                reason: "Buy order cancelled by user before payment was received.",
                transactionId: "TX-LATE-CANCEL-1",
            },
            user: { id: 64, email: "latecancel@flipxer.com" },
            createdAt: new Date(Date.now() - 45 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                    update: jest.fn().mockResolvedValue(undefined),
                },
                order: {
                    update: jest.fn().mockResolvedValue(undefined),
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 814,
                orderId: 914,
                userId: 64,
                totalAmount: "100000",
                reference: "late-after-cancel-ref",
                createdAt: new Date(Date.now() - 45 * 60 * 1000),
                status: TransactionStatus.FAILED,
                paymentStatus: TransactionStatus.FAILED,
            },
            event: {
                amount: 100000,
                providerReference: "prov-late-cancel-1",
                senderAccountNumber: "0987654321",
                senderAccountName: "Late Sender",
                senderBankName: "Refund Bank",
            } as any,
            reference: "late-after-cancel-ref",
            provider: "nomba",
        });

        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 814,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
            refundAmount: 100000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 100000,
                closedOrder: true,
                closedOrderReason: "user_cancelled",
            },
        });
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("preserves the user-cancelled classification for repeated post-cancel payments", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 814,
            orderId: 914,
            userId: 64,
            totalAmount: "100000",
            receivedAmount: "100000",
            reference: "late-after-cancel-ref",
            status: TransactionStatus.REVERSAL,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [
                {
                    id: 8001,
                    reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
                },
            ],
            order: {
                id: 914,
                amount: 0.09,
                currency: "BTC",
                status: OrderStatus.reversed,
                orderCategory: OrderCategory.BUY,
                reason: "Payment received after order cancellation: received ₦100000 for expected ₦100000. Refund initiated and order remains closed.",
                transactionId: "TX-LATE-CANCEL-1",
            },
            user: { id: 64, email: "latecancel@flipxer.com" },
            createdAt: new Date(Date.now() - 45 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                    update: jest.fn().mockResolvedValue(undefined),
                },
                order: {
                    update: jest.fn().mockResolvedValue(undefined),
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 814,
                orderId: 914,
                userId: 64,
                totalAmount: "100000",
                reference: "late-after-cancel-ref",
                createdAt: new Date(Date.now() - 45 * 60 * 1000),
                status: TransactionStatus.REVERSAL,
                paymentStatus: TransactionStatus.REVERSAL,
                receivedAmount: "100000",
                externalReference: "prov-late-cancel-1",
            },
            event: {
                amount: 100000,
                providerReference: "prov-late-cancel-2",
                senderAccountNumber: "0987654321",
                senderAccountName: "Late Sender",
                senderBankName: "Refund Bank",
            } as any,
            reference: "late-after-cancel-ref",
            provider: "nomba",
        });

        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 814,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
            refundAmount: 100000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 100000,
                closedOrder: true,
                closedOrderReason: "user_cancelled",
            },
        });
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("refunds a payment that arrives after retry-cap closure without sending another user notification", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 816,
            orderId: 916,
            userId: 66,
            totalAmount: "100000",
            receivedAmount: "95000",
            reference: "after-cap-closed-ref",
            status: TransactionStatus.REVERSAL,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [
                {
                    id: 8002,
                    reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
                },
            ],
            order: {
                id: 916,
                amount: 0.08,
                currency: "BTC",
                status: OrderStatus.reversed,
                orderCategory: OrderCategory.BUY,
                reason: "Payment received after invalid-payment cap closure: received ₦100000 for expected ₦100000. Refund initiated and order remains closed.",
                transactionId: "TX-AFTER-CAP-1",
            },
            user: { id: 66, email: "aftercap@flipxer.com" },
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
                    update: jest.fn().mockResolvedValue(undefined),
                },
                order: {
                    update: jest.fn().mockResolvedValue(undefined),
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 816,
                orderId: 916,
                userId: 66,
                totalAmount: "100000",
                reference: "after-cap-closed-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.REVERSAL,
                paymentStatus: TransactionStatus.REVERSAL,
                receivedAmount: "95000",
                externalReference: "prov-cap-close-old",
            },
            event: {
                amount: 100000,
                providerReference: "prov-after-cap-1",
                senderAccountNumber: "0987654321",
                senderAccountName: "Late Sender",
                senderBankName: "Refund Bank",
            } as any,
            reference: "after-cap-closed-ref",
            provider: "nomba",
        });

        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 816,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
            refundAmount: 100000,
            metadata: {
                expectedAmount: 100000,
                receivedAmount: 100000,
                closedOrder: true,
                closedOrderReason: "invalid_payment_cap_reached",
            },
        });
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "after-cap-closed-ref",
            expect.stringContaining("invalid-payment resend cap"),
            expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 100000,
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("uses the business account name for BUSINESS users during exact-payment name validation", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 820,
            orderId: 920,
            userId: 70,
            totalAmount: "100000",
            reference: "business-name-match-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.PENDING,
            refundAttempts: [],
            senderAccountName: null,
            order: {
                id: 920,
                amount: 0.2,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-BUSINESS-NAME-1",
            },
            user: {
                id: 70,
                email: "business@flipxer.com",
                firstName: "Owner",
                lastName: "Name",
                middleName: null,
                businessName: "Acme Digital Ltd",
                userType: "BUSINESS",
            },
        });
        prismaService.payment.update.mockResolvedValue(undefined);

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 820,
                orderId: 920,
                userId: 70,
                totalAmount: "100000",
                reference: "business-name-match-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 100000,
                providerReference: "prov-business-name-match-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Acme Digital Ltd",
                senderBankName: "Match Bank",
            } as any,
            reference: "business-name-match-ref",
            provider: "nomba",
        });

        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).not.toHaveBeenCalled();
        expect(fulfillSpy).toHaveBeenCalledWith("business-name-match-ref");
    });

    it("keeps account-name mismatches open for resend and flags the refund attempt", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
        prismaService.payment.findUnique.mockResolvedValue({
            id: 815,
            orderId: 915,
            userId: 65,
            totalAmount: "100000",
            receivedAmount: "100000",
            reference: "name-mismatch-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.PENDING,
            refundAttempts: [],
            order: {
                id: 915,
                amount: 0.1,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-NAME-MISMATCH-1",
            },
            user: {
                id: 65,
                email: "namemismatch@flipxer.com",
                firstName: "Test",
                lastName: "User",
                middleName: null,
                businessName: null,
                userType: "INDIVIDUAL",
            },
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
        });

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 815,
                orderId: 915,
                userId: 65,
                totalAmount: "100000",
                reference: "name-mismatch-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 100000,
                providerReference: "prov-name-mismatch-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Different Person",
                senderBankName: "Mismatch Bank",
            } as any,
            reference: "name-mismatch-ref",
            provider: "nomba",
        });

        expect(prismaService.payment.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 815,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
            refundAmount: 100000,
            metadata: expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 100000,
                registeredAccountName: "Test User",
                senderAccountName: "Different Person",
                nameMatchPolicy: "token-subset-fuzzy-v1",
                nameMismatchRetryCount: 0,
                combinedInvalidPaymentCount: 1,
            }),
        });
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 65,
                title: "Invalid payment received",
                body: expect.stringContaining(
                    "did not meet the validation requirements",
                ),
                emailPayload: expect.objectContaining({
                    status: "pending",
                }),
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("closes an active buy after repeated account-name mismatches reach the resend cap", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);
        const paymentRetryCapUpdateMany = jest
            .fn()
            .mockResolvedValue({ count: 1 });
        const orderUpdate = jest.fn().mockResolvedValue(undefined);

        prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
        prismaService.payment.findUnique.mockResolvedValue({
            id: 817,
            orderId: 917,
            userId: 67,
            totalAmount: "100000",
            receivedAmount: "100000",
            reference: "name-mismatch-cap-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.REVERSAL,
            senderAccountNumber: "0123456789",
            senderAccountName: "Different Person",
            senderBankName: "Mismatch Bank",
            refundAttempts: [
                {
                    id: 7003,
                    reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                    retryCount: 1,
                },
            ],
            order: {
                id: 917,
                amount: 0.1,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-NAME-MISMATCH-CAP-1",
            },
            user: {
                id: 67,
                email: "namemismatchcap@flipxer.com",
                firstName: "Test",
                lastName: "User",
                middleName: null,
                businessName: null,
                userType: "INDIVIDUAL",
            },
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: paymentRetryCapUpdateMany,
                },
                order: {
                    update: orderUpdate,
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 817,
                orderId: 917,
                userId: 67,
                totalAmount: "100000",
                reference: "name-mismatch-cap-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 100000,
                providerReference: "prov-name-mismatch-cap-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Different Person",
                senderBankName: "Mismatch Bank",
            } as any,
            reference: "name-mismatch-cap-ref",
            provider: "nomba",
        });

        expect(prismaService.refundAttempt.update).toHaveBeenCalledWith({
            where: { id: 7003 },
            data: { retryCount: 2 },
        });
        expect(paymentRetryCapUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(orderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.reversed,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 817,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
            refundAmount: 100000,
            metadata: expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 100000,
                registeredAccountName: "Test User",
                senderAccountName: "Different Person",
                nameMismatchRetryCount: 2,
                combinedInvalidPaymentCount: 3,
                maxNameMismatchResendsReached: true,
                combinedInvalidPaymentCapReached: true,
                orderClosedByRetryCap: true,
            }),
        });
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 67,
                title: "Buy order closed after repeated invalid payments",
                emailPayload: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("closes on the third invalid payment even when wrong amount and name mismatch are mixed", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);
        const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
        const orderUpdate = jest.fn().mockResolvedValue(undefined);

        prismaService.payment.updateMany.mockResolvedValue({ count: 1 });
        prismaService.payment.findUnique.mockResolvedValue({
            id: 818,
            orderId: 918,
            userId: 68,
            totalAmount: "100000",
            receivedAmount: "95000",
            reference: "mixed-invalid-cap-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.REVERSAL,
            senderAccountNumber: "0123456789",
            senderAccountName: "Sender One",
            senderBankName: "Bank One",
            refundAttempts: [
                {
                    id: 7004,
                    reasonCode: BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH,
                    retryCount: 0,
                },
                {
                    id: 7005,
                    reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                    retryCount: 0,
                },
            ],
            order: {
                id: 918,
                amount: 0.05,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-MIXED-INVALID-CAP-1",
            },
            user: { id: 68, email: "mixedcap@flipxer.com" },
            createdAt: new Date(Date.now() - 10 * 60 * 1000),
        });
        prismaService.$transaction.mockImplementation(async (cb: any) =>
            cb({
                payment: {
                    updateMany: paymentUpdateMany,
                },
                order: {
                    update: orderUpdate,
                },
            }),
        );

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 818,
                orderId: 918,
                userId: 68,
                totalAmount: "100000",
                reference: "mixed-invalid-cap-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 95000,
                providerReference: "prov-mixed-invalid-cap-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "Sender One",
                senderBankName: "Bank One",
            } as any,
            reference: "mixed-invalid-cap-ref",
            provider: "nomba",
        });

        expect(prismaService.refundAttempt.update).toHaveBeenCalledWith({
            where: { id: 7005 },
            data: { retryCount: 1 },
        });
        expect(paymentUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: TransactionStatus.REVERSAL,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(orderUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: OrderStatus.reversed,
                    paymentStatus: TransactionStatus.REVERSAL,
                }),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).toHaveBeenCalledWith({
            paymentId: 818,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 95000,
            metadata: expect.objectContaining({
                expectedAmount: 100000,
                receivedAmount: 95000,
                wrongAmountRetryCount: 1,
                combinedInvalidPaymentCount: 3,
                maxWrongAmountResendsReached: true,
                combinedInvalidPaymentCapReached: true,
                orderClosedByRetryCap: true,
            }),
        });
        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 68,
                title: "Buy order closed after repeated invalid payments",
                body: expect.stringContaining(
                    "maximum resend limit has been reached",
                ),
            }),
        );
        expect(fulfillSpy).not.toHaveBeenCalled();
    });

    it("allows exact payment completion when the sender name matches fuzzily with reordered names and an extra middle name", async () => {
        const fulfillSpy = jest
            .spyOn(service, "fulfillBuyOrder")
            .mockResolvedValue(undefined);

        prismaService.payment.findUnique.mockResolvedValue({
            id: 816,
            orderId: 916,
            userId: 66,
            totalAmount: "100000",
            reference: "name-match-ref",
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.PENDING,
            refundAttempts: [],
            senderAccountName: null,
            order: {
                id: 916,
                amount: 0.12,
                currency: "BTC",
                status: OrderStatus.pending,
                transactionId: "TX-NAME-MATCH-1",
            },
            user: {
                id: 66,
                email: "namematch@flipxer.com",
                firstName: "Test",
                lastName: "User",
                middleName: null,
                businessName: null,
                userType: "INDIVIDUAL",
            },
        });
        prismaService.payment.update.mockResolvedValue(undefined);

        await service.handleWebhookBuyOrderPayment({
            payment: {
                id: 816,
                orderId: 916,
                userId: 66,
                totalAmount: "100000",
                reference: "name-match-ref",
                createdAt: new Date(Date.now() - 10 * 60 * 1000),
                status: TransactionStatus.PENDING,
                paymentStatus: TransactionStatus.PENDING,
            },
            event: {
                amount: 100000,
                providerReference: "prov-name-match-1",
                senderAccountNumber: "0123456789",
                senderAccountName: "User Middle Test",
                senderBankName: "Match Bank",
            } as any,
            reference: "name-match-ref",
            provider: "nomba",
        });

        expect(prismaService.payment.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 816 },
                data: expect.objectContaining({
                    senderAccountName: "User Middle Test",
                }),
            }),
        );
        expect(
            buyRefundOrchestratorService.ensureRefundPayoutForPayment,
        ).not.toHaveBeenCalled();
        expect(fulfillSpy).toHaveBeenCalledWith("name-match-ref");
    });

    it("returns pending overall status while exposing a refunded payment attempt for wrong-amount resends", async () => {
        prismaService.payment.findFirst.mockResolvedValueOnce({
            status: TransactionStatus.PENDING,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [
                {
                    status: TransactionStatus.PENDING,
                    reference: "refund-ref-8",
                    settledAt: null,
                },
            ],
            order: {
                id: 8,
                status: OrderStatus.pending,
                transactionId: "tx-8",
            },
        });

        await expect(service.getBuyOrderStatus("ref-8", 1)).resolves.toMatchObject({
            data: {
                status: "pending",
                paymentStatus: TransactionStatus.REVERSAL,
                processingStatus: TransactionStatus.PENDING,
                refundStatus: TransactionStatus.PENDING,
                refundReference: "refund-ref-8",
                refundSettledAt: null,
            },
        });
    });

    it("returns refunded only after the latest refund attempt settles successfully", async () => {
        prismaService.payment.findFirst.mockResolvedValueOnce({
            status: TransactionStatus.REVERSAL,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [
                {
                    status: TransactionStatus.SUCCESS,
                    reference: "refund-ref-9",
                    settledAt: new Date("2026-05-06T12:00:00.000Z"),
                },
            ],
            order: {
                id: 9,
                status: OrderStatus.reversed,
                transactionId: "tx-9",
            },
        });

        await expect(service.getBuyOrderStatus("ref-9", 1)).resolves.toMatchObject({
            data: {
                status: "refunded",
                refundStatus: TransactionStatus.SUCCESS,
                refundReference: "refund-ref-9",
            },
        });
    });

    it("returns cancelled for closed BUY orders while refund settlement is still pending", async () => {
        prismaService.payment.findFirst.mockResolvedValueOnce({
            status: TransactionStatus.REVERSAL,
            paymentStatus: TransactionStatus.REVERSAL,
            refundAttempts: [
                {
                    status: TransactionStatus.PENDING,
                    reference: "refund-ref-10",
                    settledAt: null,
                },
            ],
            order: {
                id: 10,
                status: OrderStatus.reversed,
                transactionId: "tx-10",
            },
        });

        await expect(
            service.getBuyOrderStatus("ref-10", 1),
        ).resolves.toMatchObject({
            data: {
                status: "cancelled",
                refundStatus: TransactionStatus.PENDING,
                refundReference: "refund-ref-10",
            },
        });
    });
});