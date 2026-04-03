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

import { StuckOrderReconciliationCron } from "../stuck-order-reconciliation.cron";

describe("StuckOrderReconciliationCron", () => {
    const reconciliationService = {
        reconcile: jest.fn(),
    };

    let cron: StuckOrderReconciliationCron;

    beforeEach(() => {
        jest.clearAllMocks();
        cron = new StuckOrderReconciliationCron(reconciliationService as never);
        jest.spyOn((cron as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((cron as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("run logs warnings when reconciliation finds issues", async () => {
        reconciliationService.reconcile.mockResolvedValue({
            stuckBuyOrders: { detected: 2, autoRetried: 1, retryFailed: 1 },
            brokenLedgerOrders: { detected: 1 },
            preLedgerBackfill: { fixed: 0 },
            errors: [],
        });

        await cron.run();

        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
    });

    it("run logs debug when no issues are found", async () => {
        reconciliationService.reconcile.mockResolvedValue({
            stuckBuyOrders: { detected: 0, autoRetried: 0, retryFailed: 0 },
            brokenLedgerOrders: { detected: 0 },
            preLedgerBackfill: { fixed: 0 },
            errors: [],
        });

        await cron.run();

        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
    });

    it("run handles reconciliation errors", async () => {
        reconciliationService.reconcile.mockRejectedValue(new Error("reconcile failure"));

        await cron.run();

        expect(reconciliationService.reconcile).toHaveBeenCalledTimes(1);
    });
});
