import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services/reports.service", () => ({
    ReportsService: class ReportsServiceStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/reports.controller", () => ({
    AdminReportsController: class AdminReportsControllerStub {
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

import { ReportsModule } from "../index";
import { ReportsService } from "../services/reports.service";
import { AdminReportsController } from "../controllers/v1/admin/reports.controller";
import { SessionModule } from "../../session";

describe("ReportsModule", () => {
    it("registers imports/controllers/providers/exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ReportsModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReportsModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ReportsModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, ReportsModule) as unknown[];

        expect(imports).toEqual([SessionModule]);
        expect(controllers).toEqual([AdminReportsController]);
        expect(providers).toEqual([ReportsService]);
        expect(exportsMeta).toEqual([ReportsService]);
    });
});
