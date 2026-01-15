import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { LedgerService } from "./ledger.service";
import { ReconciliationService } from "./reconciliation.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Validation result for high-value transactions
 */
export interface ValidationResult {
    success: boolean;
    blocked: boolean;
    reason?: string;
    checks: {
        balanceVerified: boolean;
        reconciliationOk: boolean;
        thresholdBreached: boolean;
        blockingDiscrepancy: boolean;
    };
}

/**
 * Transaction validation options
 */
export interface ValidateOptions {
    userId: number;
    currency: string;
    amount: Decimal | number | string;
    operationType: "SELL" | "WITHDRAWAL" | "SEND";
    reference?: string;
}

/**
 * TransactionMonitorService
 *
 * Provides real-time validation for high-value transactions to close the
 * 60-minute reconciliation lag window. For transactions above a configurable
 * threshold (default $5,000 USDT equivalent), this service:
 *
 * 1. Verifies user's ledger balance matches expected state
 * 2. Checks for recent reconciliation discrepancies
 * 3. Blocks if critical issues detected
 * 4. Alerts operations team for borderline cases
 *
 * Design decisions:
 * - Only triggers for transactions above threshold (reduces overhead)
 * - Non-blocking for small transactions (preserve UX)
 * - Configurable via SystemSetting
 * - Alerts only, doesn't auto-block (except for critical discrepancies)
 */
@Injectable()
export class TransactionMonitorService {
    private readonly logger = new Logger(TransactionMonitorService.name);

    // Default threshold in USDT equivalent
    private readonly DEFAULT_THRESHOLD_USDT = 5000;

    // Discrepancy percentage that blocks transactions
    private readonly BLOCKING_DISCREPANCY_PCT = 0.1; // 0.1%

    constructor(
        private readonly prisma: PrismaService,
        private readonly ledgerService: LedgerService,
        private readonly reconciliationService: ReconciliationService,
        private readonly slackWebhookService: SlackWebhookService
    ) { }

    /**
     * Get the current monitoring threshold from SystemSettings
     * Falls back to default if not configured
     */
    async getThreshold(): Promise<number> {
        try {
            const setting = await this.prisma.systemSetting.findUnique({
                where: { key: "transaction_monitor_threshold_usdt" },
            });

            if (setting?.value && typeof setting.value === "object" && "threshold" in setting.value) {
                return Number((setting.value as { threshold: number }).threshold) || this.DEFAULT_THRESHOLD_USDT;
            }

            return this.DEFAULT_THRESHOLD_USDT;
        } catch {
            return this.DEFAULT_THRESHOLD_USDT;
        }
    }

    /**
     * Check if monitoring is enabled
     */
    async isEnabled(): Promise<boolean> {
        try {
            const setting = await this.prisma.systemSetting.findUnique({
                where: { key: "transaction_monitor_enabled" },
            });

            if (setting?.value && typeof setting.value === "object" && "enabled" in setting.value) {
                return Boolean((setting.value as { enabled: boolean }).enabled);
            }

            // Enabled by default
            return true;
        } catch {
            return true;
        }
    }

    /**
     * Convert amount to USDT equivalent for threshold comparison
     * Uses sell rates from crypto rates table
     */
    async getUsdtEquivalent(currency: string, amount: Decimal): Promise<Decimal> {
        const upperCurrency = currency.toUpperCase();

        // USDT is 1:1
        if (upperCurrency === "USDT") {
            return amount;
        }

        try {
            // Get rate from crypto rates table
            const rate = await this.prisma.cryptoRate.findUnique({
                where: { currency: upperCurrency },
            });

            if (!rate) {
                // If no rate found, be conservative and treat as high value
                this.logger.warn(`No rate found for ${upperCurrency}, treating as high value`);
                return new Decimal(this.DEFAULT_THRESHOLD_USDT + 1);
            }

            // Convert to NGN then to USDT (approximate using USDT rate)
            const usdtRate = await this.prisma.cryptoRate.findUnique({
                where: { currency: "USDT" },
            });

            if (!usdtRate || usdtRate.sellRate === 0) {
                this.logger.warn("No USDT rate found for conversion");
                return new Decimal(this.DEFAULT_THRESHOLD_USDT + 1);
            }

            const ngnValue = amount.mul(rate.sellRate);
            return ngnValue.div(usdtRate.sellRate);
        } catch (error) {
            this.logger.error(`Error converting to USDT: ${error.message}`);
            // Be conservative - treat as high value if conversion fails
            return new Decimal(this.DEFAULT_THRESHOLD_USDT + 1);
        }
    }

    /**
     * Check if transaction exceeds monitoring threshold
     */
    async exceedsThreshold(currency: string, amount: Decimal | number | string): Promise<boolean> {
        const amountDecimal = new Decimal(amount);
        const usdtEquivalent = await this.getUsdtEquivalent(currency, amountDecimal);
        const threshold = await this.getThreshold();

        return usdtEquivalent.gte(threshold);
    }

    /**
     * Validate a high-value transaction before execution
     *
     * This is the main entry point called from trade services.
     * Returns validation result with pass/fail and reason.
     *
     * @param options Transaction details to validate
     * @returns Validation result
     */
    async validateBeforeExecution(options: ValidateOptions): Promise<ValidationResult> {
        const { userId, currency, amount, operationType, reference } = options;
        const upperCurrency = currency.toUpperCase();
        const amountDecimal = new Decimal(amount);

        // Check if monitoring is enabled
        const enabled = await this.isEnabled();
        if (!enabled) {
            return {
                success: true,
                blocked: false,
                checks: {
                    balanceVerified: true,
                    reconciliationOk: true,
                    thresholdBreached: false,
                    blockingDiscrepancy: false,
                },
            };
        }

        // Check if this transaction exceeds threshold
        const thresholdBreached = await this.exceedsThreshold(upperCurrency, amountDecimal);

        if (!thresholdBreached) {
            // Small transaction - skip detailed checks
            return {
                success: true,
                blocked: false,
                checks: {
                    balanceVerified: true,
                    reconciliationOk: true,
                    thresholdBreached: false,
                    blockingDiscrepancy: false,
                },
            };
        }

        this.logger.log(`High-value ${operationType} detected | User: ${userId} | Amount: ${amountDecimal} ${upperCurrency} | Ref: ${reference || 'N/A'}`);

        // Perform detailed validation checks
        const checks = await this.performValidationChecks(userId, upperCurrency, amountDecimal, operationType);

        // Determine if we should block
        const shouldBlock = checks.blockingDiscrepancy;

        if (shouldBlock) {
            this.logger.warn(`BLOCKING high-value ${operationType} | User: ${userId} | Reason: Reconciliation discrepancy`);

            await this.sendBlockingAlert(userId, upperCurrency, amountDecimal, operationType, checks, reference);

            return {
                success: false,
                blocked: true,
                reason: "Transaction blocked due to reconciliation discrepancy. Please contact support.",
                checks,
            };
        }

        // Alert if borderline (discrepancy exists but not blocking)
        if (!checks.reconciliationOk) {
            await this.sendWarningAlert(userId, upperCurrency, amountDecimal, operationType, checks, reference);
        }

        return {
            success: true,
            blocked: false,
            checks,
        };
    }

    /**
     * Perform detailed validation checks for high-value transaction
     */
    private async performValidationChecks(
        userId: number,
        currency: string,
        amount: Decimal,
        operationType: string
    ): Promise<ValidationResult["checks"]> {
        let balanceVerified = true;
        let reconciliationOk = true;
        let blockingDiscrepancy = false;

        try {
            // 1. Verify user has sufficient balance
            const balance = await this.ledgerService.getBalance(userId, currency);

            if (balance.available.lt(amount)) {
                balanceVerified = false;
                this.logger.warn(`Balance verification failed | User: ${userId} | Available: ${balance.available} | Required: ${amount}`);
            }

            // 2. Check recent reconciliation for this currency
            const recentLogs = await this.prisma.reconciliationLog.findMany({
                where: { currency },
                orderBy: { createdAt: "desc" },
                take: 1,
            });

            if (recentLogs.length > 0) {
                const latestRecon = recentLogs[0];
                const discrepancyPct = latestRecon.discrepancyPct.abs().toNumber();

                if (discrepancyPct > 0.01) {
                    reconciliationOk = false;
                }

                if (discrepancyPct > this.BLOCKING_DISCREPANCY_PCT) {
                    blockingDiscrepancy = true;
                }

                // Also check if withdrawals are paused for this currency
                if (latestRecon.pausedWithdrawals && !latestRecon.resolvedAt) {
                    blockingDiscrepancy = true;
                    this.logger.warn(`Withdrawals paused for ${currency} due to reconciliation`);
                }
            }
        } catch (error) {
            this.logger.error(`Error performing validation checks: ${error.message}`);
            // On error, allow transaction but flag as unverified
            reconciliationOk = false;
        }

        return {
            balanceVerified,
            reconciliationOk,
            thresholdBreached: true,
            blockingDiscrepancy,
        };
    }

    /**
     * Send Slack alert for blocked transaction
     */
    private async sendBlockingAlert(
        userId: number,
        currency: string,
        amount: Decimal,
        operationType: string,
        checks: ValidationResult["checks"],
        reference?: string
    ): Promise<void> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true, lastName: true },
            });

            await this.slackWebhookService.sendSystemAlert(
                "transaction_monitor",
                "🚨 HIGH-VALUE TRANSACTION BLOCKED",
                `A ${operationType} was blocked due to reconciliation discrepancy`,
                {
                    userId,
                    userEmail: user?.email,
                    userName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                    amount: amount.toString(),
                    currency,
                    operationType,
                    reference: reference || 'N/A',
                    checks,
                },
                "error"
            );
        } catch (error) {
            this.logger.error(`Failed to send blocking alert: ${error.message}`);
        }
    }

    /**
     * Send Slack warning for high-value transaction with minor issues
     */
    private async sendWarningAlert(
        userId: number,
        currency: string,
        amount: Decimal,
        operationType: string,
        checks: ValidationResult["checks"],
        reference?: string
    ): Promise<void> {
        try {
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { email: true, firstName: true, lastName: true },
            });

            await this.slackWebhookService.sendSystemAlert(
                "transaction_monitor",
                "⚠️ HIGH-VALUE TRANSACTION WARNING",
                `A ${operationType} was allowed but has validation warnings`,
                {
                    userId,
                    userEmail: user?.email,
                    userName: `${user?.firstName || ''} ${user?.lastName || ''}`.trim(),
                    amount: amount.toString(),
                    currency,
                    operationType,
                    reference: reference || 'N/A',
                    checks,
                },
                "warning"
            );
        } catch (error) {
            this.logger.error(`Failed to send warning alert: ${error.message}`);
        }
    }

    /**
     * Get monitoring statistics
     */
    async getStats(): Promise<{
        enabled: boolean;
        thresholdUsdt: number;
        recentBlockedCount: number;
    }> {
        const enabled = await this.isEnabled();
        const threshold = await this.getThreshold();

        // Count blocked transactions in last 24h (would need audit log in Phase 3)
        // For now, return 0 as placeholder
        return {
            enabled,
            thresholdUsdt: threshold,
            recentBlockedCount: 0,
        };
    }
}
