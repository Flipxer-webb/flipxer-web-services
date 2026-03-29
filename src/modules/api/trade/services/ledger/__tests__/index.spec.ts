jest.mock("@/modules/api/user", () => {
    class AccountDeletedException extends Error { constructor() { super("Account deleted"); } }
    class UserNotFoundException extends Error { constructor() { super("User not found"); } }
    return {
        User: () => () => {},
        ClientData: () => () => {},
        UserModule: class { readonly __stub = true },
        AccountDeletedException,
        UserNotFoundException,
        __esModule: true,
    };
});

import * as ledgerServices from "../index";

describe("trade ledger index", () => {
    it("re-exports ledger service classes", () => {
        expect(ledgerServices.LedgerService).toBeDefined();
        expect(ledgerServices.WithdrawalQueueService).toBeDefined();
        expect(ledgerServices.FloatConfigService).toBeDefined();
        expect(ledgerServices.ReconciliationService).toBeDefined();
        expect(ledgerServices.SweepService).toBeDefined();
        expect(ledgerServices.DepositReviewService).toBeDefined();
        expect(ledgerServices.OrphanedHoldService).toBeDefined();
        expect(ledgerServices.SolvencyService).toBeDefined();
        expect(ledgerServices.TransactionMonitorService).toBeDefined();
    });
});