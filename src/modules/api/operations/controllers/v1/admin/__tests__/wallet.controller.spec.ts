jest.mock("@/utils/api-response-util", () => ({
    buildResponse: jest.fn((payload) => payload),
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { readonly __stub = true; },
    EnabledAccountGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    __esModule: true,
}));

import { AdminWalletController } from "../wallet.controller";

describe("AdminWalletController", () => {
    let controller: AdminWalletController;
    const mockWalletService = {
        getWalletBalances: jest.fn(),
        getWalletBalance: jest.fn(),
        getWalletStatistics: jest.fn(),
        getLiquidityThresholds: jest.fn(),
        updateLiquidityThresholds: jest.fn(),
        checkLiquidityThresholds: jest.fn(),
        invalidateWalletCache: jest.fn(),
    };
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockUser = { id: 1 } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        controller = new AdminWalletController(
            mockWalletService as any,
            mockAuditLogService as any,
        );
    });

    it("should get wallet balances", async () => {
        mockWalletService.getWalletBalances.mockResolvedValue([]);
        await controller.getWalletBalances(false);
        expect(mockWalletService.getWalletBalances).toHaveBeenCalledWith(false);
    });

    it("should get single wallet balance", async () => {
        mockWalletService.getWalletBalance.mockResolvedValue({ currency: "BTC" });
        await controller.getWalletBalance("BTC", false);
        expect(mockWalletService.getWalletBalance).toHaveBeenCalledWith("BTC", false);
    });

    it("should get wallet statistics", async () => {
        mockWalletService.getWalletStatistics.mockResolvedValue({});
        await controller.getWalletStatistics();
        expect(mockWalletService.getWalletStatistics).toHaveBeenCalled();
    });

    it("should get liquidity thresholds", async () => {
        mockWalletService.getLiquidityThresholds.mockResolvedValue([]);
        await controller.getLiquidityThresholds();
        expect(mockWalletService.getLiquidityThresholds).toHaveBeenCalled();
    });

    it("should update thresholds and log audit", async () => {
        const thresholds = [{ currency: "BTC", minBalance: 1 }];
        mockWalletService.updateLiquidityThresholds.mockResolvedValue(thresholds);
        await controller.updateLiquidityThresholds(thresholds as any, mockUser);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "UPDATE_LIQUIDITY_THRESHOLDS", adminId: 1 }),
        );
    });

    it("should throw BadRequestException when thresholds is not an array", async () => {
        await expect(
            controller.updateLiquidityThresholds("not-an-array" as any, mockUser),
        ).rejects.toThrow("Request body must be an array of thresholds");
    });

    it("should check liquidity thresholds", async () => {
        mockWalletService.checkLiquidityThresholds.mockResolvedValue({ breaches: [] });
        await controller.checkLiquidityThresholds();
        expect(mockWalletService.checkLiquidityThresholds).toHaveBeenCalled();
    });

    it("should invalidate cache and log audit", async () => {
        mockWalletService.invalidateWalletCache.mockResolvedValue(undefined);
        await controller.invalidateCache(mockUser);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "INVALIDATE_WALLET_CACHE" }),
        );
    });
});
