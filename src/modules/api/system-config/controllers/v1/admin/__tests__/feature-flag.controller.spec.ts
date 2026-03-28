import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {},
    CountryBlockGuard: class {},
    EnabledAccountGuard: class {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class {},
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class {},
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { AdminFeatureFlagController } from "../feature-flag.controller";
import { FeatureFlagService } from "../../../../services/feature-flag.service";

describe("AdminFeatureFlagController", () => {
    let controller: AdminFeatureFlagController;
    let flagService: {
        getAllFlags: jest.Mock;
        getFlagByKey: jest.Mock;
        createFlag: jest.Mock;
        updateFlag: jest.Mock;
        deleteFlag: jest.Mock;
        getAuditLog: jest.Mock;
        evaluateFlag: jest.Mock;
        evaluateFlags: jest.Mock;
    };

    const admin = { id: 1, email: "admin@flipxer.com" } as any;

    beforeEach(async () => {
        flagService = {
            getAllFlags: jest.fn(),
            getFlagByKey: jest.fn(),
            createFlag: jest.fn(),
            updateFlag: jest.fn(),
            deleteFlag: jest.fn(),
            getAuditLog: jest.fn(),
            evaluateFlag: jest.fn(),
            evaluateFlags: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [AdminFeatureFlagController],
            providers: [
                { provide: FeatureFlagService, useValue: flagService },
            ],
        }).compile();

        controller = module.get(AdminFeatureFlagController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should return all flags", async () => {
        flagService.getAllFlags.mockResolvedValue([{ key: "flag-a", isEnabled: true }]);

        const result = await controller.getAllFlags();

        expect(flagService.getAllFlags).toHaveBeenCalled();
        expect(result.data).toHaveLength(1);
    });

    it("should return a flag by key", async () => {
        flagService.getFlagByKey.mockResolvedValue({ key: "beta-ui" });

        const result = await controller.getFlagByKey("beta-ui");

        expect(flagService.getFlagByKey).toHaveBeenCalledWith("beta-ui");
        expect(result.data.key).toBe("beta-ui");
    });

    it("should create a flag", async () => {
        const dto = { key: "new-flag", isEnabled: true } as any;
        flagService.createFlag.mockResolvedValue({ id: 5, key: "new-flag" });

        const result = await controller.createFlag(dto, admin);

        expect(flagService.createFlag).toHaveBeenCalledWith(dto, 1);
        expect(result.data.id).toBe(5);
    });

    it("should update a flag", async () => {
        const dto = { isEnabled: false } as any;
        flagService.updateFlag.mockResolvedValue({ id: 2, isEnabled: false });

        const result = await controller.updateFlag(2, dto, admin);

        expect(flagService.updateFlag).toHaveBeenCalledWith(2, dto, 1);
        expect(result.data.isEnabled).toBe(false);
    });

    it("should delete a flag", async () => {
        flagService.deleteFlag.mockResolvedValue(undefined);

        const result = await controller.deleteFlag(2, admin);

        expect(flagService.deleteFlag).toHaveBeenCalledWith(2, 1);
        expect(result.message).toContain("deleted");
    });

    it("should enable a flag", async () => {
        flagService.updateFlag.mockResolvedValue({ id: 3, isEnabled: true });

        const result = await controller.enableFlag(3, admin);

        expect(flagService.updateFlag).toHaveBeenCalledWith(3, { isEnabled: true }, 1);
        expect(result.data.isEnabled).toBe(true);
    });

    it("should disable a flag", async () => {
        flagService.updateFlag.mockResolvedValue({ id: 3, isEnabled: false });

        const result = await controller.disableFlag(3, admin);

        expect(flagService.updateFlag).toHaveBeenCalledWith(3, { isEnabled: false }, 1);
        expect(result.data.isEnabled).toBe(false);
    });

    it("should return audit log with default limit", async () => {
        flagService.getAuditLog.mockResolvedValue([{ id: 1 }]);

        const result = await controller.getFlagAuditLog(9);

        expect(flagService.getAuditLog).toHaveBeenCalledWith(9, 50);
        expect(result.data).toHaveLength(1);
    });

    it("should evaluate a single flag", async () => {
        const context = { userId: 1, country: "NG" } as any;
        flagService.evaluateFlag.mockResolvedValue(true);

        const result = await controller.evaluateFlag("beta-ui", context);

        expect(flagService.evaluateFlag).toHaveBeenCalledWith("beta-ui", context);
        expect(result.data).toEqual({ key: "beta-ui", enabled: true, context });
    });

    it("should evaluate multiple flags", async () => {
        const context = { userId: 1 } as any;
        const body = { keys: ["flag-a", "flag-b"], context };
        flagService.evaluateFlags.mockResolvedValue({ "flag-a": true, "flag-b": false });

        const result = await controller.evaluateFlagsBatch(body);

        expect(flagService.evaluateFlags).toHaveBeenCalledWith(body.keys, context);
        expect(result.data.flags["flag-a"]).toBe(true);
    });

    it("should compute statistics from all flags", async () => {
        flagService.getAllFlags.mockResolvedValue([
            { key: "a", isEnabled: true },
            { key: "b", isEnabled: false },
            { key: "c", isEnabled: true },
        ]);

        const result = await controller.getFlagStatistics();

        expect(result.data).toEqual({ total: 3, enabled: 2, disabled: 1 });
    });
});