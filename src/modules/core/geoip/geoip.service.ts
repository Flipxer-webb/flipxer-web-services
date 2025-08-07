import { Injectable } from "@nestjs/common";
import * as geoip from "geoip-lite";

@Injectable()
export class GeoIPService {
    getCountryCode(ip: string): string | null {
        const geo = geoip.lookup(ip);
        return geo?.country ?? null;
    }
}
