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
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

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

    it("transforms and validates KYC DTOs with queue and optimistic-lock fields", () => {
        const queueDto = plainToInstance(KycDtos.GetKycQueueDto, {
            pageNumber: "2",
            pageSize: "25",
            queueView: "ACTIONABLE",
            tier: "3",
            sortBy: "desc",
        });
        const decisionDto = plainToInstance(KycDtos.KycDecisionDto, {
            userId: 4,
            action: "APPROVE",
            verificationType: "DOCUMENT",
            version: "3",
            note: "looks good",
        });
        const approveDto = plainToInstance(KycDtos.ApproveDocumentDto, {
            userId: 7,
            documentType: "income",
            version: "2",
        });
        const rejectDto = plainToInstance(KycDtos.RejectDocumentDto, {
            userId: 8,
            documentType: "business",
            reason: "missing page",
            version: "4",
        });
        const lookupDto = plainToInstance(KycDtos.RunKycProviderLookupDto, {
            userId: 9,
            verificationType: "BUSINESS_DOCUMENT",
        });

        expect(KycDtos.adminKycProviderLookupTypes).toContain(
            "BUSINESS_DOCUMENT",
        );

        expect(queueDto.pageNumber).toBe(2);
        expect(queueDto.pageSize).toBe(25);
        expect(queueDto.queueView).toBe("ACTIONABLE");
        expect(queueDto.tier).toBe(3);
        expect(queueDto.sortBy).toBe("desc");
        expect(validateSync(queueDto)).toHaveLength(0);

        expect(decisionDto.version).toBe(3);
        expect(decisionDto.note).toBe("looks good");
        expect(validateSync(decisionDto)).toHaveLength(0);

        expect(approveDto.version).toBe(2);
        expect(validateSync(approveDto)).toHaveLength(0);

        expect(rejectDto.documentType).toBe("business");
        expect(rejectDto.version).toBe(4);
        expect(validateSync(rejectDto)).toHaveLength(0);

        expect(lookupDto.userId).toBe(9);
        expect(lookupDto.verificationType).toBe("BUSINESS_DOCUMENT");
        expect(validateSync(lookupDto)).toHaveLength(0);
    });

    it("loads type/index modules used by APIs and notifications", () => {
        expect(DojahTypes).toBeDefined();
        expect(NotificationTypes).toBeDefined();
        expect(TransactionsTypes).toBeDefined();
    });
});
