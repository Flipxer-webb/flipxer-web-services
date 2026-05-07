import { Prisma, TransactionStatus } from "@prisma/client";

import {
    BUY_REFUND_REASON,
} from "../buy-refund-orchestrator.service";
import { BuyRefundReconciliationService } from "../buy-refund-reconciliation.service";

function createAttempt(reasonCode: string) {
    return {
        id: 11,
        reasonCode,
        reference: "refund-attempt-ref-1",
        externalReference: "provider-ref-1",
        providerReference: null,
        metadata: null,
        status: TransactionStatus.PENDING,
        amount: new Prisma.Decimal(6400),
        destinationBankAccountNumber: "1234567890",
        destinationBankName: "GTB",
        destinationBankAccountName: "Tier1 TestUser",
        failureReason: null,
        payoutPaymentId: 22,
        provider: "NOMBA",
        initiatedAt: new Date("2026-05-06T15:00:00.000Z"),
        verifiedAt: null,
        createdAt: new Date("2026-05-06T15:00:00.000Z"),
        updatedAt: new Date("2026-05-06T15:00:00.000Z"),
        settledAt: null,
        order: {
            id: 21,
            userId: 3,
            orderCategory: "BUY",
            status: "reversed",
            streamlinedStatus: "cancelled",
            paymentStatus: "REVERSAL",
            transactionId: "GF4CBFE805A0136",
            amount: 4,
            currency: "USDT",
            createdAt: new Date("2026-05-06T15:00:00.000Z"),
            updatedAt: new Date("2026-05-06T15:00:00.000Z"),
            user: {
                id: 3,
                email: "tier1.test@flipxer.local",
            },
        },
    };
}

describe("BuyRefundReconciliationService", () => {
    let service: BuyRefundReconciliationService;
    let prisma: {
        payment: {
            update: jest.Mock;
        };
        refundAttempt: {
            findMany: jest.Mock;
            update: jest.Mock;
        };
    };
    let inboundFiatRefundService: {
        verifyRefundTransfer: jest.Mock;
    };
    let notificationDispatcher: { notify: jest.Mock };
    let wsGateway: { notifyTransactionUpdate: jest.Mock };
    let slackWebhookService: { sendWebhookFailureAlert: jest.Mock };

    beforeEach(() => {
        prisma = {
            payment: {
                update: jest.fn(),
            },
            refundAttempt: {
                findMany: jest.fn(),
                update: jest.fn(),
            },
        };
        inboundFiatRefundService = {
            verifyRefundTransfer: jest.fn(),
        };
        notificationDispatcher = {
            notify: jest.fn().mockResolvedValue(undefined),
        };
        wsGateway = {
            notifyTransactionUpdate: jest.fn(),
        };
        slackWebhookService = {
            sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined),
        };

        service = new BuyRefundReconciliationService(
            prisma as never,
            inboundFiatRefundService as never,
            notificationDispatcher as never,
            wsGateway as never,
            slackWebhookService as never,
        );
    });

    it("backfills the merchant reference before verifying pending Nomba refunds", async () => {
        prisma.refundAttempt.findMany
            .mockResolvedValueOnce([
                {
                    id: 11,
                    reference: "refund-attempt-ref-1",
                    externalReference: "API-TRANSFER-1",
                    providerReference: null,
                    metadata: null,
                    payoutPaymentId: 22,
                    initiatedAt: new Date("2026-05-06T15:00:00.000Z"),
                    createdAt: new Date("2026-05-06T15:00:00.000Z"),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 11,
                    provider: "NOMBA",
                    reference: "refund-attempt-ref-1",
                    externalReference: "API-TRANSFER-1",
                    providerReference: "refund-attempt-ref-1",
                    metadata: {
                        providerReference: "refund-attempt-ref-1",
                    },
                    payoutPaymentId: 22,
                    initiatedAt: new Date("2026-05-06T15:00:00.000Z"),
                    createdAt: new Date("2026-05-06T15:00:00.000Z"),
                },
            ]);
        inboundFiatRefundService.verifyRefundTransfer.mockResolvedValue({
            status: "pending",
            data: {
                id: "API-TRANSFER-1",
                meta: {
                    merchantTxRef: "refund-attempt-ref-1",
                },
            },
        });
        prisma.refundAttempt.update.mockResolvedValue({ id: 11 });
        prisma.payment.update.mockResolvedValue({ id: 22 });

        const result = await service.verifyPendingRefundAttempts();

        expect(result).toEqual({ checked: 1, succeeded: 0, failed: 0 });
        expect(prisma.refundAttempt.update).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                where: { id: 11 },
                data: expect.objectContaining({
                    providerReference: "refund-attempt-ref-1",
                    metadata: expect.objectContaining({
                        providerReference: "refund-attempt-ref-1",
                        providerLinkState: "accepted_on_init",
                        providerLinkSource: "legacy_reference_backfill",
                        providerLinkProviderReference:
                            "refund-attempt-ref-1",
                        providerLinkMerchantReference:
                            "refund-attempt-ref-1",
                    }),
                }),
            }),
        );
        expect(prisma.payment.update).toHaveBeenCalledWith({
            where: { id: 22 },
            data: {
                providerAccountReference: "refund-attempt-ref-1",
                externalReference: "API-TRANSFER-1",
            },
        });
        expect(inboundFiatRefundService.verifyRefundTransfer).toHaveBeenCalledWith({
            provider: "nomba",
            reference: "refund-attempt-ref-1",
            externalReference: "API-TRANSFER-1",
            providerReference: "refund-attempt-ref-1",
        });
        expect(prisma.refundAttempt.update).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: { id: 11 },
                data: expect.objectContaining({
                    verifiedAt: expect.any(Date),
                    externalReference: "API-TRANSFER-1",
                    providerReference: "refund-attempt-ref-1",
                }),
            }),
        );
    });

    it("records delayed lookup diagnostics when Nomba still returns 404 after init", async () => {
        const initiatedAt = new Date(Date.now() - 2 * 60 * 1000);

        prisma.refundAttempt.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: 11,
                    provider: "NOMBA",
                    reference: "refund-attempt-ref-1",
                    externalReference: "API-TRANSFER-1",
                    providerReference: "refund-attempt-ref-1",
                    metadata: {
                        providerLinkState: "accepted_on_init",
                        providerLinkedAt: initiatedAt.toISOString(),
                    },
                    payoutPaymentId: 22,
                    initiatedAt,
                    createdAt: initiatedAt,
                },
            ]);
        inboundFiatRefundService.verifyRefundTransfer.mockRejectedValue(
            new Error("Nomba refund transfer lookup failed with status 404"),
        );
        prisma.refundAttempt.update.mockResolvedValue({ id: 11 });
        prisma.payment.update.mockResolvedValue({ id: 22 });

        const result = await service.verifyPendingRefundAttempts();

        expect(result).toEqual({ checked: 1, succeeded: 0, failed: 0 });
        expect(prisma.refundAttempt.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 11 },
                data: expect.objectContaining({
                    verifiedAt: expect.any(Date),
                    providerReference: "refund-attempt-ref-1",
                    metadata: expect.objectContaining({
                        providerLinkState: "accepted_on_init",
                        providerLinkProviderReference:
                            "refund-attempt-ref-1",
                        providerLinkMerchantReference:
                            "refund-attempt-ref-1",
                        providerTerminalStatus: "pending",
                        nombaLookupDiagnostics: expect.objectContaining({
                            notFoundCount: 1,
                            visibilityState:
                                "eventual_consistency_window",
                            withinGraceWindow: true,
                            lastAttemptedCandidates: [
                                "transfer-id:API-TRANSFER-1",
                                "merchant-ref:refund-attempt-ref-1",
                            ],
                        }),
                    }),
                }),
            }),
        );
    });

    it("uses generic integrated refund messaging for account-name mismatch refunds", async () => {
        await service.executeRefundSideEffects({
            provider: "nomba",
            status: TransactionStatus.SUCCESS,
            attempt: createAttempt(BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH),
        } as any);

        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 3,
                title: "Invalid payment refunded",
                body: expect.stringContaining(
                    "from a bank account that matches your registered name",
                ),
                emailPayload: expect.objectContaining({
                    status: "refunded",
                }),
            }),
        );
        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            3,
            expect.objectContaining({
                transaction: expect.objectContaining({
                    streamlinedStatus: "refunded",
                }),
            }),
        );
        expect(slackWebhookService.sendWebhookFailureAlert).not.toHaveBeenCalled();
    });

    it("uses closed invalid-payment refund messaging for payments that arrive after retry-cap closure", async () => {
        await service.executeRefundSideEffects({
            provider: "nomba",
            status: TransactionStatus.SUCCESS,
            attempt: createAttempt(BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT),
        } as any);

        expect(notificationDispatcher.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 3,
                title: "Invalid payment refunded",
                body: expect.stringContaining(
                    "already been closed after repeated invalid payments",
                ),
                emailPayload: expect.objectContaining({
                    status: "refunded",
                }),
            }),
        );
    });

    it("does not notify the user when a cancelled-order payment refund settles", async () => {
        await service.executeRefundSideEffects({
            provider: "nomba",
            status: TransactionStatus.SUCCESS,
            attempt: createAttempt(BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT),
        } as any);

        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(wsGateway.notifyTransactionUpdate).toHaveBeenCalledWith(
            3,
            expect.objectContaining({
                type: "transaction_update",
            }),
        );
    });

    it("does not notify the user when a cancelled-order payment refund fails, but still alerts ops", async () => {
        await service.executeRefundSideEffects({
            provider: "nomba",
            status: TransactionStatus.FAILED,
            attempt: {
                ...createAttempt(BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT),
                failureReason: "Provider refund payout failed",
            },
        } as any);

        expect(notificationDispatcher.notify).not.toHaveBeenCalled();
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "refund-attempt-ref-1",
            expect.stringContaining("Manual review required"),
            expect.objectContaining({
                orderId: 21,
                userId: 3,
                reasonCode: BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT,
            }),
        );
    });
});