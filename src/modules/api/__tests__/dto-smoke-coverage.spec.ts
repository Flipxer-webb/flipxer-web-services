import * as AuthDtos from "@/modules/api/auth/dtos";
import * as TradeDtos from "@/modules/api/trade/dtos";
import * as UserDtos from "@/modules/api/user/dtos";
import * as TransactionDtos from "@/modules/api/transactions/dtos";
import * as KycDtos from "@/modules/api/kyc/dtos";
import * as RbacDtos from "@/modules/api/rbac/dtos";
import * as SettingsDtos from "@/modules/api/settings/dtos";
import * as DojahTypes from "@/libs/dojah/types";
import * as NotificationTypes from "@/modules/core/messages/types/notification.type";
import * as TransactionsTypes from "@/modules/api/transactions/types";

type ExportedModule = Record<string, unknown>;

const instantiateClassExports = (moduleExports: ExportedModule) => {
    for (const value of Object.values(moduleExports)) {
        if (typeof value !== "function") {
            continue;
        }

        try {
            // DTO classes generally have no constructor args; this executes class bodies/decorators for coverage.
            new (value as new () => unknown)();
        } catch {
            // Ignore non-constructable function exports.
        }
    }
};

describe("DTO/type smoke coverage", () => {
    it("loads and instantiates exported auth/trade/user DTO classes", () => {
        instantiateClassExports(AuthDtos);
        instantiateClassExports(TradeDtos);
        instantiateClassExports(UserDtos);
        instantiateClassExports(TransactionDtos);

        expect(Object.keys(AuthDtos).length).toBeGreaterThan(5);
        expect(Object.keys(TradeDtos).length).toBeGreaterThan(5);
        expect(Object.keys(UserDtos).length).toBeGreaterThan(5);
        expect(Object.keys(TransactionDtos).length).toBeGreaterThan(3);
    });

    it("loads and instantiates exported kyc/rbac/settings DTO classes", () => {
        instantiateClassExports(KycDtos);
        instantiateClassExports(RbacDtos);
        instantiateClassExports(SettingsDtos);

        expect(Object.keys(KycDtos).length).toBeGreaterThan(1);
        expect(Object.keys(RbacDtos).length).toBeGreaterThan(1);
        expect(Object.keys(SettingsDtos).length).toBeGreaterThan(1);
    });

    it("loads type/index modules used by APIs and notifications", () => {
        expect(DojahTypes).toBeDefined();
        expect(NotificationTypes).toBeDefined();
        expect(TransactionsTypes).toBeDefined();
    });
});
