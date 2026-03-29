// Break circular dependency via auth imports when loading trade modules.
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

import { Decimal } from "@prisma/client/runtime/library";

import { WithdrawalQueueCron } from "../withdrawal-queue.cron";

describe("WithdrawalQueueCron", () => {
    const prisma = {
        withdrawalQueue: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
        },
        order: {
            findFirst: jest.fn(),
        },
    };

    const quidaxService = {
        getUserWallet: jest.fn(),
        createWithdrawerRequest: jest.fn(),
    };

    const withdrawalQueueService = {
        isProcessingPaused: jest.fn(),
        getQueueStats: jest.fn(),
        processTimeouts: jest.fn(),
        getNextForProcessing: jest.fn(),
        markProcessed: jest.fn(),
        markReleased: jest.fn(),
    };

    const ledgerService = {
        releaseHold: jest.fn(),
        releaseHoldWithPlatformEntry: jest.fn(),
    };

    const slackWebhookService = {
        sendSystemAlert: jest.fn(),
    };

    const lockService = {
        withLock: jest.fn(),
    };

    const wsGateway = {
        notifyWithdrawalProcessed: jest.fn(),
        notifyQueueHealthAlert: jest.fn(),
    };

    let cron: WithdrawalQueueCron;

    beforeEach(() => {
        jest.clearAllMocks();
        cron = new WithdrawalQueueCron(
            prisma as never,
            quidaxService as never,
            withdrawalQueueService as never,
            ledgerService as never,
            slackWebhookService as never,
            lockService as never,
            wsGateway as never,
        );

        jest.spyOn((cron as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("processQueue skips when lock is already held by another pod", async () => {
        lockService.withLock.mockRejectedValue(
            new Error("Failed to acquire lock for job:withdrawal-queue:process"),
        );

        await cron.processQueue();

        expect(lockService.withLock).toHaveBeenCalledTimes(1);
        expect(slackWebhookService.sendSystemAlert).not.toHaveBeenCalled();
    });

    it("processQueue reports unexpected processing errors", async () => {
        const alertSpy = jest
            .spyOn(cron as any, "sendProcessingErrorAlert")
            .mockResolvedValue(undefined);
        lockService.withLock.mockRejectedValue(new Error("redis down"));

        await cron.processQueue();

        expect(alertSpy).toHaveBeenCalledTimes(1);
    });

    it("_processQueueInner returns early when processing is paused", async () => {
        withdrawalQueueService.isProcessingPaused.mockResolvedValue(true);

        await (cron as any)._processQueueInner();

        expect(withdrawalQueueService.getQueueStats).not.toHaveBeenCalled();
    });

    it("_processQueueInner processes currencies and timed-out entries", async () => {
        withdrawalQueueService.isProcessingPaused.mockResolvedValue(false);
        withdrawalQueueService.getQueueStats.mockResolvedValue({
            totalQueued: 1,
            byCurrency: { BTC: 1 },
            byReason: {},
            oldestQueuedAt: null,
        });
        prisma.withdrawalQueue.groupBy.mockResolvedValue([{ currency: "BTC" }]);
        withdrawalQueueService.processTimeouts.mockResolvedValue(2);

        const processCurrencySpy = jest
            .spyOn(cron as any, "processCurrencyQueue")
            .mockResolvedValue(1);
        const timeoutAlertSpy = jest
            .spyOn(cron as any, "sendTimeoutAlert")
            .mockResolvedValue(undefined);
        const healthSpy = jest
            .spyOn(cron as any, "checkQueueHealth")
            .mockResolvedValue(undefined);

        await (cron as any)._processQueueInner();

        expect(processCurrencySpy).toHaveBeenCalledWith("BTC");
        expect(timeoutAlertSpy).toHaveBeenCalledWith(2);
        expect(healthSpy).toHaveBeenCalledTimes(1);
    });

    it("processCurrencyQueue executes and marks one queued withdrawal", async () => {
        jest.spyOn(cron as any, "getMainWalletBalance").mockResolvedValue(new Decimal(5));
        const executeSpy = jest
            .spyOn(cron as any, "executeQueuedWithdrawal")
            .mockResolvedValue(true);

        withdrawalQueueService.getNextForProcessing
            .mockResolvedValueOnce({
                id: 11,
                userId: 5,
                currency: "BTC",
                amount: new Decimal(2),
                holdEntry: { reference: "hold-1", metadata: { destinationAddress: "bc1address" } },
            })
            .mockResolvedValueOnce(null);

        const processed = await (cron as any).processCurrencyQueue("BTC");

        expect(processed).toBe(1);
        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(withdrawalQueueService.markProcessed).toHaveBeenCalledWith(11);
        expect(wsGateway.notifyWithdrawalProcessed).toHaveBeenCalledTimes(1);
    });

    it("executeQueuedWithdrawal marks entry released when hold is missing", async () => {
        const result = await (cron as any).executeQueuedWithdrawal({ id: 21 });

        expect(result).toBe(false);
        expect(withdrawalQueueService.markReleased).toHaveBeenCalledWith(21);
    });

    it("executeQueuedWithdrawal releases hold when destination is missing", async () => {
        prisma.order.findFirst.mockResolvedValue(null);
        ledgerService.releaseHold.mockResolvedValue({ success: true });

        const result = await (cron as any).executeQueuedWithdrawal({
            id: 22,
            userId: 10,
            currency: "BTC",
            amount: new Decimal(1),
            holdEntry: {
                reference: "hold-ref-22",
                metadata: {},
            },
        });

        expect(result).toBe(false);
        expect(ledgerService.releaseHold).toHaveBeenCalledWith(
            "hold-ref-22",
            false,
            "Queue release: missing destination for queue entry 22",
        );
        expect(withdrawalQueueService.markReleased).toHaveBeenCalledWith(22);
    });

    it("checkQueueHealth sends queue-size, timeout, and starvation alerts", async () => {
        const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000);
        prisma.withdrawalQueue.findMany.mockResolvedValue([
            {
                id: 90,
                userId: 7,
                currency: "ETH",
                amount: new Decimal(4),
                queuedAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
            },
        ]);

        await (cron as any).checkQueueHealth({
            totalQueued: 60,
            byCurrency: { ETH: 40 },
            byReason: { INSUFFICIENT_MAIN_BALANCE: 60 },
            oldestQueuedAt: oldDate.toISOString(),
        });

        expect(slackWebhookService.sendSystemAlert).toHaveBeenCalled();
        expect(wsGateway.notifyQueueHealthAlert).toHaveBeenCalled();
    });
});
