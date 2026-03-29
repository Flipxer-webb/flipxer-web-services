import * as geoip from "geoip-lite";

jest.mock("geoip-lite", () => ({
    lookup: jest.fn(),
}));

import { GeoIPService } from "../geoip.service";

describe("GeoIPService", () => {
    let service: GeoIPService;
    const lookupMock = geoip.lookup as unknown as jest.Mock;
    const testIpPrimary = "test-ip-primary";
    const testIpSecondary = "test-ip-secondary";
    const testIpLoopback = "test-ip-loopback";

    beforeEach(() => {
        service = new GeoIPService();
        jest.clearAllMocks();
    });

    it("returns the country code when lookup succeeds", () => {
        lookupMock.mockReturnValue({ country: "NG" });

        const result = service.getCountryCode(testIpPrimary);

        expect(result).toBe("NG");
        expect(lookupMock).toHaveBeenCalledWith(testIpPrimary);
    });

    it("returns null when lookup has no country", () => {
        lookupMock.mockReturnValue({});

        const result = service.getCountryCode(testIpSecondary);

        expect(result).toBeNull();
    });

    it("returns null when lookup returns null", () => {
        lookupMock.mockReturnValue(null);

        const result = service.getCountryCode(testIpLoopback);

        expect(result).toBeNull();
    });
});
