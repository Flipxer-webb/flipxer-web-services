jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {
        readonly __stub = true;
    },
    EnabledAccountGuard: class EnabledAccountGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class PermissionGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    Permissions: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/enums/role", () => ({
    PermissionName: {
        ANALYTICS_READ: "analytics.read",
    },
    __esModule: true,
}));

import { AnalyticsController } from "../index";

describe("AnalyticsController", () => {
    const service = {
        getDashboardOverview: jest.fn(),
        getTransactionVolume: jest.fn(),
        getTransactionsByStatus: jest.fn(),
        getUserGrowth: jest.fn(),
        getUserActivity: jest.fn(),
        getRevenueAnalytics: jest.fn(),
        getAssetDistribution: jest.fn(),
        getConversionFunnel: jest.fn(),
    };

    let controller: AnalyticsController;

    beforeEach(() => {
        jest.clearAllMocks();
        controller = new AnalyticsController(service as any);
    });

    it("delegates all analytics endpoints", async () => {
        service.getDashboardOverview.mockResolvedValue({ kind: "overview" });
        service.getTransactionVolume.mockResolvedValue({ kind: "volume" });
        service.getTransactionsByStatus.mockResolvedValue({ kind: "status" });
        service.getUserGrowth.mockResolvedValue({ kind: "growth" });
        service.getUserActivity.mockResolvedValue({ kind: "activity" });
        service.getRevenueAnalytics.mockResolvedValue({ kind: "revenue" });
        service.getAssetDistribution.mockResolvedValue({ kind: "assets" });
        service.getConversionFunnel.mockResolvedValue({ kind: "funnel" });

        await expect(controller.getDashboardOverview({ period: "month" } as never)).resolves.toEqual({ kind: "overview" });
        await expect(controller.getTransactionVolume({ period: "month" } as never)).resolves.toEqual({ kind: "volume" });
        await expect(controller.getTransactionsByStatus({ period: "month" } as never)).resolves.toEqual({ kind: "status" });
        await expect(controller.getUserGrowth({ period: "month" } as never)).resolves.toEqual({ kind: "growth" });
        await expect(controller.getUserActivity({ period: "month" } as never)).resolves.toEqual({ kind: "activity" });
        await expect(controller.getRevenueAnalytics({ period: "month" } as never)).resolves.toEqual({ kind: "revenue" });
        await expect(controller.getAssetDistribution({ limit: 5 } as never)).resolves.toEqual({ kind: "assets" });
        await expect(controller.getConversionFunnel({ period: "month" } as never)).resolves.toEqual({ kind: "funnel" });

        expect(service.getDashboardOverview).toHaveBeenCalled();
        expect(service.getTransactionVolume).toHaveBeenCalled();
        expect(service.getTransactionsByStatus).toHaveBeenCalled();
        expect(service.getUserGrowth).toHaveBeenCalled();
        expect(service.getUserActivity).toHaveBeenCalled();
        expect(service.getRevenueAnalytics).toHaveBeenCalled();
        expect(service.getAssetDistribution).toHaveBeenCalled();
        expect(service.getConversionFunnel).toHaveBeenCalled();
    });
});
