import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../controllers", () => ({
    AnalyticsController: class AnalyticsControllerStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("../services", () => ({
    AnalyticsService: class AnalyticsServiceStub {
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

import { AnalyticsModule } from "../analytics.module";
import { AnalyticsController } from "../controllers";
import { AnalyticsService } from "../services";
import { SessionModule } from "../../session";

describe("AnalyticsModule", () => {
    it("registers imports/controllers/providers/exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AnalyticsModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AnalyticsModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AnalyticsModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, AnalyticsModule) as unknown[];

        expect(imports).toEqual([SessionModule]);
        expect(controllers).toEqual([AnalyticsController]);
        expect(providers).toEqual([AnalyticsService]);
        expect(exportsMeta).toEqual([AnalyticsService]);
    });
});
