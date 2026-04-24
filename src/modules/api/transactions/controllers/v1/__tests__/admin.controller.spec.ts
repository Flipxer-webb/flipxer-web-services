import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    CountryBlockGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

jest.mock("../../../services", () => ({
    TransactionService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("../../../services/admin-transaction.service", () => ({
    AdminTransactionService: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/trade/services", () => ({
    TradingService: class { isStub() { return true; } },
    __esModule: true,
}));

import { AdminTransactionController } from "../admin";
import { TransactionService } from "../../../services";
import { AdminTransactionService } from "../../../services/admin-transaction.service";
import { TradingService } from "@/modules/api/trade/services";
import { AuditLogService } from "@/modules/api/audit-log";

describe("AdminTransactionController", () => {
    let controller: AdminTransactionController;
    let transactionService: {
        getUserTransactionHistory: jest.Mock;
        getRecentTransactionList: jest.Mock;
        getTransactionDetail: jest.Mock;
    };
    let adminTransactionService: {
        getPendingTransactions: jest.Mock;
        getFailedTransactions: jest.Mock;
        getTransactionStats: jest.Mock;
        getTransactionAuditLogs: jest.Mock;
        updateTransactionStatus: jest.Mock;
        manualApproveTransaction: jest.Mock;
        refundTransaction: jest.Mock;
        retryTransaction: jest.Mock;
        bulkUpdateStatus: jest.Mock;
        exportTransactions: jest.Mock;
    };
    let tradingService: { syncUserDeposits: jest.Mock; debugUserWallet: jest.Mock };
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' }, user: { id: 1 } } as any;

    beforeEach(async () => {
        transactionService = {
            getUserTransactionHistory: jest.fn(),
            getRecentTransactionList: jest.fn(),
            getTransactionDetail: jest.fn(),
        };
        adminTransactionService = {
            getPendingTransactions: jest.fn(),
            getFailedTransactions: jest.fn(),
            getTransactionStats: jest.fn(),
            getTransactionAuditLogs: jest.fn(),
            updateTransactionStatus: jest.fn(),
            manualApproveTransaction: jest.fn(),
            refundTransaction: jest.fn(),
            retryTransaction: jest.fn(),
            bulkUpdateStatus: jest.fn(),
            exportTransactions: jest.fn(),
        };
        tradingService = { syncUserDeposits: jest.fn(), debugUserWallet: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminTransactionController],
            providers: [
                { provide: TransactionService, useValue: transactionService },
                { provide: AdminTransactionService, useValue: adminTransactionService },
                { provide: TradingService, useValue: tradingService },
                { provide: AuditLogService, useValue: mockAuditLogService },
            ],
        }).compile();

        controller = module.get(AdminTransactionController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should get all transactions", async () => {
        const query = { pageNumber: 1 } as any;
        transactionService.getUserTransactionHistory.mockResolvedValue({ data: [] });

        const result = await controller.getAllTransactionList(query);

        expect(transactionService.getUserTransactionHistory).toHaveBeenCalledWith(query);
        expect(result.data).toEqual([]);
    });

    it("should get recent transactions", async () => {
        transactionService.getRecentTransactionList.mockResolvedValue({ data: [1] });

        const result = await controller.getRecentTransactionList();

        expect(result.data).toEqual([1]);
    });

    it("should delegate pending, failed and stats queries", async () => {
        const query = { type: "BUY" } as any;
        adminTransactionService.getPendingTransactions.mockResolvedValue({ message: "pending" });
        adminTransactionService.getFailedTransactions.mockResolvedValue({ message: "failed" });
        adminTransactionService.getTransactionStats.mockResolvedValue({ data: { overview: { total: 4 } } });

        await expect(controller.getPendingTransactions(query)).resolves.toEqual({ message: "pending" });
        await expect(controller.getFailedTransactions(query)).resolves.toEqual({ message: "failed" });
        await expect(controller.getTransactionStats("month", "completed", "BUY", "2026-01-01", "2026-01-31")).resolves.toEqual({ data: { overview: { total: 4 } } });
    });

    it("should get transaction detail and audit logs", async () => {
        transactionService.getTransactionDetail.mockResolvedValue({ data: { id: "TX-1" } });
        adminTransactionService.getTransactionAuditLogs.mockResolvedValue({ data: [{ id: 1 }] });

        const detailResult = await controller.getTransactionDetail("TX-1");
        const auditResult = await controller.getTransactionAuditLogs("TX-1");

        expect((detailResult as any).data.id).toBe("TX-1");
        expect(auditResult.data).toHaveLength(1);
    });

    it("should update transaction status using req user id", async () => {
        const dto = { status: "completed" } as any;
        adminTransactionService.updateTransactionStatus.mockResolvedValue({ message: "updated" });

        const result = await controller.updateTransactionStatus("TX-1", dto, { user: { id: 88 } });

        expect(adminTransactionService.updateTransactionStatus).toHaveBeenCalledWith("TX-1", dto, 88);
        expect(result.message).toBe("updated");
    });

    it("should approve, refund, retry, bulk update and export", async () => {
        const admin = { id: 9 } as any;
        adminTransactionService.manualApproveTransaction.mockResolvedValue({ message: "approved" });
        adminTransactionService.refundTransaction.mockResolvedValue({ message: "refunded" });
        adminTransactionService.retryTransaction.mockResolvedValue({ message: "retried" });
        adminTransactionService.bulkUpdateStatus.mockResolvedValue({ message: "bulk" });
        adminTransactionService.exportTransactions.mockResolvedValue({ data: "csv" });

        await expect(controller.manualApproveTransaction("TX-1", { confirmed: true } as any, admin)).resolves.toEqual({ message: "approved" });
        await expect(controller.refundTransaction("TX-1", { reason: "x" } as any, { user: { id: 5 } })).resolves.toEqual({ message: "refunded" });
        await expect(controller.retryTransaction("TX-1", { user: { id: 5 } })).resolves.toEqual({ message: "retried" });
        await expect(controller.bulkUpdateStatus({ ids: [1] } as any, { user: { id: 5 } })).resolves.toEqual({ message: "bulk" });
        await expect(controller.exportTransactions({ type: "BUY" } as any)).resolves.toEqual({ data: "csv" });
    });

    it("should sync deposits and debug wallet", async () => {
        tradingService.syncUserDeposits.mockResolvedValue({ message: "synced" });
        tradingService.debugUserWallet.mockResolvedValue({ data: { currency: "BTC" } });

        const syncResult = await controller.syncUserDeposits(15, mockReq);
        const debugResult = await controller.debugWallet(15, "BTC");

        expect(tradingService.syncUserDeposits).toHaveBeenCalledWith(15);
        expect(tradingService.debugUserWallet).toHaveBeenCalledWith(15, "BTC");
        expect(syncResult.message).toBe("synced");
        expect((debugResult as any).data.currency).toBe("BTC");
    });
});