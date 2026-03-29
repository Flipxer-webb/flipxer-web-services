import { MODULE_METADATA } from "@nestjs/common/constants";
import { GeoIPService } from "../geoip.service";
import { GeoIpModule } from "../index";

describe("GeoIpModule", () => {
    it("registers providers and exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, GeoIpModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, GeoIpModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, GeoIpModule) as unknown[];

        expect(imports).toEqual([]);
        expect(providers).toEqual([GeoIPService]);
        expect(exportsMeta).toEqual([GeoIPService]);
    });
});
