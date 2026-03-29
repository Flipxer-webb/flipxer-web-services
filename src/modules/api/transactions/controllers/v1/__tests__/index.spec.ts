jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        readonly __stub = true;
    },
    CountryBlockGuard: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    __esModule: true,
}));

import { TransactionController } from "../index";

describe("TransactionController", () => {
    let controller: TransactionController;
    let transactionService: {
        getUserTransactionHistory: jest.Mock;
        downloadGeneralReport: jest.Mock;
        getTransactionDetail: jest.Mock;
    };

    beforeEach(() => {
        transactionService = {
            getUserTransactionHistory: jest.fn(),
            downloadGeneralReport: jest.fn(),
            getTransactionDetail: jest.fn(),
        };

        controller = new TransactionController(transactionService as never);
    });

    it("delegates transaction history query", async () => {
        const user = { id: 11 };
        const query = { pageNumber: 1, pageSize: 20 };
        transactionService.getUserTransactionHistory.mockResolvedValue({ records: [] });

        await expect(controller.getUserTransactionHistory(user as never, query as never)).resolves.toEqual({ records: [] });
        expect(transactionService.getUserTransactionHistory).toHaveBeenCalledWith(query, user);
    });

    it("delegates downloadGeneralReport", async () => {
        const user = { id: 21 };
        const dto = { startDate: "2026-01-01", endDate: "2026-01-31" };
        transactionService.downloadGeneralReport.mockResolvedValue({ csv: "content" });

        await expect(controller.downloadGeneralReport(user as never, dto as never)).resolves.toEqual({ csv: "content" });
        expect(transactionService.downloadGeneralReport).toHaveBeenCalledWith(user, dto);
    });

    it("delegates getTransactionDetail", async () => {
        const user = { id: 31 };
        transactionService.getTransactionDetail.mockResolvedValue({ id: "TX-31" });

        await expect(controller.getTransactionDetail(user as never, "TX-31")).resolves.toEqual({ id: "TX-31" });
        expect(transactionService.getTransactionDetail).toHaveBeenCalledWith("TX-31", 31);
    });
});