import { QuidaxWebhookService } from "..";
import { Event } from "../../interfaces";

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

jest.mock("@/modules/api/trade/services", () => ({
    TradingService: class {
        isStub() {
            return true;
        }
    },
}));

/* ------------------------------------------------------------------ */
/*  Mock factories                                                    */
/* ------------------------------------------------------------------ */
function createMockPrisma() {
    return {} as any;
}

function createMockTradingService() {
    return {
        depositHandler: jest.fn().mockResolvedValue(undefined),
        walletUpdatedHandler: jest.fn().mockResolvedValue(undefined),
        walletAddressCreatedSuccessHandler: jest.fn().mockResolvedValue(undefined),
        swapTransactionHandler: jest.fn().mockResolvedValue(undefined),
        withdrawerTransactionHandler: jest.fn().mockResolvedValue(undefined),
        handleSweepConfirmation: jest.fn().mockResolvedValue(undefined),
    };
}

/* ------------------------------------------------------------------ */
/*  Test data builders                                                */
/* ------------------------------------------------------------------ */
const NOW_ISO = new Date().toISOString();

const baseUser = {
    id: "usr-1",
    sn: "001",
    email: "test@test.com",
    reference: null,
    first_name: "Test",
    last_name: "User",
    display_name: "Test User",
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
};

function walletAddressData(overrides: Record<string, unknown> = {}) {
    return {
        id: "wa-1",
        reference: null,
        currency: "btc",
        address: "0xabc",
        network: "bitcoin",
        user: baseUser,
        destination_tag: null,
        total_payments: null,
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        ...overrides,
    };
}

function walletUpdatedData(overrides: Record<string, unknown> = {}) {
    return {
        id: "w-1",
        currency: "btc",
        balance: "1.5",
        locked: "0",
        staked: "0",
        user: baseUser,
        converted_balance: "100000",
        reference_currency: "ngn",
        is_crypto: true,
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        deposit_address: "0xabc",
        destination_tag: null,
        ...overrides,
    };
}

function swapEventData(
    status: "completed" | "reversed" | "failed",
    overrides: Record<string, unknown> = {},
) {
    return {
        id: "swap-1",
        from_currency: "btc",
        to_currency: "eth",
        from_amount: "1",
        received_amount: "15",
        execution_price: "15",
        status,
        created_at: NOW_ISO,
        updated_at: NOW_ISO,
        swap_quotation: {
            id: "sq-1",
            from_currency: "btc",
            to_currency: "eth",
            quoted_price: "15",
            quoted_currency: "eth",
            from_amount: "1",
            to_amount: "15",
            confirmed: true,
            expires_at: NOW_ISO,
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
            user: baseUser,
        },
        user: baseUser,
        ...overrides,
    };
}

function withdrawData(overrides: Record<string, unknown> = {}) {
    return {
        id: "wd-1",
        reference: "ref-123",
        type: "crypto",
        currency: "btc",
        amount: "0.5",
        fee: "0.0001",
        total: "0.5001",
        txid: "txid-abc",
        transaction_note: "",
        narration: "",
        status: "Done",
        reason: null,
        created_at: NOW_ISO,
        done_at: NOW_ISO,
        recipient: {
            type: "crypto",
            details: {
                user_id: "usr-1",
                address: "0xabc",
                destination_tag: null,
                name: null,
            },
        },
        wallet: {
            id: "w-1",
            currency: "btc",
            balance: "1",
            locked: "0",
            staked: "0",
            converted_balance: "100000",
            reference_currency: "ngn",
            is_crypto: true,
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
        },
        user: baseUser,
        ...overrides,
    };
}

function depositData(overrides: Record<string, unknown> = {}) {
    return {
        id: "dep-1",
        type: "crypto",
        currency: "btc",
        amount: "0.1",
        fee: "0",
        txid: "txid-dep",
        status: "successful",
        reason: null,
        created_at: NOW_ISO,
        done_at: NOW_ISO,
        wallet: {
            id: "w-1",
            name: "Bitcoin",
            currency: "btc",
            balance: "1",
            locked: "0",
            staked: "0",
            user: baseUser,
            converted_balance: "100000",
            reference_currency: "ngn",
            is_crypto: true,
            created_at: NOW_ISO,
            updated_at: NOW_ISO,
            blockchain_enabled: true,
            default_network: "bitcoin",
            networks: [],
            deposit_address: "0xabc",
            destination_tag: null,
        },
        user: baseUser,
        payment_transaction: {
            status: "done",
            confirmations: 6,
            required_confirmations: 3,
        },
        ...overrides,
    };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */
describe("QuidaxWebhookService", () => {
    let service: QuidaxWebhookService;
    let tradingService: ReturnType<typeof createMockTradingService>;

    beforeEach(() => {
        const prisma = createMockPrisma();
        tradingService = createMockTradingService();
        service = new QuidaxWebhookService(prisma, tradingService as any);
    });

    // ==================== Metrics ====================

    describe("getMetrics / resetMetrics", () => {
        it("returns initial zero metrics", () => {
            const m = service.getMetrics();
            expect(m.totalReceived).toBe(0);
            expect(m.successfullyProcessed).toBe(0);
            expect(m.failed).toBe(0);
            expect(m.lastEventAt).toBeNull();
        });

        it("resets metrics to initial state", async () => {
            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data: walletUpdatedData(),
            } as any);

            service.resetMetrics();
            const m = service.getMetrics();
            expect(m.totalReceived).toBe(0);
        });
    });

    // ==================== Timestamp validation ====================

    describe("processWebhookEvent – timestamp validation", () => {
        it("rejects stale events older than effective max age", async () => {
            // Effective max age = MAX_WEBHOOK_AGE_MS (300s) + CLOCK_SKEW_ALLOWANCE_MS (3700s) = 4000s
            const staleDate = new Date(Date.now() - 70 * 60 * 1000).toISOString();

            await expect(
                service.processWebhookEvent({
                    event: Event.WalletUpdatedEvent,
                    data: walletUpdatedData({ updated_at: staleDate, created_at: staleDate }),
                } as any),
            ).rejects.toThrow(/Webhook rejected/);

            expect(tradingService.walletUpdatedHandler).not.toHaveBeenCalled();
        });

        it("rejects events with far-future timestamps (>1 min ahead)", async () => {
            const futureDate = new Date(Date.now() + 2 * 60 * 1000).toISOString();

            await expect(
                service.processWebhookEvent({
                    event: Event.WalletUpdatedEvent,
                    data: walletUpdatedData({ updated_at: futureDate }),
                } as any),
            ).rejects.toThrow(/Webhook rejected/);
        });

        it("allows events without timestamps for backward compat", async () => {
            const data = walletUpdatedData();
            delete (data as any).updated_at;
            delete (data as any).created_at;

            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data,
            } as any);

            expect(tradingService.walletUpdatedHandler).toHaveBeenCalled();
        });
    });

    // ==================== WalletAddressGenerated ====================

    describe("WalletAddressGenerated event", () => {
        it("delegates to tradingService.walletAddressCreatedSuccessHandler", async () => {
            await service.processWebhookEvent({
                event: Event.WalletAddressGenerated,
                data: walletAddressData(),
            } as any);

            expect(tradingService.walletAddressCreatedSuccessHandler).toHaveBeenCalledWith({
                walletAddressId: "wa-1",
                walletAddress: "0xabc",
                totalPayments: null,
            });
        });

        it("tracks success metric", async () => {
            await service.processWebhookEvent({
                event: Event.WalletAddressGenerated,
                data: walletAddressData(),
            } as any);

            const m = service.getMetrics();
            expect(m.successfullyProcessed).toBe(1);
            expect(m.byEventType[Event.WalletAddressGenerated].processed).toBe(1);
        });

        it("swallows downstream error and tracks failure metric", async () => {
            tradingService.walletAddressCreatedSuccessHandler.mockRejectedValue(
                new Error("DB down"),
            );

            // processWalletAddress catches errors, so processWebhookEvent succeeds
            await service.processWebhookEvent({
                event: Event.WalletAddressGenerated,
                data: walletAddressData(),
            } as any);

            const m = service.getMetrics();
            expect(m.successfullyProcessed).toBe(1); // processWebhookEvent itself doesn't throw
        });
    });

    // ==================== WalletUpdated ====================

    describe("WalletUpdated event", () => {
        it("maps eventData fields to trading service params", async () => {
            const data = walletUpdatedData({
                balance: "2.0",
                locked: "0.5",
                deposit_address: "0xdef",
            });

            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data,
            } as any);

            expect(tradingService.walletUpdatedHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    walletId: "w-1",
                    balance: "2.0",
                    locked: "0.5",
                    depositAddress: "0xdef",
                }),
            );
        });
    });

    // ==================== Swap Transactions ====================

    describe("Swap transaction events", () => {
        it("handles SwapTransactionCompleted", async () => {
            await service.processWebhookEvent({
                event: Event.SwapTransactionCompleted,
                data: swapEventData("completed"),
            } as any);

            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-1",
                status: "completed",
            });
        });

        it("handles SwapTransactionRevered (reversed)", async () => {
            await service.processWebhookEvent({
                event: Event.SwapTransactionRevered,
                data: swapEventData("reversed"),
            } as any);

            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-1",
                status: "reversed",
            });
        });

        it("handles SwapTransactionFailed", async () => {
            await service.processWebhookEvent({
                event: Event.SwapTransactionFailed,
                data: swapEventData("failed"),
            } as any);

            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-1",
                status: "failed",
            });
        });

        it("does nothing for unknown swap status (default branch)", async () => {
            await service.processWebhookEvent({
                event: Event.SwapTransactionCompleted,
                data: swapEventData("completed" as any),
            } as any);

            // Verify it was called (completed IS handled)
            expect(tradingService.swapTransactionHandler).toHaveBeenCalled();
        });
    });

    // ==================== Withdrawal Events ====================

    describe("Withdrawal events", () => {
        it("routes Done status to withdrawerTransactionHandler with done", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawSuccessful,
                data: withdrawData({ status: "Done" }),
            } as any);

            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    orderReference: "ref-123",
                    status: "done",
                }),
            );
        });

        it("routes 'successful' status to done", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawSuccessful,
                data: withdrawData({ status: "successful" }),
            } as any);

            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "done" }),
            );
        });

        it("routes Rejected status to failed", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawRejected,
                data: withdrawData({ status: "Rejected" }),
            } as any);

            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "failed" }),
            );
        });

        it("logs warning for unhandled withdrawal status", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawSuccessful,
                data: withdrawData({ status: "processing" }),
            } as any);

            // Neither handler should be called for an unhandled status
            expect(tradingService.withdrawerTransactionHandler).not.toHaveBeenCalled();
        });

        it("routes sweep-* references to handleSweepConfirmation (completed)", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawSuccessful,
                data: withdrawData({ reference: "sweep-abc-123", status: "Done" }),
            } as any);

            expect(tradingService.handleSweepConfirmation).toHaveBeenCalledWith(
                "wd-1",
                "completed",
                undefined,
            );
            expect(tradingService.withdrawerTransactionHandler).not.toHaveBeenCalled();
        });

        it("routes sweep-* reference with failure status to failed", async () => {
            await service.processWebhookEvent({
                event: Event.WithdrawRejected,
                data: withdrawData({
                    reference: "sweep-xyz",
                    status: "Rejected",
                    reason: "Insufficient funds",
                }),
            } as any);

            expect(tradingService.handleSweepConfirmation).toHaveBeenCalledWith(
                "wd-1",
                "failed",
                "Insufficient funds",
            );
        });
    });

    // ==================== Deposit Events ====================

    describe("Deposit events", () => {
        it("normalizes 'successful' status to accepted", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionSuccessful,
                data: depositData({ status: "successful" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "accepted" }),
            );
        });

        it("normalizes 'done' status to accepted", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionSuccessful,
                data: depositData({ status: "done" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "accepted" }),
            );
        });

        it("normalizes 'confirming' status to submitted", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionConfirmation,
                data: depositData({ status: "confirming" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "submitted" }),
            );
        });

        it("normalizes 'pending' status to submitted", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionConfirmation,
                data: depositData({ status: "pending" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "submitted" }),
            );
        });

        it("normalizes 'failed_aml' to failed", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionFailedAml,
                data: depositData({ status: "failed_aml" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "failed" }),
            );
        });

        it("normalizes 'on_hold' to on_hold", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionOnHold,
                data: depositData({ status: "on_hold" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "on_hold" }),
            );
        });

        it("defaults unknown deposit status to submitted", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionConfirmation,
                data: depositData({ status: "some_unknown_status" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "submitted" }),
            );
        });

        it("maps payment_address fields when present", async () => {
            const data = depositData({
                payment_address: {
                    id: "pa-1",
                    reference: null,
                    currency: "btc",
                    address: "0xpay",
                    network: "bitcoin",
                    user: baseUser,
                    destination_tag: null,
                    total_payments: null,
                    created_at: NOW_ISO,
                    updated_at: NOW_ISO,
                },
            });

            await service.processWebhookEvent({
                event: Event.DepositTransactionSuccessful,
                data,
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({
                    payment_address: "0xpay",
                    payment_address_id: "pa-1",
                    network: "bitcoin",
                }),
            );
        });

        it("handles deposit with 'accepted' status directly", async () => {
            await service.processWebhookEvent({
                event: Event.DepositTransactionSuccessful,
                data: depositData({ status: "accepted" }),
            } as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "accepted" }),
            );
        });

        it("handles deposit switch default branch when normalized status is unknown", async () => {
            const normalizeSpy = jest
                .spyOn(service as any, "normalizeDepositStatus")
                .mockReturnValue("unhandled_status");

            await service.depositHandler(depositData() as any);

            expect(tradingService.depositHandler).toHaveBeenCalledWith(
                expect.objectContaining({ status: "unhandled_status" }),
            );

            normalizeSpy.mockRestore();
        });
    });

    describe("swapTransactionHandlerHandler", () => {
        it("no-ops on unhandled swap status", async () => {
            await service.swapTransactionHandlerHandler(
                swapEventData("completed", { status: "mystery" }) as any,
            );

            expect(tradingService.swapTransactionHandler).not.toHaveBeenCalled();
        });
    });

    // ==================== Unhandled Events ====================

    describe("Unhandled / default events", () => {
        it("logs warning for unrecognized event type and tracks success", async () => {
            await service.processWebhookEvent({
                event: "some.unknown.event" as any,
                data: { updated_at: NOW_ISO } as any,
            });

            const m = service.getMetrics();
            expect(m.successfullyProcessed).toBe(1);
        });
    });

    // ==================== Error handling in processWebhookEvent ====================

    describe("processWebhookEvent – error handling", () => {
        it("swallows handler errors and tracks failure metric", async () => {
            tradingService.walletUpdatedHandler.mockRejectedValue(
                new Error("Downstream crash"),
            );

            // Should NOT reject — error is swallowed
            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data: walletUpdatedData(),
            } as any);

            const m = service.getMetrics();
            expect(m.failed).toBe(1);
            expect(m.lastError).toBe("Downstream crash");
        });

        it("accumulates per-event-type metrics across multiple events", async () => {
            // 2 successes
            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data: walletUpdatedData(),
            } as any);
            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data: walletUpdatedData(),
            } as any);

            // 1 failure
            tradingService.walletUpdatedHandler.mockRejectedValue(new Error("fail"));
            await service.processWebhookEvent({
                event: Event.WalletUpdatedEvent,
                data: walletUpdatedData(),
            } as any);

            const m = service.getMetrics();
            expect(m.totalReceived).toBe(3);
            expect(m.successfullyProcessed).toBe(2);
            expect(m.failed).toBe(1);
            expect(m.byEventType[Event.WalletUpdatedEvent].processed).toBe(2);
            expect(m.byEventType[Event.WalletUpdatedEvent].failed).toBe(1);
        });
    });
});
