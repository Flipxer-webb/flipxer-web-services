import { MODULE_METADATA } from "@nestjs/common/constants";

const buildMock = jest.fn().mockReturnValue({ name: "dojah-service" });
const identityComplianceFactoryCtor = jest.fn().mockImplementation(() => ({
    build: buildMock,
}));

jest.mock("../factory", () => ({
    IdentityComplianceFactory: identityComplianceFactoryCtor,
    __esModule: true,
}));

jest.mock("@/config", () => ({
    identityComplianceConfig: {
        dojah: {
            secret_key: "secret",
            app_id: "app-id",
            baseUrl: "https://dojah.example",
        },
    },
    __esModule: true,
}));

import { IdentityComplianceFactoryModule } from "../index";
import { IdentityComplianceInjectionToken } from "../types";

describe("IdentityComplianceFactoryModule", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("registers/exports dojah provider and resolves it via factory", () => {
        const providers = Reflect.getMetadata(
            MODULE_METADATA.PROVIDERS,
            IdentityComplianceFactoryModule
        ) as Array<{ provide: unknown; useFactory: () => unknown }>;
        const exportsMeta = Reflect.getMetadata(
            MODULE_METADATA.EXPORTS,
            IdentityComplianceFactoryModule
        ) as unknown[];

        expect(providers).toHaveLength(1);
        expect(exportsMeta).toEqual([providers[0]]);
        expect(providers[0].provide).toBe(IdentityComplianceInjectionToken.DOJAH);

        const service = providers[0].useFactory();

        expect(identityComplianceFactoryCtor).toHaveBeenCalledTimes(1);
        expect(buildMock).toHaveBeenCalledWith({ provider: "dojah" });
        expect(service).toEqual({ name: "dojah-service" });
    });
});
