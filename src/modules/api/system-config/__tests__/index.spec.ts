import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services/system-settings.service", () => ({
    SystemSettingsService: class SystemSettingsServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/feature-flag.service", () => ({
    FeatureFlagService: class FeatureFlagServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/maintenance-mode.service", () => ({
    MaintenanceModeService: class MaintenanceModeServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/system-settings.controller", () => ({
    AdminSystemSettingsController: class AdminSystemSettingsControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/feature-flag.controller", () => ({
    AdminFeatureFlagController: class AdminFeatureFlagControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../middleware/maintenance.middleware", () => ({
    MaintenanceMiddleware: class MaintenanceMiddlewareStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../session", () => ({
    SessionModule: class SessionModuleStub { readonly stub = true; },
    __esModule: true,
}));

import { SystemConfigModule } from "../index";
import { MaintenanceMiddleware } from "../middleware/maintenance.middleware";

describe("SystemConfigModule", () => {
    it("registers imports/controllers/providers/exports metadata", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, SystemConfigModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SystemConfigModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SystemConfigModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, SystemConfigModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(imports).toHaveLength(1);
        expect(controllers).toHaveLength(2);
        expect(providers).toHaveLength(3);
        expect(exportsMeta).toHaveLength(3);
    });

    it("configures maintenance middleware exclusions and route scope", () => {
        const exclude = jest.fn().mockReturnThis();
        const forRoutes = jest.fn().mockReturnThis();
        const apply = jest.fn().mockReturnValue({ exclude, forRoutes });
        const consumer = { apply } as any;

        const moduleInstance = new SystemConfigModule();
        moduleInstance.configure(consumer);

        expect(apply).toHaveBeenCalledWith(MaintenanceMiddleware);
        expect(exclude).toHaveBeenCalledWith(
            { method: 5, path: "admin" },
            { method: 5, path: "admin/{*path}" },
            { method: 5, path: "health" },
            { method: 5, path: "health/{*path}" },
        );
        expect(forRoutes).toHaveBeenCalledWith({ method: 5, path: "{*path}" });
    });
});