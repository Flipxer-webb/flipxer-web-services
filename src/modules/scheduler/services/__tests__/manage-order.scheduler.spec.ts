import { OrderCategory, OrderStatus } from "@prisma/client";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

import { ManageOrdersSchedulerService } from "../manageOrder";

describe("ManageOrdersSchedulerService", () => {
    let service: ManageOrdersSchedulerService;
    let prisma: {
        order: {
            findMany: jest.Mock;
        };
    };
    let tradingService: {
        verifySwapQuoteTransaction: jest.Mock;
        swapTransactionHandler: jest.Mock;
        getWithdrawerTransactionByReference: jest.Mock;
        withdrawerTransactionHandler: jest.Mock;
    };
    let buyOrderService: {
        cancelExpiredBuyOrders: jest.Mock;
        cancelUnderpaidBuyOrders: jest.Mock;
        detectStuckConfirmedOrders: jest.Mock;
    };

    beforeEach(() => {
        prisma = {
            order: {
                findMany: jest.fn(),
            },
        };

        tradingService = {
            verifySwapQuoteTransaction: jest.fn(),
            swapTransactionHandler: jest.fn(),
            getWithdrawerTransactionByReference: jest.fn(),
            withdrawerTransactionHandler: jest.fn(),
        };

        buyOrderService = {
            cancelExpiredBuyOrders: jest.fn(),
            cancelUnderpaidBuyOrders: jest.fn(),
            detectStuckConfirmedOrders: jest.fn(),
        };

        service = new ManageOrdersSchedulerService(
            prisma as any,
            tradingService as any,
            buyOrderService as any,
        );
    });

    describe("verifySwapTransaction", () => {
        it("should return early when no pending swap transactions exist", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.verifySwapTransaction();

            expect(tradingService.verifySwapQuoteTransaction).not.toHaveBeenCalled();
            expect(tradingService.swapTransactionHandler).not.toHaveBeenCalled();
        });

        it("should process completed swap transactions", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 1,
                    providerOrderId: "swap-1",
                    user: { cryptoSubAccountId: "sub-1" },
                },
            ]);
            tradingService.verifySwapQuoteTransaction.mockResolvedValue({
                data: { status: OrderStatus.completed },
            });

            await service.verifySwapTransaction();

            expect(tradingService.verifySwapQuoteTransaction).toHaveBeenCalledWith("swap-1", "sub-1");
            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-1",
                status: OrderStatus.completed,
            });
        });

        it("should process failed and reversed swap statuses", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 2,
                    providerOrderId: "swap-2",
                    user: { cryptoSubAccountId: "sub-2" },
                },
                {
                    id: 3,
                    providerOrderId: "swap-3",
                    user: { cryptoSubAccountId: "sub-3" },
                },
            ]);
            tradingService.verifySwapQuoteTransaction
                .mockResolvedValueOnce({ data: { status: OrderStatus.failed } })
                .mockResolvedValueOnce({ data: { status: OrderStatus.reversed } });

            await service.verifySwapTransaction();

            expect(tradingService.swapTransactionHandler).toHaveBeenNthCalledWith(1, {
                orderId: "swap-2",
                status: OrderStatus.failed,
            });
            expect(tradingService.swapTransactionHandler).toHaveBeenNthCalledWith(2, {
                orderId: "swap-3",
                status: OrderStatus.reversed,
            });
        });

        it("should skip swap verification when user has no sub account id", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 4,
                    providerOrderId: "swap-4",
                    user: { cryptoSubAccountId: null },
                },
            ]);

            await service.verifySwapTransaction();

            expect(tradingService.verifySwapQuoteTransaction).not.toHaveBeenCalled();
            expect(tradingService.swapTransactionHandler).not.toHaveBeenCalled();
        });

        it("should swallow per-transaction verification errors and continue", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 5,
                    providerOrderId: "swap-5",
                    user: { cryptoSubAccountId: "sub-5" },
                },
                {
                    id: 6,
                    providerOrderId: "swap-6",
                    user: { cryptoSubAccountId: "sub-6" },
                },
            ]);
            tradingService.verifySwapQuoteTransaction
                .mockRejectedValueOnce(new Error("quidax down"))
                .mockResolvedValueOnce({ data: { status: OrderStatus.completed } });

            await service.verifySwapTransaction();

            expect(tradingService.verifySwapQuoteTransaction).toHaveBeenCalledTimes(2);
            expect(tradingService.swapTransactionHandler).toHaveBeenCalledTimes(1);
        });
    });

    describe("verifyWithdrawerTransaction", () => {
        it("should return early when no pending withdrawer transactions exist", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.verifyWithdrawerTransaction();

            expect(tradingService.getWithdrawerTransactionByReference).not.toHaveBeenCalled();
            expect(tradingService.withdrawerTransactionHandler).not.toHaveBeenCalled();
        });

        it("should skip queued orders that have no provider order id", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 1,
                    orderReference: "ord-1",
                    providerOrderId: null,
                    user: { cryptoSubAccountId: "sub-1" },
                },
            ]);

            await service.verifyWithdrawerTransaction();

            expect(tradingService.getWithdrawerTransactionByReference).not.toHaveBeenCalled();
            expect(tradingService.withdrawerTransactionHandler).not.toHaveBeenCalled();
        });

        it("should process done withdrawer statuses", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 2,
                    orderReference: "ord-2",
                    providerOrderId: "prov-2",
                    user: { cryptoSubAccountId: "sub-2" },
                },
            ]);
            tradingService.getWithdrawerTransactionByReference.mockResolvedValue({
                data: { status: "DONE" },
            });

            await service.verifyWithdrawerTransaction();

            expect(tradingService.getWithdrawerTransactionByReference).toHaveBeenCalledWith("ord-2", "me");
            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith({
                orderReference: "ord-2",
                status: OrderStatus.done,
            });
        });

        it("should process rejected withdrawer statuses", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 3,
                    orderReference: "ord-3",
                    providerOrderId: "prov-3",
                    user: { cryptoSubAccountId: "sub-3" },
                },
            ]);
            tradingService.getWithdrawerTransactionByReference.mockResolvedValue({
                data: { status: "REJECTED" },
            });

            await service.verifyWithdrawerTransaction();

            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith({
                orderReference: "ord-3",
                status: OrderStatus.rejected,
            });
        });

        it("should swallow withdrawer lookup errors and continue", async () => {
            prisma.order.findMany.mockResolvedValue([
                {
                    id: 4,
                    orderReference: "ord-4",
                    providerOrderId: "prov-4",
                    user: { cryptoSubAccountId: "sub-4" },
                },
                {
                    id: 5,
                    orderReference: "ord-5",
                    providerOrderId: "prov-5",
                    user: { cryptoSubAccountId: "sub-5" },
                },
            ]);
            tradingService.getWithdrawerTransactionByReference
                .mockRejectedValueOnce(new Error("lookup failed"))
                .mockResolvedValueOnce({ data: { status: "DONE" } });

            await service.verifyWithdrawerTransaction();

            expect(tradingService.getWithdrawerTransactionByReference).toHaveBeenCalledTimes(2);
            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledTimes(1);
        });

        it("should query only processing SEND and SELL orders", async () => {
            prisma.order.findMany.mockResolvedValue([]);

            await service.verifyWithdrawerTransaction();

            expect(prisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        orderCategory: { in: [OrderCategory.SEND, OrderCategory.SELL] },
                        status: OrderStatus.processing,
                    }),
                }),
            );
        });
    });

    describe("buy-order cleanup jobs", () => {
        it("should call cancelExpiredBuyOrders", async () => {
            buyOrderService.cancelExpiredBuyOrders.mockResolvedValue(2);

            await service.cancelExpiredBuyOrders();

            expect(buyOrderService.cancelExpiredBuyOrders).toHaveBeenCalledTimes(1);
        });

        it("should swallow errors from cancelExpiredBuyOrders", async () => {
            buyOrderService.cancelExpiredBuyOrders.mockRejectedValue(new Error("db failure"));

            await expect(service.cancelExpiredBuyOrders()).resolves.toBeUndefined();
        });

        it("should call cancelUnderpaidBuyOrders", async () => {
            buyOrderService.cancelUnderpaidBuyOrders.mockResolvedValue(1);

            await service.cancelUnderpaidBuyOrders();

            expect(buyOrderService.cancelUnderpaidBuyOrders).toHaveBeenCalledTimes(1);
        });

        it("should swallow errors from cancelUnderpaidBuyOrders", async () => {
            buyOrderService.cancelUnderpaidBuyOrders.mockRejectedValue(new Error("db failure"));

            await expect(service.cancelUnderpaidBuyOrders()).resolves.toBeUndefined();
        });

        it("should call detectStuckConfirmedOrders", async () => {
            buyOrderService.detectStuckConfirmedOrders.mockResolvedValue(3);

            await service.detectStuckConfirmedOrders();

            expect(buyOrderService.detectStuckConfirmedOrders).toHaveBeenCalledTimes(1);
        });

        it("should swallow errors from detectStuckConfirmedOrders", async () => {
            buyOrderService.detectStuckConfirmedOrders.mockRejectedValue(new Error("db failure"));

            await expect(service.detectStuckConfirmedOrders()).resolves.toBeUndefined();
        });
    });
});
