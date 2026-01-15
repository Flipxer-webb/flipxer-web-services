import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { DepositReviewStatus } from "@prisma/client";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Result of deposit float check
 */
export interface FloatCheckResult {
    allowed: boolean;
    queued: boolean;
    queueId?: string;
    floatPercentage: number;
    reason?: string;
}

/**
 * DepositReviewService
 *
 * Manages the deposit review queue for deposits that exceed float thresholds.
 * When the float exposure exceeds the blockThreshold, deposits are queued
 * for admin review instead of being credited immediately.
 *
 * Key features:
 * - Check if deposit exceeds float block threshold
 * - Queue deposits for admin review
 * - Auto-approve after configurable timeout
 * - Admin approval/rejection
 */
@Injectable()
export class DepositReviewService {
    private readonly logger = new Logger(DepositReviewService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly slackWebhookService: SlackWebhookService
    ) { }

    /**
     * Check if a deposit should be queued due to float exposure
     *
     * @param userId User receiving the deposit
     * @param currency Currency being deposited
     * @param amount Deposit amount
     * @param depositAddress Address deposit was received on
     * @param txHash Blockchain transaction hash
     * @returns FloatCheckResult indicating if deposit is allowed or queued
     */
    async checkAndQueueIfNeeded(
        userId: number,
        currency: string,
        amount: Decimal,
        depositAddress: string,
        txHash?: string
    ): Promise<FloatCheckResult> {
        const upperCurrency = currency.toUpperCase();

        // Get float config for this currency
        const floatConfig = await this.prisma.floatConfig.findUnique({
            where: { currency: upperCurrency },
        });

        // If no float config or not active, allow deposit
        if (!floatConfig || !floatConfig.isActive) {
            return {
                allowed: true,
                queued: false,
                floatPercentage: 0,
            };
        }

        // Calculate current float exposure
        const floatPercentage = await this.calculateFloatPercentage(upperCurrency);

        // If below block threshold, allow deposit
        if (floatPercentage < floatConfig.blockThreshold.toNumber()) {
            // If approaching alert threshold, log warning
            if (floatPercentage >= floatConfig.alertThreshold.toNumber()) {
                this.logger.warn(
                    `Float approaching block threshold | ${upperCurrency} | Current: ${floatPercentage.toFixed(2)}% | Block at: ${floatConfig.blockThreshold}%`
                );
            }
            return {
                allowed: true,
                queued: false,
                floatPercentage,
            };
        }

        // Float exceeds block threshold - queue deposit for review
        this.logger.warn(
            `Float exceeds block threshold | ${upperCurrency} | Current: ${floatPercentage.toFixed(2)}% | Threshold: ${floatConfig.blockThreshold}% | Queueing deposit`
        );

        // Calculate auto-approve time
        const autoApproveAt = floatConfig.autoApproveHours > 0
            ? new Date(Date.now() + floatConfig.autoApproveHours * 60 * 60 * 1000)
            : null;

        // Create queue entry
        const queueEntry = await this.prisma.depositReviewQueue.create({
            data: {
                userId,
                currency: upperCurrency,
                amount,
                depositAddress,
                txHash,
                floatAtDeposit: new Decimal(floatPercentage),
                status: DepositReviewStatus.PENDING,
                autoApproveAt,
            },
        });

        // Send Slack alert
        await this.sendQueuedDepositAlert(userId, upperCurrency, amount, floatPercentage, queueEntry.id);

        return {
            allowed: false,
            queued: true,
            queueId: queueEntry.id,
            floatPercentage,
            reason: `Deposit queued for review due to high float exposure (${floatPercentage.toFixed(2)}%)`,
        };
    }

    /**
     * Calculate current float percentage for a currency
     * Float = (Total user ledger balances) / (Actual blockchain balance) * 100
     */
    private async calculateFloatPercentage(currency: string): Promise<number> {
        // Get total user balances from ledger
        const ledgerResult = await this.prisma.ledgerEntry.aggregate({
            where: {
                currency,
                userId: { not: 0 }, // Exclude platform account
            },
            _sum: {
                balanceAfter: true,
            },
        });

        const totalLedgerBalance = ledgerResult._sum.balanceAfter || new Decimal(0);

        // Get float config for allowance
        const floatConfig = await this.prisma.floatConfig.findUnique({
            where: { currency },
        });

        if (!floatConfig || floatConfig.floatAllowance.eq(0)) {
            return 0;
        }

        // Calculate percentage of float allowance used
        return totalLedgerBalance.div(floatConfig.floatAllowance).mul(100).toNumber();
    }

    /**
     * Get pending deposit reviews
     */
    async getPendingReviews() {
        return this.prisma.depositReviewQueue.findMany({
            where: { status: DepositReviewStatus.PENDING },
            include: {
                user: {
                    select: {
                        id: true,
                        email: true,
                        firstName: true,
                        lastName: true,
                    },
                },
            },
            orderBy: { queuedAt: "asc" },
        });
    }

    /**
     * Approve a queued deposit
     */
    async approveDeposit(
        queueId: string,
        adminId: number,
        notes?: string
    ): Promise<{ success: boolean; entry?: any; error?: string }> {
        const queueEntry = await this.prisma.depositReviewQueue.findUnique({
            where: { id: queueId },
        });

        if (!queueEntry) {
            return { success: false, error: "Queue entry not found" };
        }

        if (queueEntry.status !== DepositReviewStatus.PENDING) {
            return { success: false, error: `Deposit already ${queueEntry.status}` };
        }

        // Update queue entry
        const updated = await this.prisma.depositReviewQueue.update({
            where: { id: queueId },
            data: {
                status: DepositReviewStatus.APPROVED,
                reviewedAt: new Date(),
                reviewedBy: adminId,
                notes,
            },
        });

        this.logger.log(`Deposit approved | Queue: ${queueId} | Admin: ${adminId}`);

        return {
            success: true,
            entry: updated,
        };
    }

    /**
     * Reject a queued deposit
     */
    async rejectDeposit(
        queueId: string,
        adminId: number,
        notes?: string
    ): Promise<{ success: boolean; error?: string }> {
        const queueEntry = await this.prisma.depositReviewQueue.findUnique({
            where: { id: queueId },
        });

        if (!queueEntry) {
            return { success: false, error: "Queue entry not found" };
        }

        if (queueEntry.status !== DepositReviewStatus.PENDING) {
            return { success: false, error: `Deposit already ${queueEntry.status}` };
        }

        await this.prisma.depositReviewQueue.update({
            where: { id: queueId },
            data: {
                status: DepositReviewStatus.REJECTED,
                reviewedAt: new Date(),
                reviewedBy: adminId,
                notes,
            },
        });

        this.logger.log(`Deposit rejected | Queue: ${queueId} | Admin: ${adminId}`);

        return { success: true };
    }

    /**
     * Process auto-approvals for deposits past their timeout
     */
    async processAutoApprovals(): Promise<number> {
        const now = new Date();

        const pendingAutoApprovals = await this.prisma.depositReviewQueue.findMany({
            where: {
                status: DepositReviewStatus.PENDING,
                autoApproveAt: { lte: now },
            },
        });

        let approvedCount = 0;

        for (const entry of pendingAutoApprovals) {
            await this.prisma.depositReviewQueue.update({
                where: { id: entry.id },
                data: {
                    status: DepositReviewStatus.AUTO_APPROVED,
                    reviewedAt: now,
                    notes: "Auto-approved after timeout",
                },
            });

            this.logger.log(`Deposit auto-approved | Queue: ${entry.id} | User: ${entry.userId}`);
            approvedCount++;
        }

        if (approvedCount > 0) {
            this.logger.log(`Auto-approved ${approvedCount} queued deposits`);
        }

        return approvedCount;
    }

    /**
     * Get statistics for deposit review queue
     */
    async getStats() {
        const [pending, approved, rejected, autoApproved] = await Promise.all([
            this.prisma.depositReviewQueue.count({
                where: { status: DepositReviewStatus.PENDING },
            }),
            this.prisma.depositReviewQueue.count({
                where: { status: DepositReviewStatus.APPROVED },
            }),
            this.prisma.depositReviewQueue.count({
                where: { status: DepositReviewStatus.REJECTED },
            }),
            this.prisma.depositReviewQueue.count({
                where: { status: DepositReviewStatus.AUTO_APPROVED },
            }),
        ]);

        return {
            pending,
            approved,
            rejected,
            autoApproved,
            total: pending + approved + rejected + autoApproved,
        };
    }

    /**
     * Send Slack alert for queued deposit
     */
    private async sendQueuedDepositAlert(
        userId: number,
        currency: string,
        amount: Decimal,
        floatPercentage: number,
        queueId: string
    ): Promise<void> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true, lastName: true },
            });

            await this.slackWebhookService.sendSystemAlert(
                "deposit_review",
                "⚠️ DEPOSIT QUEUED FOR REVIEW",
                `Deposit blocked due to high float exposure`,
                {
                    queueId,
                    userId,
                    userEmail: user?.email,
                    userName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                    amount: amount.toString(),
                    currency,
                    floatPercentage: `${floatPercentage.toFixed(2)}%`,
                },
                "warning"
            );
        } catch (error) {
            this.logger.error(`Failed to send queued deposit alert: ${error.message}`);
        }
    }
}
