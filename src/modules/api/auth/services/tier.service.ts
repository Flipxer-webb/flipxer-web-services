import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { User, UserType } from "@prisma/client";

export type TierLevel = 0 | 1 | 2 | 3;

export interface TierInfo {
    tier: TierLevel;
    withdrawalLimit: number | "unlimited";
    canTransact: boolean;
}

// User with tier fields - these fields are added to the database but may not be in Prisma types yet
export type UserWithTier = User & {
    tier?: number;
    isAddressVerified?: boolean;
    isBiometricVerified?: boolean;
    isIncomeVerified?: boolean;
};

const WITHDRAWAL_LIMITS: Record<TierLevel, number | "unlimited"> = {
    0: 0,
    1: 10000,
    2: 50000,
    3: "unlimited",
};

@Injectable()
export class TierService {
    private readonly logger = new Logger(TierService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Calculate the tier for a user based on their verification status
     * @param user - The user object with verification flags
     * @returns The calculated tier level (0-3)
     */
    calculateTier(user: Partial<UserWithTier>): TierLevel {
        // Business accounts get Tier 3 automatically when KYC is complete
        if (user.userType === UserType.BUSINESS) {
            if (user.businessRecordCompleted && user.businessDocumentsUploaded) {
                return 3;
            }
            return 0;
        }

        // Individual tier calculation
        // Tier 0: Email + SMS verified (newly onboarded)
        if (!user.isEmailVerified || !user.isPhoneVerified) {
            return 0; // Should not happen if login is enforced, but safety check
        }

        // Tier 3: Biometric + Income verified
        if (
            user.isDocumentVerified &&
            user.isAddressVerified &&
            user.isBiometricVerified &&
            user.isIncomeVerified
        ) {
            return 3;
        }

        // Tier 2: Document + Address verified
        if (user.isDocumentVerified && user.isAddressVerified) {
            return 2;
        }

        // Tier 1: BVN verified + Document verified
        if (user.isBvnVerified && user.isDocumentVerified) {
            return 1;
        }

        // Tier 0: Only email/phone verified (onboarded but no KYC)
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

        const newTier = this.calculateTier(user);

        if ((user.tier ?? 0) !== newTier) {
            this.logger.log(
                `Updating user ${userId} tier from ${user.tier ?? 0} to ${newTier}`
            );

            return this.prisma.user.update({
                where: { id: userId },
                data: { tier: newTier } as any,
            }) as Promise<UserWithTier>;
        }

        return user;
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
}
