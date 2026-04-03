import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../../auth", () => ({
    AuthModule: class AuthModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1", () => ({
    UserController: class UserControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/preferences.controller", () => ({
    PreferencesController: class PreferencesControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin", () => ({
    AdminUserController: class AdminUserControllerStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services", () => ({
    UserService: class UserServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/admin", () => ({
    AdminUserService: class AdminUserServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../services/preferences.service", () => ({
    PreferencesService: class PreferencesServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/core/redisCache", () => ({
    CachingModule: class CachingModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../auth/services/tier.service", () => ({
    TierService: class TierServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/core/prisma", () => ({
    PrismaModule: class PrismaModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../trade/services/ledger/ledger.service", () => ({
    LedgerService: class LedgerServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../trade/services/rate.service", () => ({
    RateService: class RateServiceStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../session", () => ({
    SessionModule: class SessionModuleStub { readonly stub = true; },
    __esModule: true,
}));

jest.mock("../../operations/services/slack-webhook.service", () => ({
    SlackWebhookService: class SlackWebhookServiceStub { readonly stub = true; },
    __esModule: true,
}));

import * as userModuleExports from "../index";

describe("UserModule", () => {
    it("registers imports/controllers/providers/exports and barrel exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, userModuleExports.UserModule) as Array<any>;
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, userModuleExports.UserModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, userModuleExports.UserModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, userModuleExports.UserModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(imports).toHaveLength(4);
        expect(controllers).toHaveLength(3);
        expect(providers).toHaveLength(7);
        expect(exportsMeta).toHaveLength(3);

        const forwardRefImport = imports.find((imp) => typeof imp?.forwardRef === "function");
        expect(forwardRefImport).toBeDefined();
        expect(typeof forwardRefImport.forwardRef()).toBe("function");

        expect(userModuleExports.UserModule).toBeDefined();
        expect(userModuleExports.User).toBeDefined();
    });
});
