import { Prisma, TransactionStatus } from "@prisma/client";

import {
    BUY_REFUND_REASON,
    BuyRefundOrchestratorService,
} from "../buy-refund-orchestrator.service";

function makePrisma() {
    return {
        payment: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        refundAttempt: {
            create: jest.fn(),
            update: jest.fn(),
        },
    };
}

describe("BuyRefundOrchestratorService", () => {
    let prisma: ReturnType<typeof makePrisma>;
    let inboundFiatRefundService: {
        initializeRefundTransfer: jest.Mock;
        resolveBankCodeByName: jest.Mock;
    };
    let slackWebhookService: {
        sendWebhookFailureAlert: jest.Mock;
    };
    let service: BuyRefundOrchestratorService;

    beforeEach(() => {
        prisma = makePrisma();
        inboundFiatRefundService = {
            initializeRefundTransfer: jest.fn(),
            resolveBankCodeByName: jest.fn(),
        };
        slackWebhookService = {
            sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined),
        };

        service = new BuyRefundOrchestratorService(
            prisma as never,
            inboundFiatRefundService as never,
            slackWebhookService as never,
        );
    });

    it("escalates to manual review when an active wrong-amount refund amount changes after payout initialization", async () => {
        prisma.payment.findUnique.mockResolvedValue({
            id: 5,
            orderId: 7,
            userId: 3,
            reference: "buy-pay-ref-1",
            senderAccountName: "Tier One QA",
            senderAccountNumber: "1234567890",
            senderBankName: "GTB",
            senderBankCode: "058",
            order: {
                id: 7,
                userId: 3,
                transactionId: "F907E94C2300HD7",
            },
            refundAttempts: [
                {
                    id: 3,
                    orderId: 7,
                    originalPaymentId: 5,
                    payoutPaymentId: 6,
                    provider: "NOMBA",
                    reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                    reference: "refund-ref-1",
                    externalReference: "provider-ref-1",
                    amount: new Prisma.Decimal(31000),
                    status: TransactionStatus.PENDING,
                    destinationBankAccountName: "Tier One QA",
                    destinationBankAccountNumber: "1234567890",
                    destinationBankCode: "058",
                    destinationBankName: "GTB",
                    failureReason: null,
                    retryCount: 0,
                    initiatedAt: new Date("2026-05-06T07:14:45.000Z"),
                    settledAt: null,
                    verifiedAt: null,
                    metadata: {
                        expectedAmount: 32000,
                        receivedAmount: 31000,
                        varianceLabel: "underpayment",
                    },
                    createdAt: new Date("2026-05-06T07:14:45.000Z"),
                    updatedAt: new Date("2026-05-06T07:14:46.000Z"),
                },
            ],
        });

        prisma.refundAttempt.update.mockImplementation(async ({ data }: any) => ({
            id: 3,
            reference: "refund-ref-1",
            amount: new Prisma.Decimal(31000),
            status: data.status,
            payoutPaymentId: 6,
            externalReference: "provider-ref-1",
            failureReason: data.failureReason,
            metadata: data.metadata,
        }));

        const result = await service.ensureRefundPayoutForPayment({
            paymentId: 5,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 33000,
            metadata: {
                expectedAmount: 32000,
                receivedAmount: 33000,
                varianceLabel: "overpayment",
            },
        });

        expect(prisma.payment.update).toHaveBeenCalledWith({
            where: { id: 6 },
            data: {
                status: TransactionStatus.FAILED,
                paymentStatus: TransactionStatus.FAILED,
            },
        });

        const refundAttemptUpdate = prisma.refundAttempt.update.mock.calls[0][0];
        expect(refundAttemptUpdate.where).toEqual({ id: 3 });
        expect(refundAttemptUpdate.data.status).toBe(TransactionStatus.FAILED);
        expect(refundAttemptUpdate.data.failureReason).toContain(
            "Automatic provider reissue is not supported; manual review required.",
        );
        expect(refundAttemptUpdate.data.metadata).toMatchObject({
            expectedAmount: 32000,
            receivedAmount: 33000,
            varianceLabel: "overpayment",
            previousRefundAmount: 31000,
            latestRequestedRefundAmount: 33000,
            providerInitializedAmount: 31000,
            providerPayoutEscalated: true,
        });
        expect(inboundFiatRefundService.initializeRefundTransfer).not.toHaveBeenCalled();
        expect(slackWebhookService.sendWebhookFailureAlert).toHaveBeenCalledWith(
            "nomba",
            "refund-ref-1",
            expect.stringContaining("manual review"),
            expect.objectContaining({
                amount: 33000,
                reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            }),
        );
        expect(result).toMatchObject({
            id: 3,
            reference: "refund-ref-1",
            status: TransactionStatus.FAILED,
        });
        expect(result?.amount.toString()).toBe("31000");
    });

    it("refreshes an existing active wrong-amount refund attempt when the amount changes before provider payout initialization", async () => {
        prisma.payment.findUnique.mockResolvedValue({
            id: 5,
            orderId: 7,
            userId: 3,
            reference: "buy-pay-ref-1",
            senderAccountName: "Tier One QA",
            senderAccountNumber: "1234567890",
            senderBankName: "GTB",
            senderBankCode: "058",
            order: {
                id: 7,
                userId: 3,
                transactionId: "F907E94C2300HD7",
            },
            refundAttempts: [
                {
                    id: 3,
                    orderId: 7,
                    originalPaymentId: 5,
                    payoutPaymentId: null,
                    provider: "NOMBA",
                    reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
                    reference: "refund-ref-1",
                    externalReference: null,
                    amount: new Prisma.Decimal(31000),
                    status: TransactionStatus.PENDING,
                    destinationBankAccountName: "Tier One QA",
                    destinationBankAccountNumber: "1234567890",
                    destinationBankCode: "058",
                    destinationBankName: "GTB",
                    failureReason: null,
                    retryCount: 0,
                    initiatedAt: null,
                    settledAt: null,
                    verifiedAt: null,
                    metadata: {
                        expectedAmount: 32000,
                        receivedAmount: 31000,
                        varianceLabel: "underpayment",
                    },
                    createdAt: new Date("2026-05-06T07:14:45.000Z"),
                    updatedAt: new Date("2026-05-06T07:14:46.000Z"),
                },
            ],
        });

        prisma.refundAttempt.update.mockImplementation(async ({ data }: any) => ({
            id: 3,
            reference: "refund-ref-1",
            amount: data.amount,
            status: TransactionStatus.PENDING,
            payoutPaymentId: null,
            externalReference: null,
            destinationBankAccountName: data.destinationBankAccountName,
            destinationBankAccountNumber: data.destinationBankAccountNumber,
            destinationBankCode: data.destinationBankCode,
            destinationBankName: data.destinationBankName,
            metadata: data.metadata,
        }));

        const result = await service.ensureRefundPayoutForPayment({
            paymentId: 5,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 33000,
            metadata: {
                expectedAmount: 32000,
                receivedAmount: 33000,
                varianceLabel: "overpayment",
            },
        });

        expect(prisma.payment.update).not.toHaveBeenCalled();
        const refundAttemptUpdate = prisma.refundAttempt.update.mock.calls[0][0];
        expect(refundAttemptUpdate.data.amount.toString()).toBe("33000");
        expect(refundAttemptUpdate.data.metadata).toMatchObject({
            expectedAmount: 32000,
            receivedAmount: 33000,
            varianceLabel: "overpayment",
            previousRefundAmount: 31000,
        });
        expect(slackWebhookService.sendWebhookFailureAlert).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            id: 3,
            reference: "refund-ref-1",
            status: TransactionStatus.PENDING,
        });
        expect(result?.amount.toString()).toBe("33000");
    });

    it("returns a settled refund attempt unchanged", async () => {
        const settledAttempt = {
            id: 3,
            orderId: 7,
            originalPaymentId: 5,
            payoutPaymentId: 6,
            provider: "NOMBA",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            reference: "refund-ref-1",
            externalReference: "provider-ref-1",
            amount: new Prisma.Decimal(31000),
            status: TransactionStatus.SUCCESS,
            destinationBankAccountName: "Tier One QA",
            destinationBankAccountNumber: "1234567890",
            destinationBankCode: "058",
            destinationBankName: "GTB",
            failureReason: null,
            retryCount: 0,
            initiatedAt: new Date("2026-05-06T07:14:45.000Z"),
            settledAt: new Date("2026-05-06T07:22:27.000Z"),
            verifiedAt: new Date("2026-05-06T07:22:27.000Z"),
            metadata: null,
            createdAt: new Date("2026-05-06T07:14:45.000Z"),
            updatedAt: new Date("2026-05-06T07:22:27.000Z"),
        };

        prisma.payment.findUnique.mockResolvedValue({
            id: 5,
            orderId: 7,
            userId: 3,
            reference: "buy-pay-ref-1",
            senderAccountName: "Tier One QA",
            senderAccountNumber: "1234567890",
            senderBankName: "GTB",
            senderBankCode: "058",
            order: {
                id: 7,
                userId: 3,
                transactionId: "F907E94C2300HD7",
            },
            refundAttempts: [settledAttempt],
        });

        const result = await service.ensureRefundPayoutForPayment({
            paymentId: 5,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT,
            refundAmount: 33000,
            metadata: {
                expectedAmount: 32000,
                receivedAmount: 33000,
                varianceLabel: "overpayment",
            },
        });

        expect(prisma.payment.update).not.toHaveBeenCalled();
        expect(prisma.refundAttempt.update).not.toHaveBeenCalled();
        expect(result).toBe(settledAttempt);
    });

    it("creates a new refund attempt for each separate payment that arrives after closure", async () => {
        prisma.payment.findUnique.mockResolvedValue({
            id: 5,
            orderId: 7,
            userId: 3,
            reference: "buy-pay-ref-1",
            senderAccountName: "Tier One QA",
            senderAccountNumber: "1234567890",
            senderBankName: "GTB",
            senderBankCode: "058",
            order: {
                id: 7,
                userId: 3,
                transactionId: "F907E94C2300HD7",
            },
            refundAttempts: [
                {
                    id: 3,
                    orderId: 7,
                    originalPaymentId: 5,
                    payoutPaymentId: 6,
                    provider: "NOMBA",
                    reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
                    reference: "refund-ref-1",
                    externalReference: "provider-ref-1",
                    amount: new Prisma.Decimal(31000),
                    status: TransactionStatus.PENDING,
                    destinationBankAccountName: "Tier One QA",
                    destinationBankAccountNumber: "1234567890",
                    destinationBankCode: "058",
                    destinationBankName: "GTB",
                    failureReason: null,
                    retryCount: 0,
                    initiatedAt: new Date("2026-05-06T07:14:45.000Z"),
                    settledAt: null,
                    verifiedAt: null,
                    metadata: {
                        closedOrder: true,
                        closedOrderReason: "invalid_payment_cap_reached",
                    },
                    createdAt: new Date("2026-05-06T07:14:45.000Z"),
                    updatedAt: new Date("2026-05-06T07:14:46.000Z"),
                },
            ],
        });

        prisma.refundAttempt.create.mockResolvedValue({
            id: 4,
            reference: "refund-ref-2",
            metadata: {
                closedOrder: true,
                closedOrderReason: "invalid_payment_cap_reached",
            },
        });
        inboundFiatRefundService.initializeRefundTransfer.mockResolvedValue({
            paymentId: 9,
            externalReference: "API-TRANSFER-2",
            providerReference: "provider-ref-2",
        });
        prisma.refundAttempt.update.mockImplementation(async ({ where, data }: any) => ({
            id: where.id,
            reference: "refund-ref-2",
            payoutPaymentId: data.payoutPaymentId,
            externalReference: data.externalReference,
            providerReference: data.providerReference,
            metadata: {
                closedOrder: true,
                closedOrderReason: "invalid_payment_cap_reached",
            },
        }));

        const result = await service.ensureRefundPayoutForPayment({
            paymentId: 5,
            provider: "nomba",
            reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
            refundAmount: 33000,
            metadata: {
                closedOrder: true,
                closedOrderReason: "invalid_payment_cap_reached",
            },
        });

        expect(prisma.refundAttempt.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    reasonCode: BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT,
                    amount: new Prisma.Decimal(33000),
                }),
            }),
        );
        expect(inboundFiatRefundService.initializeRefundTransfer).toHaveBeenCalledWith(
            expect.objectContaining({
                refundAttemptId: 4,
                reference: "refund-ref-2",
                amount: 33000,
            }),
        );
        expect(prisma.refundAttempt.update).toHaveBeenCalledWith({
            where: { id: 4 },
            data: {
                payoutPaymentId: 9,
                externalReference: "API-TRANSFER-2",
                providerReference: "provider-ref-2",
                initiatedAt: expect.any(Date),
                metadata: expect.objectContaining({
                    closedOrder: true,
                    closedOrderReason: "invalid_payment_cap_reached",
                    providerReference: "provider-ref-2",
                    providerLinkState: "accepted_on_init",
                    providerLinkSource: "refund_init_response",
                    providerLinkExternalReference: "API-TRANSFER-2",
                    providerLinkProviderReference: "provider-ref-2",
                    providerLinkMerchantReference: "refund-ref-2",
                    providerTerminalStatus: "pending",
                }),
            },
        });
        expect(result).toMatchObject({
            id: 4,
            reference: "refund-ref-2",
            payoutPaymentId: 9,
            externalReference: "API-TRANSFER-2",
            providerReference: "provider-ref-2",
            metadata: {
                closedOrder: true,
                closedOrderReason: "invalid_payment_cap_reached",
            },
        });
    });
});