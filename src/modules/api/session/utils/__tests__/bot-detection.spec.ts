import {
    getBotTrafficReason,
    isBotUserAgent,
    isCloudProviderIP,
    isLikelyBotTraffic,
    isSuspiciousCombination,
} from "../bot-detection";

describe("session bot detection utils", () => {
    it("isCloudProviderIP detects known aws-style prefixes", () => {
        expect(isCloudProviderIP("3.15.22.11")).toBe(true);
        expect(isCloudProviderIP("52.100.10.1")).toBe(true);
        expect(isCloudProviderIP("196.1.1.1")).toBe(false);
        expect(isCloudProviderIP(undefined)).toBe(false);
    });

    it("isBotUserAgent matches common automation signatures", () => {
        expect(isBotUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
        expect(isBotUserAgent("curl/8.0.1")).toBe(true);
        expect(isBotUserAgent("axios/1.6.8")).toBe(true);
        expect(isBotUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(false);
        expect(isBotUserAgent(null)).toBe(false);
    });

    it("isSuspiciousCombination flags invalid browser/os combos", () => {
        expect(isSuspiciousCombination("Safari", "Linux")).toBe(true);
        expect(isSuspiciousCombination(undefined, undefined)).toBe(true);
        expect(isSuspiciousCombination("Chrome", "Windows")).toBe(false);
    });

    it("isLikelyBotTraffic returns true for cloud+suspicious, user-agent bot, and false otherwise", () => {
        expect(
            isLikelyBotTraffic({
                browser: "Safari",
                os: "Linux",
                ipAddress: "3.9.10.11",
                userAgent: "Mozilla/5.0",
            })
        ).toBe(true);

        expect(
            isLikelyBotTraffic({
                browser: "Chrome",
                os: "Windows",
                ipAddress: "196.10.10.10",
                userAgent: "python-requests/2.31",
            })
        ).toBe(true);

        expect(
            isLikelyBotTraffic({
                browser: "Chrome",
                os: "Windows",
                ipAddress: "196.10.10.10",
                userAgent: "Mozilla/5.0",
            })
        ).toBe(false);
    });

    it("getBotTrafficReason aggregates all detected reasons", () => {
        const reason = getBotTrafficReason({
            browser: "Safari",
            os: "Linux",
            ipAddress: "3.18.20.22",
            userAgent: "curl/8.5",
        });

        expect(reason).toContain("Cloud/AWS IP");
        expect(reason).toContain("Bot user-agent detected");
        expect(reason).toContain("Suspicious combo");
    });

    it("getBotTrafficReason returns null when no indicators are present", () => {
        const reason = getBotTrafficReason({
            browser: "Chrome",
            os: "Windows",
            ipAddress: "196.10.10.10",
            userAgent: "Mozilla/5.0",
        });

        expect(reason).toBeNull();
    });
});
