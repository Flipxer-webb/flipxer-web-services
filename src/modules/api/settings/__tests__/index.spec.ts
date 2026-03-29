import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services", () => ({
    SettingService: class SettingServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1", () => ({
    SettingController: class SettingControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin", () => ({
    AdminSettingController: class AdminSettingControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin-swap-pairs.controller", () => ({
    AdminSwapPairController: class AdminSwapPairControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/core/sms", () => ({
    SmsModule: class SmsModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/core/email", () => ({
    EmailModule: class EmailModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/trade", () => ({
    TradingModule: class TradingModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/session", () => ({
    SessionModule: class SessionModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/config", () => ({
    jwtSecret: "unit-test-jwt-secret",
    __esModule: true,
}));

import { SettingModule } from "../index";
import { SettingService } from "../services";

describe("SettingModule", () => {
    it("registers imports, controllers, providers, and exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, SettingModule) as Array<any>;
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SettingModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, SettingModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, SettingModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(providers).toEqual([SettingService]);
        expect(exportsMeta).toEqual([SettingService]);

        const forwardRefImport = imports.find((imp) => typeof imp?.forwardRef === "function");
        expect(forwardRefImport).toBeDefined();
        expect(typeof forwardRefImport.forwardRef()).toBe("function");
    });
});
