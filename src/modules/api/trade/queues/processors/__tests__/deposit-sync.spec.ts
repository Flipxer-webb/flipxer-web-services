jest.mock("@nestjs/bull", () => ({
    Processor: () => () => undefined,
    Process: () => () => undefined,
    InjectQueue: () => () => undefined,
    __esModule: true,
}));

// Avoid loading the heavy TradingService barrel (which transitively pulls in
// every Nest module) — the processor only uses it as a type at runtime
// because the value is provided by the DI container.
jest.mock("../../../services", () => ({
    __esModule: true,
    TradingService: class TradingServiceStub {},
}));

import { QuidaxDepositSyncProcessor } from "../deposit_sync";
import { QuidaxTooManyRequestError } from "@/libs/quidax";

describe("QuidaxDepositSyncProcessor", () => {
    let tradingService: { syncUserDeposits: jest.Mock };
    let depositSyncQueue: {
        isPaused: jest.Mock;
        pause: jest.Mock;
        resume: jest.Mock;
        name: string;
    };
    let processor: QuidaxDepositSyncProcessor;

    beforeEach(() => {
        tradingService = { syncUserDeposits: jest.fn() };
        depositSyncQueue = {
            isPaused: jest.fn().mockResolvedValue(false),
            pause: jest.fn().mockResolvedValue(undefined),
            resume: jest.fn().mockResolvedValue(undefined),
            name: "quidaxDepositSync",
        };

        processor = new QuidaxDepositSyncProcessor(
            tradingService as never,
            depositSyncQueue as never,
        );
        jest.spyOn((processor as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((processor as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((processor as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("calls syncUserDeposits with the job's user_id and returns the result", async () => {
        const result = { data: { synced: 0 } };
        tradingService.syncUserDeposits.mockResolvedValue(result);

        await expect(
            processor.handleSyncDeposits({ data: { user_id: 5 } } as never),
        ).resolves.toBe(result);

        expect(tradingService.syncUserDeposits).toHaveBeenCalledWith(5);
        expect(depositSyncQueue.pause).not.toHaveBeenCalled();
    });

    it("logs a summary line when at least one deposit was synced", async () => {
        const logSpy = (processor as any).logger.log as jest.Mock;
        tradingService.syncUserDeposits.mockResolvedValue({ data: { synced: 3 } });

        await processor.handleSyncDeposits({ data: { user_id: 7 } } as never);

        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining("User 7: synced 3 deposits"),
        );
    });

    it("does not log a summary when no deposits were synced", async () => {
        const logSpy = (processor as any).logger.log as jest.Mock;
        tradingService.syncUserDeposits.mockResolvedValue({ data: { synced: 0 } });

        await processor.handleSyncDeposits({ data: { user_id: 9 } } as never);

        expect(logSpy).not.toHaveBeenCalledWith(
            expect.stringContaining("synced"),
        );
    });

    it("re-throws non-throttle errors so Bull retry/backoff applies", async () => {
        const err = new Error("provider down");
        tradingService.syncUserDeposits.mockRejectedValue(err);

        await expect(
            processor.handleSyncDeposits({ data: { user_id: 11 } } as never),
        ).rejects.toBe(err);

        expect(depositSyncQueue.pause).not.toHaveBeenCalled();
    });

    it("pauses the queue and re-throws when Quidax throttles", async () => {
        const err = new QuidaxTooManyRequestError("rate limited");
        tradingService.syncUserDeposits.mockRejectedValue(err);

        await expect(
            processor.handleSyncDeposits({ data: { user_id: 13 } } as never),
        ).rejects.toBe(err);

        expect(depositSyncQueue.pause).toHaveBeenCalledWith(true);
    });
});
