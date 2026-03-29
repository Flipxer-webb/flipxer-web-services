import { BadRequestException } from "@nestjs/common";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        isStub() {
            return true;
        }
    },
    EnabledAccountGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

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

import { AdminSystemSettingsController } from "../system-settings.controller";

describe("AdminSystemSettingsController", () => {
    let controller: AdminSystemSettingsController;
    let settingsService: {
        getAllSettings: jest.Mock;
        getSetting: jest.Mock;
        setSetting: jest.Mock;
        deleteSetting: jest.Mock;
    };
    let maintenanceService: {
        getMaintenanceConfig: jest.Mock;
        enableMaintenance: jest.Mock;
        disableMaintenance: jest.Mock;
        updateMaintenanceConfig: jest.Mock;
    };

    const admin = { id: 321 } as any;

    beforeEach(() => {
        settingsService = {
            getAllSettings: jest.fn(),
            getSetting: jest.fn(),
            setSetting: jest.fn(),
            deleteSetting: jest.fn(),
        };

        maintenanceService = {
            getMaintenanceConfig: jest.fn(),
            enableMaintenance: jest.fn(),
            disableMaintenance: jest.fn(),
            updateMaintenanceConfig: jest.fn(),
        };

        controller = new AdminSystemSettingsController(
            settingsService as never,
            maintenanceService as never,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("returns all settings and a single setting", async () => {
        settingsService.getAllSettings.mockResolvedValue([{ key: "maintenanceMode", value: false }]);
        settingsService.getSetting.mockResolvedValue("on");

        const all = await controller.getAllSettings();
        const single = await controller.getSetting("featureFlag");

        expect(settingsService.getAllSettings).toHaveBeenCalledTimes(1);
        expect(all.message).toBe("System settings retrieved successfully");
        expect(single.data).toEqual({ key: "featureFlag", value: "on" });
    });

    it("throws for invalid key param types", async () => {
        await expect(controller.getSetting(["bad"] as any)).rejects.toBeInstanceOf(BadRequestException);
        await expect(controller.deleteSetting(["bad"] as any)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("saves single setting and bulk updates settings", async () => {
        settingsService.setSetting.mockResolvedValue(undefined);

        const saveResult = await controller.setSetting({ key: "k1", value: "v1" } as any, admin);
        const bulkResult = await controller.bulkUpdateSettings(
            [
                { key: "k1", value: "v1" },
                { key: "k2", value: "v2" },
            ] as any,
            admin,
        );

        expect(saveResult.message).toBe("Setting saved successfully");
        expect(settingsService.setSetting).toHaveBeenNthCalledWith(1, { key: "k1", value: "v1" }, 321);
        expect(settingsService.setSetting).toHaveBeenNthCalledWith(2, { key: "k1", value: "v1" }, 321);
        expect(settingsService.setSetting).toHaveBeenNthCalledWith(3, { key: "k2", value: "v2" }, 321);
        expect(bulkResult.message).toBe("2 settings updated successfully");
    });

    it("rejects bulk update when settings is not an array", async () => {
        await expect(controller.bulkUpdateSettings({ key: "nope" } as any, admin)).rejects.toBeInstanceOf(BadRequestException);
    });

    it("deletes a setting and returns success payload", async () => {
        settingsService.deleteSetting.mockResolvedValue(undefined);

        const result = await controller.deleteSetting("k-delete");

        expect(settingsService.deleteSetting).toHaveBeenCalledWith("k-delete");
        expect(result.message).toBe("Setting deleted successfully");
    });

    it("handles maintenance status, enable/disable and config update", async () => {
        maintenanceService.getMaintenanceConfig.mockResolvedValue({ enabled: false });
        maintenanceService.enableMaintenance.mockResolvedValue({ enabled: true });
        maintenanceService.disableMaintenance.mockResolvedValue({ enabled: false });
        maintenanceService.updateMaintenanceConfig.mockResolvedValue({ allowedIps: ["127.0.0.1"] });

        const status = await controller.getMaintenanceStatus();
        const enabled = await controller.enableMaintenanceMode(
            {
                message: "scheduled",
                estimatedEndTime: "2026-04-01T12:00:00.000Z",
                allowedIps: ["127.0.0.1"],
            },
            admin,
        );
        const disabled = await controller.disableMaintenanceMode(admin);
        const updated = await controller.updateMaintenanceConfig(
            { allowedIps: ["127.0.0.1", "10.0.0.1"] },
            admin,
        );

        expect(status.data).toEqual({ enabled: false });
        expect(maintenanceService.enableMaintenance).toHaveBeenCalledWith(
            "scheduled",
            321,
            {
                estimatedEndTime: "2026-04-01T12:00:00.000Z",
                allowedIps: ["127.0.0.1"],
            },
        );
        expect(maintenanceService.disableMaintenance).toHaveBeenCalledWith(321);
        expect(maintenanceService.updateMaintenanceConfig).toHaveBeenCalledWith(
            { allowedIps: ["127.0.0.1", "10.0.0.1"] },
            321,
        );
        expect(enabled.message).toBe("Maintenance mode enabled successfully");
        expect(disabled.message).toBe("Maintenance mode disabled successfully");
        expect(updated.message).toBe("Maintenance configuration updated successfully");
    });
});
