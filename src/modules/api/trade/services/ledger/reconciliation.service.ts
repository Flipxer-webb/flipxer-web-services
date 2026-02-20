import { Injectable, Logger, Inject } from "@nestjs/common";
import { ReconciliationLog } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { FloatConfigService } from "./float-config.service";
import { WithdrawalQueueService } from "./withdrawal-queue.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Reconciliation result for a single currency
 */
export interface ReconciliationResult {
    currency: string;
    ledgerTotal: Decimal;
    blockchainTotal: Decimal;
    discrepancy: Decimal;
    discrepancyPct: Decimal;
    isWithinTolerance: boolean;
    action: "none" | "alert" | "pause";
}

/**
 * Full reconciliation report
 */
export interface ReconciliationReport {
    timestamp: Date;
    results: ReconciliationResult[];
    overallStatus: "ok" | "warning" | "critical";
    pausedQueues: string[];
}

/**
 * ReconciliationService
 *
 * Performs hourly reconciliation between ledger balances and blockchain balances.
 *
 * Design decisions (from user requirements):
 * - Auto-pause on >0.1% discrepancy
 * - Slack alert on any discrepancy >0.01%
 * - Stores snapshots for audit trail
 * - Requires explicit admin approval to resume
 *
 * Reconciliation formula:
 * - Ledger Total = sum of all user balanceAfter (latest entry per user)
 * - Blockchain Total = main wallet balance (from Quidax)
 * - Discrepancy = |Ledger - Blockchain|
 * - Discrepancy% = (Discrepancy / Ledger) * 100
 */
@Injectable()
export class ReconciliationService {
    private readonly logger = new Logger(ReconciliationService.name);

    // Threshold percentages
    private readonly ALERT_THRESHOLD_PCT = new Decimal(0.01); // 0.01% - send alert
    private readonly PAUSE_THRESHOLD_PCT = new Decimal(0.1); // 0.1% - pause withdrawals

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly floatConfigService: FloatConfigService,
        private readonly withdrawalQueueService: WithdrawalQueueService
    ) { }

    /**
     * Runs full reconciliation for all active currencies
     *
     * @returns Reconciliation report
     */
    async runReconciliation(): Promise<ReconciliationReport> {
        const timestamp = new Date();
        const results: ReconciliationResult[] = [];
        const pausedQueues: string[] = [];

        // Get all currencies with ledger entries
        const currencies = await this.getActiveCurrencies();

        for (const currency of currencies) {
            try {
                const result = await this.reconcileCurrency(currency);
                results.push(result);

                // Log to database
                await this.logReconciliation(result);

                // Take action based on result
                if (result.action === "pause") {
                    await this.withdrawalQueueService.pauseProcessing(
                        `Reconciliation discrepancy: ${result.discrepancyPct.toString()}% for ${currency}`
                    );
                    pausedQueues.push(currency);
                }

                if (result.action === "alert" || result.action === "pause") {
                    await this.sendDiscrepancyAlert(result);
                }
            } catch (error) {
                this.logger.error(
                    `Reconciliation failed for ${currency} | ${error.message}`
                );

                // Create error result
                results.push({
                    currency,
                    ledgerTotal: new Decimal(0),
                    blockchainTotal: new Decimal(0),
                    discrepancy: new Decimal(0),
                    discrepancyPct: new Decimal(0),
                    isWithinTolerance: false,
                    action: "alert",
                });
            }
        }

        // Determine overall status
        const hasCritical = results.some((r) => r.action === "pause");
        const hasWarning = results.some((r) => r.action === "alert");
        const overallStatus = hasCritical
            ? "critical"
            : hasWarning
                ? "warning"
                : "ok";

        const report: ReconciliationReport = {
            timestamp,
            results,
            overallStatus,
            pausedQueues,
        };

        this.logger.log(
            `Reconciliation complete | status: ${overallStatus}, currencies: ${currencies.length}, paused: ${pausedQueues.length}`
        );

        return report;
    }

    /**
     * Reconciles a single currency
     *
     * @param currency Currency symbol
     * @returns Reconciliation result
     */
    async reconcileCurrency(currency: string): Promise<ReconciliationResult> {
        const upperCurrency = currency.toUpperCase();

        // Get ledger total (sum of latest balanceAfter for each user)
        const ledgerTotal = await this.getLedgerTotal(upperCurrency);

        // Get blockchain balance from main wallet
        const blockchainTotal = await this.getBlockchainBalance(upperCurrency);

        // Calculate discrepancy
        const discrepancy = ledgerTotal.minus(blockchainTotal).abs();

        // Calculate percentage (avoid division by zero)
        const discrepancyPct = ledgerTotal.isZero()
            ? new Decimal(0)
            : discrepancy.dividedBy(ledgerTotal).times(100);

        // Determine action
        let action: "none" | "alert" | "pause" = "none";
        if (discrepancyPct.greaterThanOrEqualTo(this.PAUSE_THRESHOLD_PCT)) {
            action = "pause";
        } else if (
            discrepancyPct.greaterThanOrEqualTo(this.ALERT_THRESHOLD_PCT)
        ) {
            action = "alert";
        }

        const isWithinTolerance = action === "none";

        return {
            currency: upperCurrency,
            ledgerTotal,
            blockchainTotal,
            discrepancy,
            discrepancyPct,
            isWithinTolerance,
            action,
        };
    }

    /**
     * Gets sum of all user balances from ledger
     *
     * @param currency Currency symbol
     * @returns Total balance across all users
     */
    private async getLedgerTotal(currency: string): Promise<Decimal> {
        // Get the latest balance for each user by finding the most recent entry
        // This is more complex - we need to aggregate the latest balanceAfter per user

        const latestBalances = await this.prisma.$queryRaw<
            { total: Decimal }[]
        >`
            SELECT COALESCE(SUM(latest."balanceAfter"), 0) as total
            FROM (
                SELECT DISTINCT ON ("userId") "balanceAfter"
                FROM "LedgerEntries"
                WHERE currency = ${currency}
                  AND status != 'FAILED'
                  AND "userId" > 0  -- Exclude platform account
                ORDER BY "userId", "createdAt" DESC
            ) as latest
        `;

        return latestBalances[0]?.total ?? new Decimal(0);
    }

    /**
     * Gets main wallet balance from blockchain (via Quidax)
     *
     * @param currency Currency symbol
     * @returns Blockchain balance
     */
    private async getBlockchainBalance(currency: string): Promise<Decimal> {
        try {
            // Get main account balance from Quidax using "me" for the main wallet
            const walletData = await this.quidaxService.getUserWallet({
                user_id: "me",
                currency: currency.toLowerCase(),
            });

            if (!walletData?.data) {
                this.logger.warn(
                    `No wallet data returned for main account currency ${currency}`
                );
                return new Decimal(0);
            }

            return new Decimal(walletData.data.balance ?? 0);
        } catch (error) {
            this.logger.error(
                `Failed to get blockchain balance for ${currency} | ${error.message}`
            );
            throw error;
        }
    }

    /**
     * Logs reconciliation result to database
     *
     * @param result Reconciliation result
     */
    private async logReconciliation(
        result: ReconciliationResult
    ): Promise<ReconciliationLog> {
        return this.prisma.reconciliationLog.create({
            data: {
                currency: result.currency,
                ledgerTotal: result.ledgerTotal,
                blockchainTotal: result.blockchainTotal,
                discrepancy: result.discrepancy,
                discrepancyPct: result.discrepancyPct,
                isWithinTolerance: result.action !== "pause",
                pausedWithdrawals: result.action === "pause",
            },
        });
    }

    /**
     * Sends Slack alert for discrepancy
     *
     * @param result Reconciliation result
     */
    private async sendDiscrepancyAlert(
        result: ReconciliationResult
    ): Promise<void> {
        try {
            const severity = result.action === "pause" ? "critical" : "warning";
            const emoji = severity === "critical" ? "🚨" : "⚠️";

            const messageText = [
                `${emoji} *Reconciliation ${severity.toUpperCase()}: ${result.currency
                }*`,
                ``,
                `Ledger Total: ${result.ledgerTotal.toString()} ${result.currency
                }`,
                `Blockchain Total: ${result.blockchainTotal.toString()} ${result.currency
                }`,
                `Discrepancy: ${result.discrepancy.toString()} ${result.currency
                } (${result.discrepancyPct.toFixed(4)}%)`,
                ``,
                result.action === "pause"
                    ? `❌ *Withdrawal queue PAUSED* - Admin approval required to resume`
                    : `📊 Monitoring - no action taken`,
            ].join("\n");

            await this.slackWebhookService.sendAlert(
                "RECONCILIATION_DISCREPANCY",
                { text: messageText },
                { alertKey: `reconciliation:${result.currency}` }
            );

            this.logger.warn(
                `Discrepancy alert sent | ${JSON.stringify({
                    currency: result.currency,
                    discrepancyPct: result.discrepancyPct.toString(),
                    action: result.action,
                })}`
            );
        } catch (error) {
            this.logger.error(
                `Failed to send discrepancy alert | ${JSON.stringify({
                    currency: result.currency,
                    error: error.message,
                })}`
            );
        }
    }

    /**
     * Gets all currencies with ledger entries
     *
     * @returns List of currency symbols
     */
    private async getActiveCurrencies(): Promise<string[]> {
        const currencies = await this.prisma.ledgerEntry.findMany({
            select: { currency: true },
            distinct: ["currency"],
        });

        return currencies.map((c) => c.currency);
    }

    /**
     * Gets recent reconciliation logs
     *
     * @param hours Number of hours to look back
     * @param currency Optional currency filter
     * @returns Reconciliation logs
     */
    async getRecentLogs(
        hours = 24,
        currency?: string
    ): Promise<ReconciliationLog[]> {
        const since = new Date();
        since.setHours(since.getHours() - hours);

        const where: any = {
            createdAt: { gte: since },
        };

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        return this.prisma.reconciliationLog.findMany({
            where,
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * Gets the latest reconciliation for each currency
     *
     * @returns Map of currency to latest reconciliation
     */
    async getLatestReconciliations(): Promise<Map<string, ReconciliationLog>> {
        const currencies = await this.getActiveCurrencies();
        const result = new Map<string, ReconciliationLog>();

        for (const currency of currencies) {
            const latest = await this.prisma.reconciliationLog.findFirst({
                where: { currency },
                orderBy: { createdAt: "desc" },
            });

            if (latest) {
                result.set(currency, latest);
            }
        }

        return result;
    }

    /**
     * Admin action to acknowledge and resume after discrepancy
     *
     * @param currency Currency to resume
     * @param adminUserId Admin user ID
     * @param reason Reason for resuming
     */
    async acknowledgeAndResume(
        currency: string,
        adminUserId: number,
        reason: string
    ): Promise<void> {
        // Log the acknowledgment
        this.logger.warn(
            `Discrepancy acknowledged | ${JSON.stringify({
                currency,
                adminUserId,
                reason,
            })}`
        );

        // Resume queue processing
        await this.withdrawalQueueService.resumeProcessing();

        // Send notification
        const messageText = `Admin ${adminUserId} acknowledged discrepancy and resumed processing.\nReason: ${reason}`;
        await this.slackWebhookService.sendAlert(
            "RECONCILIATION_ACKNOWLEDGED",
            { text: messageText },
            { alertKey: `reconciliation:acknowledged:${currency}` }
        );
    }
}
