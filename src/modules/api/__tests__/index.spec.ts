import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants";

const AuthModule = function AuthModule() { return undefined; };
const AuthorizeModule = function AuthorizeModule() { return undefined; };
const UserModule = function UserModule() { return undefined; };
const WebExtension = function WebExtension() { return undefined; };
const BankModule = function BankModule() { return undefined; };
const TradingModule = function TradingModule() { return undefined; };
const TransactionModule = function TransactionModule() { return undefined; };
const SettingModule = function SettingModule() { return undefined; };
const NotificationModule = function NotificationModule() { return undefined; };
const SessionModule = function SessionModule() { return undefined; };
const RbacModule = function RbacModule() { return undefined; };
const AnalyticsModule = function AnalyticsModule() { return undefined; };
const KycModule = function KycModule() { return undefined; };
const HealthModule = function HealthModule() { return undefined; };
const OperationsModule = function OperationsModule() { return undefined; };
const ReportsModule = function ReportsModule() { return undefined; };
const SystemConfigModule = function SystemConfigModule() { return undefined; };

jest.mock("../auth", () => ({ AuthModule }));
jest.mock("../authorize", () => ({ AuthorizeModule }));
jest.mock("../user", () => ({ UserModule }));
jest.mock("../webExtension", () => ({ WebExtension }));
jest.mock("../banks", () => ({ BankModule }));
jest.mock("../trade", () => ({ TradingModule }));
jest.mock("../transactions", () => ({ TransactionModule }));
jest.mock("../settings", () => ({ SettingModule }));
jest.mock("../notification/notification.module", () => ({ NotificationModule }));
jest.mock("../session", () => ({ SessionModule }));
jest.mock("../rbac", () => ({ RbacModule }));
jest.mock("../analytics", () => ({ AnalyticsModule }));
jest.mock("../kyc", () => ({ KycModule }));
jest.mock("../health", () => ({ HealthModule }));
jest.mock("../operations", () => ({ OperationsModule }));
jest.mock("../reports", () => ({ ReportsModule }));
jest.mock("../system-config", () => ({ SystemConfigModule }));

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
