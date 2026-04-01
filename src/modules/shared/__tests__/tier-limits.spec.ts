import {
    TIER_WITHDRAWAL_LIMITS,
    TIER_MONTHLY_LIMITS,
    BUSINESS_WITHDRAWAL_LIMITS,
    BUSINESS_MONTHLY_LIMITS,
    TierLevel,
} from "../tier-limits";

describe("TIER_WITHDRAWAL_LIMITS", () => {
    it("tier 0 has zero daily limit", () => {
        expect(TIER_WITHDRAWAL_LIMITS[0]).toBe(0);
    });

    it("has increasing daily limits for tiers 1-3", () => {
        const tier1 = TIER_WITHDRAWAL_LIMITS[1] as number;
        const tier2 = TIER_WITHDRAWAL_LIMITS[2] as number;
        const tier3 = TIER_WITHDRAWAL_LIMITS[3] as number;

        expect(tier1).toBeLessThan(tier2);
        expect(tier2).toBeLessThan(tier3);
    });

    it("tier 4 has unlimited daily withdrawals", () => {
        expect(TIER_WITHDRAWAL_LIMITS[4]).toBe("unlimited");
    });

    it("covers all 5 tier levels", () => {
        const levels: TierLevel[] = [0, 1, 2, 3, 4];
        for (const level of levels) {
            expect(TIER_WITHDRAWAL_LIMITS[level]).toBeDefined();
        }
    });
});

describe("TIER_MONTHLY_LIMITS", () => {
    it("tier 0 has zero monthly limit", () => {
        expect(TIER_MONTHLY_LIMITS[0]).toBe(0);
    });

    it("monthly limits are higher than daily for tiers 1-3", () => {
        for (const tier of [1, 2, 3] as TierLevel[]) {
            const daily = TIER_WITHDRAWAL_LIMITS[tier] as number;
            const monthly = TIER_MONTHLY_LIMITS[tier] as number;
            expect(monthly).toBeGreaterThan(daily);
        }
    });

    it("tier 4 has unlimited monthly withdrawals", () => {
        expect(TIER_MONTHLY_LIMITS[4]).toBe("unlimited");
    });
});

describe("BUSINESS_WITHDRAWAL_LIMITS", () => {
    it("tier 0 has zero daily limit", () => {
        expect(BUSINESS_WITHDRAWAL_LIMITS[0]).toBe(0);
    });

    it("tier 1 has unlimited daily withdrawals", () => {
        expect(BUSINESS_WITHDRAWAL_LIMITS[1]).toBe("unlimited");
    });
});

describe("BUSINESS_MONTHLY_LIMITS", () => {
    it("tier 0 has zero monthly limit", () => {
        expect(BUSINESS_MONTHLY_LIMITS[0]).toBe(0);
    });

    it("tier 1 has unlimited monthly limit", () => {
        expect(BUSINESS_MONTHLY_LIMITS[1]).toBe("unlimited");
    });
});
