import { FincraWebhookService } from "..";

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

/* ------------------------------------------------------------------ */
/*  Mock factories                                                    */
/* ------------------------------------------------------------------ */
function createMockPrisma() {
    return {
        payment: {
            findUnique: jest.fn().mockResolvedValue(null),
        },
        $transaction: jest.fn().mockImplementation((cb: (tx: any) => Promise<void>) =>
            cb({
                payment: { update: jest.fn().mockResolvedValue({}) },
                order: { update: jest.fn().mockResolvedValue({}) },
            }),
        ),
    };
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
describe("FincraWebhookService", () => {
    let service: FincraWebhookService;
    let prisma: ReturnType<typeof createMockPrisma>;
    let bankService: ReturnType<typeof createMockBankService>;
    let slackService: ReturnType<typeof createMockSlackService>;

    beforeEach(() => {
        prisma = createMockPrisma();
        bankService = createMockBankService();
        slackService = createMockSlackService();
        service = new FincraWebhookService(
            prisma as any,
            bankService as any,
            slackService as any,
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
        it("processes successful payout: updates DB + triggers transfer handler", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(bankService.processAssetValueTransferToBankHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    paymentReference: "cref-1",
                    transferToBankStatus: "SUCCESS",
                }),
            );
        });

        it("processes failed payout: updates DB + sends Slack alert", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.failed", { status: "failed" }) as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
            expect(slackService.sendWebhookFailureAlert).toHaveBeenCalledWith(
                "fincra",
                "cref-1",
                expect.stringContaining("PAYOUT FAILED"),
                expect.any(Object),
            );
        });

        it("skips update for 'processing' payout status", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.processing", { status: "processing" }) as any,
            );

            expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it("skips update for 'pending' payout status", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.pending", { status: "pending" }) as any,
            );

            expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it("skips update for unknown payout status (default)", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("payout.unknown", { status: "some_new_status" }) as any,
            );

            expect(prisma.$transaction).not.toHaveBeenCalled();
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

            expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it("matches payout via 'disbursement' in event name", async () => {
            prisma.payment.findUnique.mockResolvedValue(buildPayment());

            await service.processWebhookEvent(
                payoutPayload("disbursement.successful") as any,
            );

            expect(prisma.$transaction).toHaveBeenCalled();
        });

        it("skips order update when payment has no orderId", async () => {
            const paymentNoOrder = buildPayment({ orderId: null, order: null });
            prisma.payment.findUnique.mockResolvedValue(paymentNoOrder);

            let orderUpdateCalled = false;
            prisma.$transaction.mockImplementation((cb: (tx: any) => Promise<void>) =>
                cb({
                    payment: { update: jest.fn().mockResolvedValue({}) },
                    order: {
                        update: jest.fn().mockImplementation(() => {
                            orderUpdateCalled = true;
                            return Promise.resolve({});
                        }),
                    },
                }),
            );

            await service.processWebhookEvent(
                payoutPayload("payout.successful") as any,
            );

            expect(orderUpdateCalled).toBe(false);
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
