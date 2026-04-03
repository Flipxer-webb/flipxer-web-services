import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services", () => ({
    BankService: class BankServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers", () => ({
    BankController: class BankControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/fincra-webhook.controller", () => ({
    FincraWebhookController: class FincraWebhookControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/nomba-webhook.controller", () => ({
    NombaWebhookController: class NombaWebhookControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/admin-order.controller", () => ({
    AdminOrderController: class AdminOrderControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../../../core/prisma/services", () => ({
    PrismaService: class PrismaServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/factory/bank/bank.module", () => ({
    BankFactoryModule: class BankFactoryModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading", () => ({
    TradingFactoryModule: class TradingFactoryModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/core/messages/message.module", () => ({
    MessageModule: class MessageModuleStub {
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

jest.mock("../../operations", () => ({
    OperationsModule: class OperationsModuleStub {
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

import { BankModule } from "../index";

describe("BankModule", () => {
    it("registers module imports/providers/controllers/exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, BankModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, BankModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BankModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, BankModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(Array.isArray(exportsMeta)).toBe(true);
        expect(imports).toHaveLength(6);
        expect(providers).toHaveLength(2);
        expect(controllers).toHaveLength(4);
        expect(exportsMeta).toHaveLength(1);
    });
});