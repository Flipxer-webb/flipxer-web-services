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

import { AdminLiquidityAlertController } from "../liquidity-alert.controller";

describe("AdminLiquidityAlertController", () => {
    let controller: AdminLiquidityAlertController;
    const mockAlertService = {
        getAlerts: jest.fn(),
        getPendingAlertsSummary: jest.fn(),
        getAlertStatistics: jest.fn(),
        createAlert: jest.fn(),
        runLiquidityCheck: jest.fn(),
        acknowledgeAlert: jest.fn(),
        resolveAlert: jest.fn(),
        escalateAlert: jest.fn(),
    };
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockUser = { id: 1 } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        controller = new AdminLiquidityAlertController(
            mockAlertService as any,
            mockAuditLogService as any,
        );
    });

    it("should get alerts with filters", async () => {
        mockAlertService.getAlerts.mockResolvedValue({ data: [], total: 0 });
        await controller.getAlerts("active", "BTC", "low", "2026-01-01", "2026-01-31", 1, 20);
        expect(mockAlertService.getAlerts).toHaveBeenCalled();
    });

    it("should get pending alerts summary", async () => {
        mockAlertService.getPendingAlertsSummary.mockResolvedValue({ count: 5 });
        await controller.getPendingAlertsSummary();
        expect(mockAlertService.getPendingAlertsSummary).toHaveBeenCalled();
    });

    it("should get alert statistics", async () => {
        mockAlertService.getAlertStatistics.mockResolvedValue({ total: 10 });
        await controller.getAlertStatistics(7);
        expect(mockAlertService.getAlertStatistics).toHaveBeenCalledWith(7);
    });

    it("should create alert and log audit", async () => {
        const dto = { currency: "BTC", alertType: "low_balance" };
        mockAlertService.createAlert.mockResolvedValue({ id: 1 });
        await controller.createAlert(dto as any, mockUser);
        expect(mockAlertService.createAlert).toHaveBeenCalledWith(dto);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "CREATE_LIQUIDITY_ALERT", adminId: 1 }),
        );
    });

    it("should run liquidity check and log audit", async () => {
        mockAlertService.runLiquidityCheck.mockResolvedValue({ checked: 5 });
        await controller.runLiquidityCheck(mockUser);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "RUN_LIQUIDITY_CHECK" }),
        );
    });

    it("should acknowledge alert and log audit", async () => {
        mockAlertService.acknowledgeAlert.mockResolvedValue({ id: 1 });
        await controller.acknowledgeAlert(1, mockUser);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "ACKNOWLEDGE_LIQUIDITY_ALERT", resourceId: "1" }),
        );
    });

    it("should resolve alert and log audit", async () => {
        const dto = { resolution: "topped up" };
        mockAlertService.resolveAlert.mockResolvedValue({ id: 1 });
        await controller.resolveAlert(1, mockUser, dto as any);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "RESOLVE_LIQUIDITY_ALERT", resourceId: "1" }),
        );
    });

    it("should escalate alert and log audit", async () => {
        mockAlertService.escalateAlert.mockResolvedValue({ id: 1 });
        await controller.escalateAlert(1, mockUser);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "ESCALATE_LIQUIDITY_ALERT", resourceId: "1" }),
        );
    });
});
