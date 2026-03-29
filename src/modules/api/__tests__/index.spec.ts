import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../auth", () => ({ AuthModule: class AuthModule {} }));
jest.mock("../authorize", () => ({ AuthorizeModule: class AuthorizeModule {} }));
jest.mock("../user", () => ({ UserModule: class UserModule {} }));
jest.mock("../webExtension", () => ({ WebExtension: class WebExtension {} }));
jest.mock("../banks", () => ({ BankModule: class BankModule {} }));
jest.mock("../trade", () => ({ TradingModule: class TradingModule {} }));
jest.mock("../transactions", () => ({ TransactionModule: class TransactionModule {} }));
jest.mock("../settings", () => ({ SettingModule: class SettingModule {} }));
jest.mock("../notification/notification.module", () => ({ NotificationModule: class NotificationModule {} }));
jest.mock("../session", () => ({ SessionModule: class SessionModule {} }));
jest.mock("../rbac", () => ({ RbacModule: class RbacModule {} }));
jest.mock("../analytics", () => ({ AnalyticsModule: class AnalyticsModule {} }));
jest.mock("../kyc", () => ({ KycModule: class KycModule {} }));
jest.mock("../health", () => ({ HealthModule: class HealthModule {} }));
jest.mock("../operations", () => ({ OperationsModule: class OperationsModule {} }));
jest.mock("../reports", () => ({ ReportsModule: class ReportsModule {} }));
jest.mock("../system-config", () => ({ SystemConfigModule: class SystemConfigModule {} }));

import { APIModule } from "../index";

describe("APIModule", () => {
    it("registers all feature modules in imports metadata", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, APIModule) as Array<{ name?: string }>;

        expect(Array.isArray(imports)).toBe(true);
        expect(imports).toHaveLength(17);
        expect(imports.map((m) => m?.name)).toEqual(
            expect.arrayContaining([
                "WebExtension",
                "UserModule",
                "AuthModule",
                "AuthorizeModule",
                "BankModule",
                "TradingModule",
                "TransactionModule",
                "SettingModule",
                "NotificationModule",
                "SessionModule",
                "RbacModule",
                "AnalyticsModule",
                "KycModule",
                "HealthModule",
                "OperationsModule",
                "ReportsModule",
                "SystemConfigModule",
            ])
        );
    });
});
