/**
 * Tier-based Daily Transaction Limits (USD) — per operation type.
 *
 * Single source of truth for tier-based transaction limits.
 * Consumed by:
 *   - TierService.getTierInfo()          (auth module)
 *   - TransactionService.validateLimits() (trade module)
 *
 * Values are in USD. Redis-based enforcement converts crypto amounts to USD
 * at the current rate before comparing against these thresholds.
 *
 * Each tier has separate daily limits for BUY, SELL, SWAP, and SEND.
 */

export type TierLevel = 0 | 1 | 2 | 3 | 4;

export type OperationType = "BUY" | "SELL" | "SWAP" | "SEND";

export interface OperationLimits {
    buy: number | "unlimited";
    sell: number | "unlimited";
    swap: number | "unlimited";
    send: number | "unlimited";
}

/**
 * Tier Names:
 *   0 = Basic (deposit only — cannot transact)
 *   1 = Standard (BVN or NIN verified)
 *   2 = Intermediate (+ Government ID document)
 *   3 = Pro (+ Address verification)
 *   4 = Premium (+ Income verification)
 */
export const TIER_DAILY_LIMITS: Record<TierLevel, OperationLimits> = {
    0: { buy: 0, sell: 0, swap: 0, send: 0 },
    1: { buy: 50, sell: 50, swap: 50, send: 50 },
    2: { buy: 500, sell: 1_500, swap: 1_500, send: 1_500 },
    3: { buy: 3_000, sell: 10_000, swap: 10_000, send: 10_000 },
    4: { buy: 10_000, sell: 50_000, swap: 50_000, send: 50_000 },
};

/**
 * Business-specific daily limits in USD.
 * Business tier 0 = unverified, tier 1 = verified (unlimited).
 */
export const BUSINESS_DAILY_LIMITS: Record<0 | 1, OperationLimits> = {
    0: { buy: 0, sell: 0, swap: 0, send: 0 },
    1: { buy: "unlimited", sell: "unlimited", swap: "unlimited", send: "unlimited" },
};

/** Map OrderCategory enum value to OperationLimits key */
export function getOperationKey(category: string): keyof OperationLimits {
    switch (category) {
        case "BUY": return "buy";
        case "SELL": return "sell";
        case "SWAP": return "swap";
        case "SEND": return "send";
        default: return "buy"; // safe fallback to most restrictive
    }
}

// ─── Legacy re-exports for backward compatibility ───
// TIER_WITHDRAWAL_LIMITS is kept as the "send" limit per tier for code that
// still references it (e.g. TierService.getWithdrawalLimit).
export const TIER_WITHDRAWAL_LIMITS: Record<TierLevel, number | "unlimited"> = {
    0: 0,
    1: 50,
    2: 1_500,
    3: 10_000,
    4: 50_000,
};

export const BUSINESS_WITHDRAWAL_LIMITS: Record<0 | 1, number | "unlimited"> = {
    0: 0,
    1: "unlimited",
};
