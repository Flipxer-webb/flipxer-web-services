import { FincraWebhookService } from "..";
import { PaymentWebhookAdapterService } from "@/modules/factory/bank/services/payment-webhook-adapter.service";

/* ------------------------------------------------------------------ */
/*  Stub heavy transitive deps                                        */
/* ------------------------------------------------------------------ */
jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        Logger: class {
            log = jest.fn();
            error = jest.fn();
            warn = jest.fn();
            debug = jest.fn();
        },
    };
});

jest.mock("@/modules/core/prisma/services", () => ({
    PrismaService: class {
        isStub() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/banks/services", () => ({
    BankService: class {
        isStub() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/operations/services/slack-webhook.service", () => ({
    SlackWebhookService: class {
        isStub() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/trade/services/sell-payout-reconciliation.service", () => ({
    SellPayoutReconciliationService: class {
        isStub() {
            return true;
        }
    },
}));

/* ------------------------------------------------------------------ */
/*  Mock factories                                                    */
/* ------------------------------------------------------------------ */
function createMockPrisma() {
    const prisma = {
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
        },
        order: {
            findUnique: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({}),
        },
        $transaction: jest.fn(),
    };

    prisma.$transaction.mockImplementation(async (callback: (tx: any) => Promise<unknown>) => (
        callback({
            payment: prisma.payment,
            order: prisma.order,
        })
    ));

    return prisma;
}

function createMockBankService() {
    return {
        paymentSuccessHandler: jest.fn().mockResolvedValue(undefined),
        paymentFailedHandler: jest.fn().mockResolvedValue(undefined),
        processAssetValueTransferToBankHandler: jest.fn().mockResolvedValue(undefined),
    };
}

function createMockSlackService() {
    return {
        sendWebhookFailureAlert: jest.fn().mockResolvedValue(undefined),
    };
}

function createMockSellPayoutReconciliationService() {
    return {
        reconcileSellPayoutState: jest.fn().mockResolvedValue(null),
        executeSellPayoutSideEffects: jest.fn().mockResolvedValue(undefined),
    };
}

/* ------------------------------------------------------------------ */
/*  Test data builders                                                */
/* ------------------------------------------------------------------ */
function chargePayload(event: string, overrides: Record<string, unknown> = {}) {
    return {
        event,
        data: {
            amount: 50000,
            currency: "NGN",
            status: "success",
            reference: "ref-charge-1",
            merchantReference: "mref-1",
            ...overrides,
        },
    };
}

function payoutPayload(event: string, overrides: Record<string, unknown> = {}) {
    return {
        event,
        data: {
            id: "po-1",
            reference: "ref-payout-1",
            customerReference: "cref-1",
            status: "successful",
            amount: 25000,
            fee: 50,
            currency: "NGN",
            ...overrides,
        },
    };
}

function buildPayment(overrides: Record<string, unknown> = {}) {
    return {
        id: 1,
        reference: "cref-1",
        amount: 25000,
        orderId: 100,
        order: {
            id: 100,
            user: { id: 10, email: "user@test.com" },
        },
        user: { id: 10, email: "user@test.com" },
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("PaymentWebhookService", () => {
    let service: FincraWebhookService;
    let prisma: ReturnType<typeof createMockPrisma>;
    let bankService: ReturnType<typeof createMockBankService>;
    let slackService: ReturnType<typeof createMockSlackService>;
    let sellPayoutReconciliationService: ReturnType<typeof createMockSellPayoutReconciliationService>;
    let paymentWebhookAdapterService: PaymentWebhookAdapterService;

    beforeEach(() => {
        prisma = createMockPrisma();
        bankService = createMockBankService();
        slackService = createMockSlackService();
        sellPayoutReconciliationService = createMockSellPayoutReconciliationService();
        paymentWebhookAdapterService = new PaymentWebhookAdapterService();
        service = new FincraWebhookService(
            prisma as any,
            bankService as any,
            slackService as any,
            paymentWebhookAdapterService,
            sellPayoutReconciliationService as any,
        );
    });

    // ==================== Charge Events ====================

    describe("processWebhookEvent – charge events", () => {
        it("calls paymentSuccessHandler for 'success' status", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.successful") as any,
            );

            expect(bankService.paymentSuccessHandler).toHaveBeenCalledWith("mref-1");
        });

        it("calls paymentSuccessHandler for 'successful' status", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.successful", { status: "successful" }) as any,
            );

            expect(bankService.paymentSuccessHandler).toHaveBeenCalledWith("mref-1");
        });

        it("calls paymentFailedHandler for 'failed' status", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.failed", { status: "failed" }) as any,
            );

            expect(bankService.paymentFailedHandler).toHaveBeenCalledWith("mref-1");
        });

        it("calls paymentFailedHandler for 'cancelled' status", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.cancelled", { status: "cancelled" }) as any,
            );

            expect(bankService.paymentFailedHandler).toHaveBeenCalledWith("mref-1");
        });

        it("does nothing for 'pending' status", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.pending", { status: "pending" }) as any,
            );

            expect(bankService.paymentSuccessHandler).not.toHaveBeenCalled();
            expect(bankService.paymentFailedHandler).not.toHaveBeenCalled();
        });

        it("does nothing for unknown charge status (default)", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.unknown", { status: "some_new_status" }) as any,
            );

            expect(bankService.paymentSuccessHandler).not.toHaveBeenCalled();
            expect(bankService.paymentFailedHandler).not.toHaveBeenCalled();
        });

        it("returns early if charge has no reference", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.successful", {
                    merchantReference: undefined,
                    reference: undefined,
                }) as any,
            );

            expect(bankService.paymentSuccessHandler).not.toHaveBeenCalled();
        });

        it("falls back to data.reference when merchantReference missing", async () => {
            await service.processWebhookEvent(
                chargePayload("charge.successful", {
                    merchantReference: undefined,
                    reference: "fallback-ref",
                }) as any,
            );

            expect(bankService.paymentSuccessHandler).toHaveBeenCalledWith("fallback-ref");
        });
    });

    // ==================== Payout Events ====================

    describe("processWebhookEvent – payout events", () => {
        it("processes successful payout for non-sell order: updates payment + triggers transfer handler", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment({ orderId: null, order: null }));

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(prisma.payment.update).toHaveBeenCalled();
            expect(prisma.$transaction).toHaveBeenCalled();
            expect(sellPayoutReconciliationService.reconcileSellPayoutState).not.toHaveBeenCalled();
            expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    paymentReference: "cref-1",
                    transferToBankStatus: "SUCCESS",
                }),
            );
        });

        it("processes failed payout for non-sell order: updates payment + sends Slack alert", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment({ orderId: null, order: null }));

            await service.processWebhookEvent(
                payoutPayload("payout.failed", { status: "failed" }) as any,
            );

            expect(prisma.payment.update).toHaveBeenCalled();
            expect(prisma.$transaction).toHaveBeenCalled();
            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalledWith(
                "fincra",
                "cref-1",
                expect.stringContaining("PAYOUT FAILED"),
                expect.any(Object),
            );
        });

        it("processes successful payout for SELL order via the shared reconciler", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());
            sellPayoutReconciliationService.reconcileSellPayoutState.mockResolvedValue({
                order: { id: 100 },
                provider: "fincra",
                reference: "cref-1",
                status: "SUCCESS",
            });

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(sellPayoutReconciliationService.reconcileSellPayoutState).toHaveBeenCalledWith(
                expect.objectContaining({ payment: prisma.payment, order: prisma.order }),
                expect.objectContaining({
                    orderId: 100,
                    provider: "fincra",
                    reference: "cref-1",
                    status: "SUCCESS",
                }),
            );
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "fincra",
                    reference: "cref-1",
                    status: "SUCCESS",
                }),
            );
            expect(bankService.processAssetValueTransferToBankHandler).not.toHaveBeenCalled();
        });

        it("processes failed payout for SELL order via the shared reconciler", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());
            sellPayoutReconciliationService.reconcileSellPayoutState.mockResolvedValue({
                order: { id: 100 },
                provider: "fincra",
                reference: "cref-1",
                status: "FAILED",
            });

            await service.processWebhookEvent(
                payoutPayload("payout.failed", { status: "failed" }) as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(sellPayoutReconciliationService.reconcileSellPayoutState).toHaveBeenCalledWith(
                expect.objectContaining({ payment: prisma.payment, order: prisma.order }),
                expect.objectContaining({
                    orderId: 100,
                    provider: "fincra",
                    reference: "cref-1",
                    status: "FAILED",
                }),
            );
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).toHaveBeenCalledWith(
                expect.objectContaining({
                    provider: "fincra",
                    reference: "cref-1",
                    status: "FAILED",
                }),
            );
        });

        it("skips update for 'processing' payout status", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.processing", { status: "processing" }) as any,
            );

            expect(prisma.payment.update).not.toHaveBeenCalled();
        });

        it("skips update for 'pending' payout status", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.pending", { status: "pending" }) as any,
            );

            expect(prisma.payment.update).not.toHaveBeenCalled();
        });

        it("skips update for unknown payout status (default)", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.unknown", { status: "some_new_status" }) as any,
            );

            expect(prisma.payment.update).not.toHaveBeenCalled();
        });

        it("returns early when payout has no reference", async () => {
            await service.processWebhookEvent(
                payoutPayload("payout.successful", {
                    customerReference: undefined,
                    reference: undefined,
                }) as any,
            );

            expect(prisma.payment.findUnique).not.toHaveBeenCalled();
        });

        it("returns early when payment record not found", async () => {
            prisma.payment.findUnique.mockResolvedValue(null);

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(prisma.payment.update).not.toHaveBeenCalled();
        });

        it("matches payout via 'disbursement' in event name", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment({ orderId: null, order: null }));

            await service.processWebhookEvent(
                payoutPayload("disbursement.successful") as any,
            );

            expect(prisma.payment.update).toHaveBeenCalled();
        });

        it("skips sell order handling when payment has no orderId", async () => {
            const paymentNoOrder = buildPayment({ orderId: null, order: null });
            prisma.payment.findUnique.mockResolvedValue(paymentNoOrder);

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(sellPayoutReconciliationService.reconcileSellPayoutState).not.toHaveBeenCalled();
            expect(sellPayoutReconciliationService.executeSellPayoutSideEffects).not.toHaveBeenCalled();
            expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalled();
        });
    });

    // ==================== Error handling ====================

    describe("processWebhookEvent – error handling", () => {
        it("re-throws handler error and sends Slack alert", async () => {
            bankService.paymentSuccessHandler.mockRejectedValue(
                new Error("DB connection lost"),
            );

            await expect(
                service.processWebhookEvent(
                    chargePayload("charge.successful") as any,
                ),
            ).rejects.toThrow("DB connection lost");

            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalledWith(
                "fincra",
                "mref-1",
                "DB connection lost",
                expect.any(Object),
            );
        });

        it("swallows Slack alert failure gracefully", async () => {
            bankService.paymentSuccessHandler.mockRejectedValue(
                new Error("Downstream fail"),
            );
            slackService.sendWebhookFailureAlert.mockRejectedValue(
                new Error("Slack API down"),
            );

            await expect(
                service.processWebhookEvent(
                    chargePayload("charge.successful") as any,
                ),
            ).rejects.toThrow("Downstream fail");
        });

        it("swallows Slack alert failure on payout failure path", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());
            slackService.sendWebhookFailureAlert.mockRejectedValue(
                new Error("Slack down"),
            );

            // Should NOT throw — payout failure Slack alert is caught
            await service.processWebhookEvent(
                payoutPayload("payout.failed", { status: "failed" }) as any,
            );

            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalled();
        });
    });
});
