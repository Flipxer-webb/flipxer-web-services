import {
    TIER_DAILY_LIMITS,
    BUSINESS_DAILY_LIMITS,
    TIER_WITHDRAWAL_LIMITS,
    BUSINESS_WITHDRAWAL_LIMITS,
    TierLevel,
    getOperationKey,
} from "../tier-limits";

describe("TIER_DAILY_LIMITS", () => {
    it("tier 0 has zero limits for all operations", () => {
        expect(TIER_DAILY_LIMITS[0].buy).toBe(0);
        expect(TIER_DAILY_LIMITS[0].sell).toBe(0);
        expect(TIER_DAILY_LIMITS[0].swap).toBe(0);
        expect(TIER_DAILY_LIMITS[0].send).toBe(0);
    });

    it("tier 1 has $50 daily limit for all operations", () => {
        expect(TIER_DAILY_LIMITS[1].buy).toBe(50);
        expect(TIER_DAILY_LIMITS[1].sell).toBe(50);
        expect(TIER_DAILY_LIMITS[1].swap).toBe(50);
        expect(TIER_DAILY_LIMITS[1].send).toBe(50);
    });

    it("tier 2 has correct per-operation limits", () => {
        expect(TIER_DAILY_LIMITS[2].buy).toBe(500);
        expect(TIER_DAILY_LIMITS[2].sell).toBe(1_500);
        expect(TIER_DAILY_LIMITS[2].swap).toBe(1_500);
        expect(TIER_DAILY_LIMITS[2].send).toBe(1_500);
    });

    it("buy limits increase monotonically across tiers 1-4", () => {
        const tiers: TierLevel[] = [1, 2, 3, 4];
        for (let i = 0; i < tiers.length - 1; i++) {
            const curr = TIER_DAILY_LIMITS[tiers[i]].buy as number;
            const next = TIER_DAILY_LIMITS[tiers[i + 1]].buy as number;
            expect(next).toBeGreaterThan(curr);
        }
    });

    it("covers all 5 tier levels", () => {
        const levels: TierLevel[] = [0, 1, 2, 3, 4];
        for (const level of levels) {
            expect(TIER_DAILY_LIMITS[level]).toBeDefined();
            expect(TIER_DAILY_LIMITS[level].buy).toBeDefined();
            expect(TIER_DAILY_LIMITS[level].sell).toBeDefined();
            expect(TIER_DAILY_LIMITS[level].swap).toBeDefined();
            expect(TIER_DAILY_LIMITS[level].send).toBeDefined();
        }
    });
});

describe("BUSINESS_DAILY_LIMITS", () => {
    it("tier 0 has zero limits for all operations", () => {
        expect(BUSINESS_DAILY_LIMITS[0].buy).toBe(0);
        expect(BUSINESS_DAILY_LIMITS[0].sell).toBe(0);
        expect(BUSINESS_DAILY_LIMITS[0].swap).toBe(0);
        expect(BUSINESS_DAILY_LIMITS[0].send).toBe(0);
    });

    it("tier 1 is unlimited for all operations", () => {
        expect(BUSINESS_DAILY_LIMITS[1].buy).toBe("unlimited");
        expect(BUSINESS_DAILY_LIMITS[1].sell).toBe("unlimited");
        expect(BUSINESS_DAILY_LIMITS[1].swap).toBe("unlimited");
        expect(BUSINESS_DAILY_LIMITS[1].send).toBe("unlimited");
    });
});

describe("getOperationKey", () => {
    it("maps BUY to buy", () => expect(getOperationKey("BUY")).toBe("buy"));
    it("maps SELL to sell", () => expect(getOperationKey("SELL")).toBe("sell"));
    it("maps SWAP to swap", () => expect(getOperationKey("SWAP")).toBe("swap"));
    it("maps SEND to send", () => expect(getOperationKey("SEND")).toBe("send"));
    it("defaults unknown categories to buy", () => expect(getOperationKey("RECEIVE")).toBe("buy"));
});

describe("Legacy re-exports", () => {
    it("TIER_WITHDRAWAL_LIMITS maps to send limits", () => {
        expect(TIER_WITHDRAWAL_LIMITS[0]).toBe(0);
        expect(TIER_WITHDRAWAL_LIMITS[1]).toBe(50);
        expect(TIER_WITHDRAWAL_LIMITS[2]).toBe(1_500);
        expect(TIER_WITHDRAWAL_LIMITS[3]).toBe(10_000);
        expect(TIER_WITHDRAWAL_LIMITS[4]).toBe(50_000);
    });

    it("BUSINESS_WITHDRAWAL_LIMITS maps to business send limits", () => {
        expect(BUSINESS_WITHDRAWAL_LIMITS[0]).toBe(0);
        expect(BUSINESS_WITHDRAWAL_LIMITS[1]).toBe("unlimited");
    });
});
