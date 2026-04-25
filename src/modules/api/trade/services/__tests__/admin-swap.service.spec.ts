jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {
        readonly __stub = true;
    },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { Test, TestingModule } from "@nestjs/testing";
import { OrderCategory, OrderStatus } from "@prisma/client";
import { AdminSwapService } from "../admin-swap.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { GeneralTransactionException } from "../../errors";

function makePrisma() {
    return {
        order: {
            create: jest.fn().mockResolvedValue({ id: 1 }),
            findFirst: jest.fn(),
        },
    };
}

function makeQuidaxService() {
    return {
        createInstantSwapRequest: jest.fn(),
        confirmInstantSwap: jest.fn(),
    };
}

function makeSlack() {
    return {
        sendAlert: jest.fn().mockResolvedValue(undefined),
    };
}

describe("AdminSwapService", () => {
    let service: AdminSwapService;
    let prisma: ReturnType<typeof makePrisma>;
    let quidax: ReturnType<typeof makeQuidaxService>;
    let slack: ReturnType<typeof makeSlack>;

    beforeEach(async () => {
        prisma = makePrisma();
        quidax = makeQuidaxService();
        slack = makeSlack();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AdminSwapService,
                { provide: PrismaService, useValue: prisma },
                { provide: TradingInjectionToken.QUIDAX, useValue: quidax },
                { provide: SlackWebhookService, useValue: slack },
            ],
        }).compile();

        service = module.get(AdminSwapService);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
    });

    afterEach(() => jest.clearAllMocks());

    // ── mapSwapStatusToOrderStatus (private, tested via confirmSwap) ────

    const swapResultBase = {
        id: "swap-1",
        from_currency: "btc",
        to_currency: "usdt",
        from_amount: "0.5",
        received_amount: "35000",
        execution_price: "70000",
        quoted_price: "70000",
        status: "done",
        created_at: "2026-01-01T00:00:00Z",
        swap_quotation: { quoted_price: "70000" },
    };

    describe("getSwapQuote", () => {
        it("should return a quote from Quidax", async () => {
            quidax.createInstantSwapRequest.mockResolvedValue({
                data: {
                    id: "quote-1",
                    from_currency: "btc",
                    to_currency: "usdt",
                    from_amount: "0.5",
                    to_amount: "35000",
                    quoted_price: "70000",
                    expires_at: "2026-01-01T01:00:00Z",
                },
            });

            const result = await service.getSwapQuote({
                from_currency: "btc" as any,
                to_currency: "usdt" as any,
                from_amount: 0.5,
            });

            expect(result.data.quotation_id).toBe("quote-1");
            expect(result.data.rate).toBe("70000");
            expect(quidax.createInstantSwapRequest).toHaveBeenCalledWith("me", {
                from_currency: "btc",
                to_currency: "usdt",
                from_amount: "0.5",
            });
        });
    });

    describe("confirmSwap", () => {
        it("should throw CONFLICT when quotation was already confirmed", async () => {
            prisma.order.findFirst.mockResolvedValue({ id: 99 });

            await expect(
                service.confirmSwap({ quotation_id: "dup-quote" }, 1),
            ).rejects.toThrow(GeneralTransactionException);
        });

        it("should confirm swap and create order with completed status", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "completed" },
            });

            const result = await service.confirmSwap({ quotation_id: "q-1" }, 42);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        orderCategory: OrderCategory.SWAP,
                        status: OrderStatus.completed,
                        userId: 42,
                    }),
                }),
            );
            expect(result.data.id).toBe("swap-1");
            expect(slack.sendAlert).toHaveBeenCalledWith(
                "ADMIN_SWAP_EXECUTED",
                expect.any(Object),
            );
        });

        it("should map 'done' status to completed", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "done" },
            });

            await service.confirmSwap({ quotation_id: "q-2" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.completed }),
                }),
            );
        });

        it("should map 'successful' status to completed", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "successful" },
            });

            await service.confirmSwap({ quotation_id: "q-s" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.completed }),
                }),
            );
        });

        it("should map 'failed' status to failed", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "failed" },
            });

            await service.confirmSwap({ quotation_id: "q-3" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.failed }),
                }),
            );
        });

        it("should map 'rejected' status to failed", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "rejected" },
            });

            await service.confirmSwap({ quotation_id: "q-r" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.failed }),
                }),
            );
        });

        it("should map 'reversed' status to reversed", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "reversed" },
            });

            await service.confirmSwap({ quotation_id: "q-4" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.reversed }),
                }),
            );
        });

        it("should map 'cancelled' status to cancelled", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "cancelled" },
            });

            await service.confirmSwap({ quotation_id: "q-5" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.cancelled }),
                }),
            );
        });

        it("should map 'canceled' (US spelling) status to cancelled", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "canceled" },
            });

            await service.confirmSwap({ quotation_id: "q-6" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.cancelled }),
                }),
            );
        });

        it("should map unknown status to processing", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: "pending" },
            });

            await service.confirmSwap({ quotation_id: "q-7" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.processing }),
                }),
            );
        });

        it("should fallback to swap_quotation quoted_price when execution_price is missing", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: {
                    ...swapResultBase,
                    execution_price: undefined,
                    swap_quotation: { quoted_price: "69500" },
                },
            });

            await service.confirmSwap({ quotation_id: "q-8" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        executionPrice: 69500,
                        quoted_price: 69500,
                    }),
                }),
            );
        });

        it("should fallback to 0 when both execution_price and swap_quotation are missing", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: {
                    ...swapResultBase,
                    execution_price: undefined,
                    swap_quotation: undefined,
                },
            });

            await service.confirmSwap({ quotation_id: "q-9" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        executionPrice: 0,
                        quoted_price: 0,
                    }),
                }),
            );
        });

        it("should not throw when Slack alert fails", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase },
            });
            slack.sendAlert.mockRejectedValue(new Error("Slack down"));

            const result = await service.confirmSwap({ quotation_id: "q-10" }, 1);

            expect(result.data.id).toBe("swap-1");
        });

        it("should map undefined status to processing", async () => {
            prisma.order.findFirst.mockResolvedValue(null);
            quidax.confirmInstantSwap.mockResolvedValue({
                data: { ...swapResultBase, status: undefined },
            });

            await service.confirmSwap({ quotation_id: "q-undef" }, 1);

            expect(prisma.order.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({ status: OrderStatus.processing }),
                }),
            );
        });
    });
});
