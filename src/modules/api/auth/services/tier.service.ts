import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { User, UserType } from "@prisma/client";

export type TierLevel = 0 | 1 | 2 | 3 | 4;

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

/**
 * Tier Names:
 * 0 = Basic (deposit only)
 * 1 = Standard (BVN/NIN verified)
 * 2 = Intermediate (Document verified)
 * 3 = Pro (Address verified)
 * 4 = Premium (Income verified)
 */
const WITHDRAWAL_LIMITS: Record<TierLevel, number | "unlimited"> = {
    0: 0,        // Basic: deposit only
    1: 10000,    // Standard: $10,000/day
    2: 50000,    // Intermediate: $50,000/day
    3: 100000,   // Pro: $100,000/day
    4: "unlimited", // Premium: unlimited
};

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

    constructor(private readonly prisma: PrismaService) { }

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
        // Business docs uploaded = full access (Tier 1 for business)
        if (user.businessDocumentsUploaded) {
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
    getTierInfo(user: Partial<UserWithTier>): TierInfo {
        const tier = this.calculateTier(user);
        return {
            tier,
            withdrawalLimit: this.getWithdrawalLimit(tier),
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

            return this.prisma.user.update({
                where: { id: userId },
                data: { tier: newTier } as any,
            }) as Promise<UserWithTier>;
        }

        this.logger.log(`[Tier Calc] User ${userId} tier unchanged at ${user.tier ?? 0}`);
        return user;
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
    validateWithdrawal(
        user: Partial<UserWithTier>,
        amountInUSD: number,
        currentDailyTotal: number
    ): { canWithdraw: boolean; reason?: string } {
        const tierInfo = this.getTierInfo(user);

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

    /**
     * Reset a user's verification status for testing purposes
     * WARNING: This should only be used for testing in non-production environments
     * @param email - The email of the user to reset
     * @returns The user before and after reset
     */
    async resetUserForTesting(email: string): Promise<{
        before: Partial<UserWithTier>;
        after: Partial<UserWithTier>;
    }> {
        const user = await this.prisma.user.findUnique({
            where: { email },
            select: {
                id: true,
                email: true,
                tier: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
                bvn: true,
                nin: true,
            },
        });

        if (!user) {
            throw new Error(`User with email ${email} not found`);
        }

        const before = { ...user };

        // Reset all verification flags and tier
        const updated = await this.prisma.user.update({
            where: { id: user.id },
            data: {
                tier: 0,
                isBvnVerified: false,
                isNinVerified: false,
                isDocumentVerified: false,
                isAddressVerified: false,
                isIncomeVerified: false,
                bvn: null,
                nin: null,
            },
            select: {
                id: true,
                email: true,
                tier: true,
                isBvnVerified: true,
                isNinVerified: true,
                isDocumentVerified: true,
                isAddressVerified: true,
                isIncomeVerified: true,
            },
        });

        this.logger.log(`Reset user ${email} to Tier 0 for testing`);

        return {
            before,
            after: updated,
        };
    }
}
