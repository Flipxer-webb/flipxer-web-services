/**
 * Tier-Based Transaction Threshold Utility
 * 
 * Determines if 2FA is required based on user tier and transaction amount in NGN.
 * 
 * Tier Thresholds:
 * - Tier 0: Always require 2FA if enabled (no threshold)
 * - Tier 1: Require 2FA for transactions >= 50,000 NGN
 * - Tier 2: Require 2FA for transactions >= 100,000 NGN
 * - Tier 3: Require 2FA for transactions >= 500,000 NGN
 */

export interface TierThreshold {
  tier: number;
  thresholdNGN: number;
  description: string;
}

export const TIER_THRESHOLDS: TierThreshold[] = [
  {
    tier: 0,
    thresholdNGN: 0, // Always require 2FA if enabled
    description: 'Basic tier - all transactions require 2FA',
  },
  {
    tier: 1,
    thresholdNGN: 50000, // 50k NGN
    description: 'Tier 1 - transactions >= ₦50,000 require 2FA',
  },
  {
    tier: 2,
    thresholdNGN: 100000, // 100k NGN
    description: 'Tier 2 - transactions >= ₦100,000 require 2FA',
  },
  {
    tier: 3,
    thresholdNGN: 500000, // 500k NGN
    description: 'Tier 3 - transactions >= ₦500,000 require 2FA',
  },
];

/**
 * Check if 2FA is required for a transaction based on tier and amount
 * 
 * @param userTier - User's verification tier (0-3)
 * @param amountNGN - Transaction amount converted to NGN
 * @param isTwoFactorEnabled - Whether user has 2FA enabled
 * @returns true if 2FA is required, false otherwise
 */
export function isTwoFactorRequiredForTransaction(
  userTier: number,
  amountNGN: number,
  isTwoFactorEnabled: boolean,
): boolean {
  // If 2FA is not enabled at all, it's never required
  if (!isTwoFactorEnabled) {
    return false;
  }

  // Find threshold for user's tier (default to tier 0 if invalid)
  const tierConfig = TIER_THRESHOLDS.find(t => t.tier === userTier) 
    || TIER_THRESHOLDS[0];

  // Check if transaction amount meets or exceeds threshold
  return amountNGN >= tierConfig.thresholdNGN;
}

/**
 * Get threshold information for a specific tier
 * 
 * @param userTier - User's verification tier
 * @returns Threshold configuration
 */
export function getTierThreshold(userTier: number): TierThreshold {
  return TIER_THRESHOLDS.find(t => t.tier === userTier) || TIER_THRESHOLDS[0];
}

/**
 * Calculate NGN equivalent for a crypto transaction
 * 
 * @param amount - Crypto amount
 * @param rateToNGN - Rate of crypto asset to NGN
 * @returns Amount in NGN
 */
export function convertToNGN(amount: number, rateToNGN: number): number {
  return amount * rateToNGN;
}
