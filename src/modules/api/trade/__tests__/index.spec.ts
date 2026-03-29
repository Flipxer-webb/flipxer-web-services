import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class UserModule {
        readonly __stub = true;
    },
    AccountDeletedException: class AccountDeletedException extends Error {
        readonly __stub = true;
    },
    UserNotFoundException: class UserNotFoundException extends Error {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/auth", () => ({
    AuthModule: class AuthModule {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    TransactionAmountGuard: class TransactionAmountGuard {
        readonly __stub = true;
    },
    SocketAuthGuard: class SocketAuthGuard {
        readonly __stub = true;
    },
    AuthGuard: class AuthGuard {
        readonly __stub = true;
    },
    CountryBlockGuard: class CountryBlockGuard {
        readonly __stub = true;
    },
    QuidaxWebhookGuard: class QuidaxWebhookGuard {
        readonly __stub = true;
    },
    EnabledAccountGuard: class EnabledAccountGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1", () => ({
    TradingController: class TradingControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/price-alert.controller", () => ({
    PriceAlertController: class PriceAlertControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin-ledger.controller", () => ({
    AdminLedgerController: class AdminLedgerControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin-accounting.controller", () => ({
    AdminAccountingController: class AdminAccountingControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../gateway/v1", () => ({
    WsGateway: class WsGatewayStub {
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

jest.mock("@/modules/factory/bank/bank.module", () => ({
    BankFactoryModule: class BankFactoryModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/core/prisma", () => ({
    PrismaModule: class PrismaModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/core/email", () => ({
    EmailModule: class EmailModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/core/redisCache", () => ({
    CachingModule: class CachingModuleStub {
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

jest.mock("../../notification/notification.module", () => ({
    NotificationModule: class NotificationModuleStub {
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

import * as tradeIndex from "../index";
import * as tradeErrors from "../errors";

describe("Trade module index", () => {
    it("exposes module metadata and re-exports errors", () => {
        expect(tradeIndex.TradingModule).toBeDefined();
        expect(tradeIndex.GeneralTransactionException).toBe(tradeErrors.GeneralTransactionException);

        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, tradeIndex.TradingModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, tradeIndex.TradingModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, tradeIndex.TradingModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(providers)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(imports.length).toBeGreaterThan(0);
        expect(providers.length).toBeGreaterThan(0);
        expect(controllers.length).toBeGreaterThan(0);
    });

    it("registers forwardRef imports for user/auth modules", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, tradeIndex.TradingModule) as Array<any>;
        const forwardRefs = imports.filter((entry) => typeof entry?.forwardRef === "function");

        expect(forwardRefs).toHaveLength(2);
        expect(
            forwardRefs
                .map((entry) => entry.forwardRef().name)
                .sort((a, b) => a.localeCompare(b))
        ).toEqual(["AuthModule", "UserModule"]);
    });
});
