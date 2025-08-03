import { Global, Module } from "@nestjs/common";
import { GeoIPService } from "./geoip.service";

@Global()
@Module({
    imports: [],
    providers: [GeoIPService],
    exports: [GeoIPService],
})
export class GeoIpModule {}
