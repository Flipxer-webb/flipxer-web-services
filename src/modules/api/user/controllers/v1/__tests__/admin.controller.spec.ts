import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { isStub() { return true; } },
    __esModule: true,
}));

import { AdminUserController } from "../admin";
import { AdminUserService } from "../../../services/admin";

describe("AdminUserController", () => {
    let controller: AdminUserController;
    let adminService: {
        getAnalyticsOverview: jest.Mock;
        getUserList: jest.Mock;
        getUserFilteredStats: jest.Mock;
        getUserTransactionList: jest.Mock;
        getUserInfo: jest.Mock;
        unflagUser: jest.Mock;
        flagUser: jest.Mock;
    };

    beforeEach(async () => {
        adminService = {
            getAnalyticsOverview: jest.fn(),
            getUserList: jest.fn(),
            getUserFilteredStats: jest.fn(),
            getUserTransactionList: jest.fn(),
            getUserInfo: jest.fn(),
            unflagUser: jest.fn(),
            flagUser: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminUserController],
            providers: [{ provide: AdminUserService, useValue: adminService }],
        }).compile();

        controller = module.get(AdminUserController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should delegate analytics overview and user list queries", async () => {
        adminService.getAnalyticsOverview.mockResolvedValue({ data: { totalUsers: 10 } });
        adminService.getUserList.mockResolvedValue({ data: { records: [] } });
        adminService.getUserFilteredStats.mockResolvedValue({ data: { total: 3 } });

        await expect(controller.getAnalyticsOverview("month", "2026-01-01", "2026-01-31")).resolves.toEqual({ data: { totalUsers: 10 } });
        await expect(controller.getAllUsers({ pageNumber: 1 } as any)).resolves.toEqual({ data: { records: [] } });
        await expect(controller.getUserStats({ status: "active" } as any)).resolves.toEqual({ data: { total: 3 } });
    });

    it("should get user transactions and user info", async () => {
        adminService.getUserTransactionList.mockResolvedValue({ data: { records: [1] } });
        adminService.getUserInfo.mockResolvedValue({ data: { id: 7 } });

        const txResult = await controller.getUserTransactionList(7, { pageNumber: 1 } as any);
        const infoResult = await controller.getUserInfo(7);

        expect(adminService.getUserTransactionList).toHaveBeenCalledWith({ pageNumber: 1 }, 7);
        expect(adminService.getUserInfo).toHaveBeenCalledWith(7);
        expect(txResult.data.records).toEqual([1]);
        expect(infoResult.data.id).toBe(7);
    });

    it("should flag and unflag users", async () => {
        adminService.unflagUser.mockResolvedValue({ message: "unflagged" });
        adminService.flagUser.mockResolvedValue({ message: "flagged" });

        await expect(controller.unflagUser({ userId: 8 } as any)).resolves.toEqual({ message: "unflagged" });
        await expect(controller.flagUser({ userId: 8, reason: "risk" } as any)).resolves.toEqual({ message: "flagged" });
    });
});