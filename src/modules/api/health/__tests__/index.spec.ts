import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../controllers/v1", () => ({
    HealthController: class HealthControllerStub {
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

jest.mock("@/modules/core/redisCache", () => ({
    CachingModule: class CachingModuleStub {
        readonly __stub = true;
    },
    __esModule: true,
}));

import { HealthModule } from "../index";
import { HealthController } from "../controllers/v1";
import { PrismaModule } from "@/modules/core/prisma";
import { CachingModule } from "@/modules/core/redisCache";

describe("HealthModule", () => {
    it("registers imports and controllers", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, HealthModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, HealthModule) as unknown[];

        expect(imports).toEqual([PrismaModule, CachingModule]);
        expect(controllers).toEqual([HealthController]);
    });
});
