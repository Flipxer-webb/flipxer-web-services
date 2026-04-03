import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../controllers/v1", () => ({
    TransactionController: class TransactionControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin", () => ({
    AdminTransactionController: class AdminTransactionControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../services", () => ({
    TransactionService: class TransactionServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../services/admin-transaction.service", () => ({
    AdminTransactionService: class AdminTransactionServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../../trade", () => ({
    TradingModule: class TradingModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../../settings", () => ({
    SettingModule: class SettingModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../../session", () => ({
    SessionModule: class SessionModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

import { TransactionModule } from "../index";

describe("TransactionModule", () => {
    it("registers providers/controllers/imports/exports metadata", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, TransactionModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TransactionModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, TransactionModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, TransactionModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(imports).toHaveLength(3);
        expect(providers).toHaveLength(2);
        expect(controllers).toHaveLength(2);
        expect(exportsMeta).toHaveLength(2);
    });
});