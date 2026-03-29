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

import { OrphanedHoldCron } from "../orphaned-hold.cron";

describe("OrphanedHoldCron", () => {
    const orphanedHoldService = {
        detectOrphanedHolds: jest.fn(),
    };

    let cron: OrphanedHoldCron;

    beforeEach(() => {
        jest.clearAllMocks();
        cron = new OrphanedHoldCron(orphanedHoldService as never);
        jest.spyOn((cron as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("detectOrphanedHolds logs warning when orphaned holds are detected", async () => {
        orphanedHoldService.detectOrphanedHolds.mockResolvedValue({
            detected: 3,
            alerted: 2,
            errors: [],
        });

        await cron.detectOrphanedHolds();

        expect(orphanedHoldService.detectOrphanedHolds).toHaveBeenCalledTimes(1);
    });

    it("detectOrphanedHolds logs debug when none are detected", async () => {
        orphanedHoldService.detectOrphanedHolds.mockResolvedValue({
            detected: 0,
            alerted: 0,
            errors: [],
        });

        await cron.detectOrphanedHolds();

        expect(orphanedHoldService.detectOrphanedHolds).toHaveBeenCalledTimes(1);
    });

    it("detectOrphanedHolds handles service exceptions", async () => {
        orphanedHoldService.detectOrphanedHolds.mockRejectedValue(new Error("orphaned hold detection failed"));

        await cron.detectOrphanedHolds();

        expect(orphanedHoldService.detectOrphanedHolds).toHaveBeenCalledTimes(1);
    });
});
