/**
 * Tier Withdrawal Limits (USD daily)
 *
 * Single source of truth for tier-based transaction limits.
 * Consumed by:
 *   - TierService.getTierInfo()          (auth module)
 *   - TransactionService.validateLimits() (trade module)
 *
 * Values are in USD. Redis-based enforcement converts NGN amounts to USD
 * at the current rate before comparing against these thresholds.
 */

export type TierLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Tier Names:
 *   0 = Basic (deposit only — cannot transact)
 *   1 = Standard (BVN or NIN verified)
 *   2 = Intermediate (+ Government ID document)
 *   3 = Pro (+ Address verification)
 *   4 = Premium (+ Income verification — unlimited)
 */
export const TIER_WITHDRAWAL_LIMITS: Record<TierLevel, number | "unlimited"> = {
    0: 0,
    1: 10_000,      // $10,000/day
    2: 50_000,      // $50,000/day
    3: 100_000,     // $100,000/day
    4: "unlimited",
};

/**
 * Monthly withdrawal limits in USD per tier.
 * Approximately 30× daily for tiers 1-3.
 */
export const TIER_MONTHLY_LIMITS: Record<TierLevel, number | "unlimited"> = {
    0: 0,
    1: 300_000,
    2: 1_500_000,
    3: 3_000_000,
    4: "unlimited",
};
