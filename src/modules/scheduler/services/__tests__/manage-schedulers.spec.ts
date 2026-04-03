import { OrderStatus } from "@prisma/client";

// Break circular dependency while importing trade services from scheduler modules.
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

import { AccountSchedulerService } from "../manageAccounts";
import { ManageOrdersSchedulerService } from "../manageOrder";
import { getTriggeredTime } from "../utils";

function buildManageOrdersService() {
    const prisma = {
        order: {
            findMany: jest.fn(),
        },
    };

    const tradingService = {
        verifySwapQuoteTransaction: jest.fn(),
        swapTransactionHandler: jest.fn(),
        getWithdrawerTransactionByReference: jest.fn(),
        withdrawerTransactionHandler: jest.fn(),
    };

    const buyOrderService = {
        cancelExpiredBuyOrders: jest.fn(),
        cancelUnderpaidBuyOrders: jest.fn(),
        detectStuckConfirmedOrders: jest.fn(),
    };

    const service = new ManageOrdersSchedulerService(
        prisma as never,
        tradingService as never,
        buyOrderService as never,
    );

    const release = jest.fn();
    (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);

    return { service, prisma, tradingService, buyOrderService, release };
}

describe("scheduler services", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("AccountSchedulerService", () => {
        it("broadcasts wallet updates and releases mutex lock", async () => {
            const release = jest.fn();
            const wsGateway = {
                broadcastWalletUpdatesToUser: jest.fn(),
            };

            const service = new AccountSchedulerService({} as never, wsGateway as never);
            (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);

            await service.broadcastAssetsUpdate();

            expect((service as any).mutex.acquire).toHaveBeenCalledTimes(1);
            expect(wsGateway.broadcastWalletUpdatesToUser).toHaveBeenCalledTimes(1);
            expect(release).toHaveBeenCalledTimes(1);
        });

        it("still releases lock when websocket broadcast throws", async () => {
            const release = jest.fn();
            const wsGateway = {
                broadcastWalletUpdatesToUser: jest.fn(() => {
                    throw new Error("ws unavailable");
                }),
            };

            const service = new AccountSchedulerService({} as never, wsGateway as never);
            (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);

            await service.broadcastAssetsUpdate();

            expect(release).toHaveBeenCalledTimes(1);
        });
    });

    describe("ManageOrdersSchedulerService", () => {
        it("returns early when no pending swap transactions", async () => {
            const { service, prisma, tradingService, release } = buildManageOrdersService();
            prisma.order.findMany.mockResolvedValue([]);

            await service.verifySwapTransaction();

            expect(prisma.order.findMany).toHaveBeenCalledTimes(1);
            expect(tradingService.verifySwapQuoteTransaction).not.toHaveBeenCalled();
            expect(release).toHaveBeenCalledTimes(1);
        });

        it("processes completed, failed, and reversed swap statuses", async () => {
            const { service, prisma, tradingService, release } = buildManageOrdersService();
            prisma.order.findMany.mockResolvedValue([
                { providerOrderId: "swap-1", user: { cryptoSubAccountId: "sub-1" } },
                { providerOrderId: "swap-2", user: { cryptoSubAccountId: "sub-2" } },
                { providerOrderId: "swap-3", user: { cryptoSubAccountId: "sub-3" } },
            ]);

            tradingService.verifySwapQuoteTransaction
                .mockResolvedValueOnce({ data: { status: OrderStatus.completed } })
                .mockResolvedValueOnce({ data: { status: OrderStatus.failed } })
                .mockResolvedValueOnce({ data: { status: OrderStatus.reversed } });

            await service.verifySwapTransaction();

            expect(tradingService.verifySwapQuoteTransaction).toHaveBeenCalledTimes(3);
            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-1",
                status: OrderStatus.completed,
            });
            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-2",
                status: OrderStatus.failed,
            });
            expect(tradingService.swapTransactionHandler).toHaveBeenCalledWith({
                orderId: "swap-3",
                status: OrderStatus.reversed,
            });
            expect(release).toHaveBeenCalledTimes(1);
        });

        it("releases mutex when swap query fails", async () => {
            const { service, prisma, release } = buildManageOrdersService();
            prisma.order.findMany.mockRejectedValue(new Error("db down"));

            await service.verifySwapTransaction();

            expect(release).toHaveBeenCalledTimes(1);
        });

        it("skips withdrawer records without providerOrderId and handles done/rejected statuses", async () => {
            const { service, prisma, tradingService, release } = buildManageOrdersService();
            prisma.order.findMany.mockResolvedValue([
                {
                    providerOrderId: null,
                    orderReference: "skip-1",
                    user: { cryptoSubAccountId: "legacy-1" },
                },
                {
                    providerOrderId: "prov-2",
                    orderReference: "ord-2",
                    user: { cryptoSubAccountId: "legacy-2" },
                },
                {
                    providerOrderId: "prov-3",
                    orderReference: "ord-3",
                    user: { cryptoSubAccountId: "legacy-3" },
                },
            ]);

            tradingService.getWithdrawerTransactionByReference
                .mockResolvedValueOnce({ data: { status: OrderStatus.done } })
                .mockResolvedValueOnce({ data: { status: OrderStatus.rejected } });

            await service.verifyWithdrawerTransaction();

            expect(tradingService.getWithdrawerTransactionByReference).toHaveBeenCalledTimes(2);
            expect(tradingService.getWithdrawerTransactionByReference).toHaveBeenCalledWith("ord-2", "me");
            expect(tradingService.getWithdrawerTransactionByReference).toHaveBeenCalledWith("ord-3", "me");
            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith({
                orderReference: "ord-2",
                status: OrderStatus.done,
            });
            expect(tradingService.withdrawerTransactionHandler).toHaveBeenCalledWith({
                orderReference: "ord-3",
                status: OrderStatus.rejected,
            });
            expect(release).toHaveBeenCalledTimes(1);
        });

        it("calls buy-order maintenance handlers", async () => {
            const { service, buyOrderService } = buildManageOrdersService();
            buyOrderService.cancelExpiredBuyOrders.mockResolvedValue(2);
            buyOrderService.cancelUnderpaidBuyOrders.mockResolvedValue(1);
            buyOrderService.detectStuckConfirmedOrders.mockResolvedValue(3);

            await service.cancelExpiredBuyOrders();
            await service.cancelUnderpaidBuyOrders();
            await service.detectStuckConfirmedOrders();

            expect(buyOrderService.cancelExpiredBuyOrders).toHaveBeenCalledTimes(1);
            expect(buyOrderService.cancelUnderpaidBuyOrders).toHaveBeenCalledTimes(1);
            expect(buyOrderService.detectStuckConfirmedOrders).toHaveBeenCalledTimes(1);
        });
    });

    describe("scheduler utils", () => {
        it("returns a formatted trigger timestamp", () => {
            const output = getTriggeredTime();

            expect(output).toContain("triggered time: timezone:");
            expect(typeof output).toBe("string");
            expect(output.length).toBeGreaterThan(24);
        });
    });
});