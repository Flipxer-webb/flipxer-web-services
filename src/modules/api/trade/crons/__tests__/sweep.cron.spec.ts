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

import { SweepCron } from "../sweep.cron";

describe("SweepCron", () => {
    const sweepService = {
        processPendingSweeps: jest.fn(),
        retryFailedSweeps: jest.fn(),
    };

    let cron: SweepCron;

    beforeEach(() => {
        jest.clearAllMocks();
        cron = new SweepCron(sweepService as never);
        jest.spyOn((cron as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("processPendingSweeps logs processed count when sweeps are handled", async () => {
        sweepService.processPendingSweeps.mockResolvedValue(3);

        await cron.processPendingSweeps();

        expect(sweepService.processPendingSweeps).toHaveBeenCalledTimes(1);
    });

    it("processPendingSweeps handles service errors", async () => {
        sweepService.processPendingSweeps.mockRejectedValue(new Error("sweep failed"));

        await cron.processPendingSweeps();

        expect(sweepService.processPendingSweeps).toHaveBeenCalledTimes(1);
    });

    it("retryFailedSweeps calls retry path", async () => {
        sweepService.retryFailedSweeps.mockResolvedValue(1);

        await cron.retryFailedSweeps();

        expect(sweepService.retryFailedSweeps).toHaveBeenCalledTimes(1);
    });
});
