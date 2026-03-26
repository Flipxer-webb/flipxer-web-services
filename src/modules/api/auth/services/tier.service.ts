import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { RedisCacheService } from "@/modules/core/redisCache/services/redis-cache.service";
import { User, UserType } from "@prisma/client";
import { TIER_WITHDRAWAL_LIMITS, TierLevel } from "@/modules/shared/tier-limits";

export { TierLevel };

export interface TierInfo {
    tier: TierLevel;
    withdrawalLimit: number | "unlimited";
    canTransact: boolean;
}

// User with tier fields
export type UserWithTier = User & {
    tier?: number;
    isAddressVerified?: boolean;
    isIncomeVerified?: boolean;
    isNinVerified?: boolean;
};

// Re-export for backward compatibility (use TIER_WITHDRAWAL_LIMITS from shared module for new code)
const WITHDRAWAL_LIMITS = TIER_WITHDRAWAL_LIMITS;

/**
 * Tier requirement checker functions for individual users
 * Checked in descending order (4 -> 3 -> 2 -> 1)
 * Each tier builds on the previous tier's requirements
 */
const INDIVIDUAL_TIER_CHECKS: Array<{
    tier: TierLevel;
    check: (user: Partial<UserWithTier>) => boolean;
}> = [
        {
            // Tier 4 (Premium): All verifications complete including income
            tier: 4,
            check: (user) =>
                (!!user.isBvnVerified || !!user.isNinVerified) &&
                !!user.isDocumentVerified &&
                !!user.isAddressVerified &&
                !!user.isIncomeVerified,
        },
        {
            // Tier 3 (Pro): BVN/NIN + Document + Address verified
            tier: 3,
            check: (user) =>
                (!!user.isBvnVerified || !!user.isNinVerified) &&
                !!user.isDocumentVerified &&
                !!user.isAddressVerified,
        },
        {
            // Tier 2 (Intermediate): BVN/NIN + Document verified
            tier: 2,
            check: (user) =>
                (!!user.isBvnVerified || !!user.isNinVerified) &&
                !!user.isDocumentVerified,
        },
        {
            // Tier 1 (Standard): BVN or NIN verified
            tier: 1,
            check: (user) => !!user.isBvnVerified || !!user.isNinVerified,
        },
    ];

@Injectable()
export class TierService {
    private readonly logger = new Logger(TierService.name);
    private readonly PROFILE_CACHE_KEY = (userId: number) => `user:profile:${userId}`;

    constructor(
        private readonly prisma: PrismaService,
        private readonly redisCacheService: RedisCacheService
    ) { }

    /**
     * Calculate the tier for a user based on their verification status
     * @param user - The user object with verification flags
     * @returns The calculated tier level (0-4 for individuals, 0-1 for business)
     */
    calculateTier(user: Partial<UserWithTier>): TierLevel {
        // Business accounts have simpler 2-tier structure
        if (user.userType === UserType.BUSINESS) {
            return this.calculateBusinessTier(user);
        }

        return this.calculateIndividualTier(user);
    }

    /**
     * Business tier calculation:
     * - Tier 0: Basic (can only deposit)
     * - Tier 1: Verified (business documents uploaded, unlimited access)
     * Note: Returns 1 but business accounts get unlimited regardless
     */
    private calculateBusinessTier(user: Partial<UserWithTier>): TierLevel {
        // Business accounts only get Tier 1 (Unlimited) if documents are fully VERIFIED
        if (user.businessDocumentVerificationStatus === "VERIFIED") {
            return 1;
        }
        return 0;
    }

    private calculateIndividualTier(user: Partial<UserWithTier>): TierLevel {
        // Safety check for basic verification - only email is required
        // Phone verification is optional and not part of the KYC flow
        if (!user.isEmailVerified) {
            return 0;
        }

        // Find the highest tier the user qualifies for
        for (const tierCheck of INDIVIDUAL_TIER_CHECKS) {
            if (tierCheck.check(user)) {
                return tierCheck.tier;
            }
        }

        return 0;
    }

    /**
     * Get withdrawal limit for a specific tier
     * @param tier - The tier level
     * @returns The withdrawal limit in USD or "unlimited"
     */
    getWithdrawalLimit(tier: TierLevel): number | "unlimited" {
        return WITHDRAWAL_LIMITS[tier];
    }

    /**
     * Get complete tier info for a user
     * @param user - The user object
     * @returns TierInfo with tier, withdrawal limit, and transaction capability
     */
    /**
     * Retrieves tier information for a user.
     * Uses WITHDRAWAL_LIMITS (USD daily) as the single source of truth.
     * The AccountLimit.sellTokenFiat column stores per-operation NGN caps
     * and MUST NOT be used here — it is a different unit and purpose.
     */
    async getTierInfo(user: Partial<UserWithTier>): Promise<TierInfo> {
        const tier = this.calculateTier(user);
        const withdrawalLimit: number | "unlimited" = WITHDRAWAL_LIMITS[tier];

        return {
            tier,
            withdrawalLimit,
            canTransact: tier > 0,
        };
    }

    /**
     * Update user's tier in the database based on their current verification status
     * @param userId - The user ID to update
     * @returns The updated user with new tier
     */
    async updateUserTier(userId: number): Promise<UserWithTier> {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
        }) as UserWithTier | null;

        if (!user) {
            throw new Error(`User with ID ${userId} not found`);
        }

        // Debug logging to track tier calculation
        this.logger.log(`[Tier Calc] User ${userId} verification status: ` +
            `email=${user.isEmailVerified}, bvn=${user.isBvnVerified}, nin=${user.isNinVerified}, ` +
            `doc=${user.isDocumentVerified}, address=${user.isAddressVerified}, income=${user.isIncomeVerified}, ` +
            `currentTier=${user.tier ?? 0}`);

        const newTier = this.calculateTier(user);

        this.logger.log(`[Tier Calc] User ${userId} calculated tier: ${newTier}`);

        if ((user.tier ?? 0) !== newTier) {
            this.logger.log(
                `Updating user ${userId} tier from ${user.tier ?? 0} to ${newTier}`
            );

            const updatedUser = await this.prisma.user.update({
                where: { id: userId },
                data: { tier: newTier } as any,
            }) as UserWithTier;

            return updatedUser;
        }

        this.logger.log(`[Tier Calc] User ${userId} tier unchanged at ${user.tier ?? 0}`);
        return user;
    }

    /**
     * Recalculate & persist tier AND always invalidate profile cache.
     * Use this after ANY verification-flag write so that:
     *   1. The DB tier column stays in sync with flags
     *   2. The cached profile (which includes flags + tier) is never stale
     *
     * This method always flushes cache because verification flags embedded in
     * the cached profile may have changed even when the computed tier hasn't.
     */
    async syncTierAndCache(userId: number): Promise<UserWithTier> {
        const result = await this.updateUserTier(userId);

        // Always invalidate cache regardless of whether the tier changed,
        // because verification flags in the cached profile may be stale.
        await this.redisCacheService.del(this.PROFILE_CACHE_KEY(userId));
        this.logger.log(`[Tier Sync] Cache invalidated for user ${userId}`);

        return result;
    }

    /**
     * Update tiers for all users based on their verification status
     * This is a one-time migration endpoint for existing users
     * @returns Summary of updates performed
     */
    async updateAllUserTiers(): Promise<{
        total: number;
        updated: number;
        unchanged: number;
        errors: number;
        changes: Array<{ email: string; from: number; to: number }>;
    }> {
        this.logger.log("Starting bulk tier update for all users");

        const users = await this.prisma.user.findMany({
            select: {
                id: true,
                email: true,
                userType: true,
                tier: true,
                isEmailVerified: true,
                isPhoneVerified: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                businessRecordCompleted: true,
                businessDocumentsUploaded: true,
            },
        });

        let updated = 0;
        let unchanged = 0;
        let errors = 0;
        const changes: Array<{ email: string; from: number; to: number }> = [];

        for (const user of users) {
            try {
                const currentTier = (user.tier as number) ?? 0;
                const newTier = this.calculateTier(user as any);

                if (currentTier !== newTier) {
                    await this.prisma.user.update({
                        where: { id: user.id },
                        data: { tier: newTier } as any,
                    });

                    await this.redisCacheService.del(this.PROFILE_CACHE_KEY(user.id));

                    changes.push({
                        email: user.email,
                        from: currentTier,
                        to: newTier,
                    });

                    this.logger.log(
                        `Updated ${user.email}: Tier ${currentTier} -> ${newTier}`
                    );
                    updated++;
                } else {
                    unchanged++;
                }
            } catch (error) {
                this.logger.error(
                    `Error updating tier for user ${user.id}: ${error.message}`
                );
                errors++;
            }
        }

        this.logger.log(
            `Bulk tier update complete: ${updated} updated, ${unchanged} unchanged, ${errors} errors`
        );

        return {
            total: users.length,
            updated,
            unchanged,
            errors,
            changes,
        };
    }

    /**
     * Check if a user can perform a withdrawal based on their tier and amount
     * @param user - The user object
     * @param amountInUSD - The withdrawal amount in USD
     * @param currentDailyTotal - Current daily withdrawal total in USD
     * @returns Object with canWithdraw flag and reason if blocked
     */
    async validateWithdrawal(
        user: Partial<UserWithTier>,
        amountInUSD: number,
        currentDailyTotal: number
    ): Promise<{ canWithdraw: boolean; reason?: string }> {
        const tierInfo = await this.getTierInfo(user);

        // Tier 0 cannot transact
        if (!tierInfo.canTransact) {
            return {
                canWithdraw: false,
                reason: "Complete KYC verification to unlock withdrawals",
            };
        }

        // Unlimited withdrawals for Tier 3
        if (tierInfo.withdrawalLimit === "unlimited") {
            return { canWithdraw: true };
        }

        // Check daily limit for Tier 1 and 2
        const newTotal = currentDailyTotal + amountInUSD;
        if (newTotal > tierInfo.withdrawalLimit) {
            return {
                canWithdraw: false,
                reason: `Daily withdrawal limit of $${tierInfo.withdrawalLimit} exceeded. Current: $${currentDailyTotal}, Attempted: $${amountInUSD}`,
            };
        }

        return { canWithdraw: true };
    }

}
