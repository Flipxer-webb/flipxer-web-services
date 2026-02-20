import { Injectable, Logger, Inject } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { TradingInjectionToken } from "@/modules/factory/trading/types";
import { QuidaxService } from "@/modules/factory/trading/providers/quidax/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Solvency status for a single currency
 */
export interface CurrencySolvency {
    currency: string;
    userLiabilities: Decimal;      // Sum of all user virtual balances
    platformReserves: Decimal;     // Actual Quidax wallet balance
    reserveRatio: number;          // (reserves / liabilities) * 100
    pendingWithdrawals: Decimal;   // Holdings not yet settled
    effectiveReserveRatio: number; // (reserves / (liabilities + pending)) * 100
    status: "HEALTHY" | "WARNING" | "CRITICAL";
}

/**
 * Full solvency report
 */
export interface SolvencyReport {
    timestamp: Date;
    currencies: CurrencySolvency[];
    overallStatus: "HEALTHY" | "WARNING" | "CRITICAL";
    alertsSent: number;
}

/**
 * Solvency history snapshot
 */
export interface SolvencySnapshot {
    id: string;
    createdAt: Date;
    currency: string;
    userLiabilities: Decimal;
    platformReserves: Decimal;
    reserveRatio: number;
    status: string;
}

/**
 * SolvencyService
 *
 * Monitors platform solvency by comparing user liabilities (virtual balances)
 * against platform reserves (actual blockchain balances).
 *
 * Design decisions:
 * - Reserve Ratio = (Platform Reserves / User Liabilities) * 100
 * - HEALTHY: >= 100% (fully backed)
 * - WARNING: 50% - 99% (undercollateralized)
 * - CRITICAL: < 25% (severe risk)
 *
 * Runs every 30 minutes via cron job.
 */
@Injectable()
export class SolvencyService {
    private readonly logger = new Logger(SolvencyService.name);

    // Thresholds (in percentage)
    private readonly HEALTHY_THRESHOLD = 100;   // >= 100% = HEALTHY
    private readonly WARNING_THRESHOLD = 50;    // 50-99% = WARNING
    private readonly CRITICAL_THRESHOLD = 25;   // < 25% = CRITICAL

    // Track last alert to prevent spam
    private lastAlertTimestamp: Map<string, Date> = new Map();
    private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

    constructor(
        private readonly prisma: PrismaService,
        @Inject(TradingInjectionToken.QUIDAX)
        private readonly quidaxService: QuidaxService,
        private readonly slackWebhookService: SlackWebhookService
    ) { }

    /**
     * Generate comprehensive solvency report for all currencies
     */
    async generateReport(): Promise<SolvencyReport> {
        const timestamp = new Date();
        const currencies: CurrencySolvency[] = [];
        let alertsSent = 0;

        // Get all currencies with ledger entries
        const activeCurrencies = await this.getActiveCurrencies();

        for (const currency of activeCurrencies) {
            try {
                const solvency = await this.calculateCurrencySolvency(currency);
                currencies.push(solvency);

                // Log snapshot to database for history
                await this.logSolvencySnapshot(solvency);
            } catch (error) {
                this.logger.error(
                    `Solvency check failed for ${currency} | ${error.message}`
                );
                // Add error entry with CRITICAL status
                currencies.push({
                    currency,
                    userLiabilities: new Decimal(0),
                    platformReserves: new Decimal(0),
                    reserveRatio: 0,
                    pendingWithdrawals: new Decimal(0),
                    effectiveReserveRatio: 0,
                    status: "CRITICAL",
                });
            }
        }

        // Determine overall status
        const hasCritical = currencies.some((c) => c.status === "CRITICAL");
        const hasWarning = currencies.some((c) => c.status === "WARNING");
        const overallStatus = hasCritical
            ? "CRITICAL"
            : hasWarning
                ? "WARNING"
                : "HEALTHY";

        const report: SolvencyReport = {
            timestamp,
            currencies,
            overallStatus,
            alertsSent,
        };

        this.logger.log(
            `Solvency report generated | status: ${overallStatus}, currencies: ${currencies.length}`
        );

        return report;
    }

    /**
     * Cron job: Check solvency and send alerts every 30 minutes
     */
    @Cron(CronExpression.EVERY_30_MINUTES)
    async checkAndAlert(): Promise<void> {
        this.logger.log("Running scheduled solvency check...");

        try {
            const report = await this.generateReport();
            let alertsSent = 0;

            for (const currency of report.currencies) {
                if (currency.status !== "HEALTHY") {
                    const alertSent = await this.sendSolvencyAlert(currency);
                    if (alertSent) alertsSent++;
                }
            }

            if (alertsSent > 0) {
                this.logger.warn(`Solvency check complete | ${alertsSent} alerts sent`);
            } else {
                this.logger.log("Solvency check complete | All currencies healthy");
            }
        } catch (error) {
            this.logger.error(`Solvency check failed | ${error.message}`);
            await this.sendErrorAlert(error);
        }
    }

    /**
     * Get solvency history for a specific currency
     */
    async getHistory(currency: string, days: number = 7): Promise<SolvencySnapshot[]> {
        const since = new Date();
        since.setDate(since.getDate() - days);

        // Note: SolvencyLog model will be available after migration
        const snapshots = await (this.prisma as any).solvencyLog.findMany({
            where: {
                currency: currency.toUpperCase(),
                createdAt: { gte: since },
            },
            orderBy: { createdAt: "desc" },
            take: 100, // Limit results
        });

        return snapshots.map((s) => ({
            id: s.id,
            createdAt: s.createdAt,
            currency: s.currency,
            userLiabilities: s.userLiabilities,
            platformReserves: s.platformReserves,
            reserveRatio: s.reserveRatio.toNumber(),
            status: s.status,
        }));
    }

    /**
     * Calculate solvency for a single currency
     */
    private async calculateCurrencySolvency(currency: string): Promise<CurrencySolvency> {
        const upperCurrency = currency.toUpperCase();

        // Get user liabilities (sum of all user virtual balances)
        const userLiabilities = await this.getUserLiabilities(upperCurrency);

        // Get platform reserves (actual blockchain balance)
        const platformReserves = await this.getPlatformReserves(upperCurrency);

        // Get pending withdrawals (to calculate effective ratio)
        const pendingWithdrawals = await this.getPendingWithdrawals(upperCurrency);

        // Calculate reserve ratio
        // If no liabilities, we're 100% solvent by definition
        const reserveRatio = userLiabilities.isZero()
            ? 100
            : platformReserves.dividedBy(userLiabilities).times(100).toNumber();

        // Calculate effective ratio including pending withdrawals
        const totalObligations = userLiabilities.plus(pendingWithdrawals);
        const effectiveReserveRatio = totalObligations.isZero()
            ? 100
            : platformReserves.dividedBy(totalObligations).times(100).toNumber();

        // Determine status
        let status: "HEALTHY" | "WARNING" | "CRITICAL";
        if (reserveRatio >= this.HEALTHY_THRESHOLD) {
            status = "HEALTHY";
        } else if (reserveRatio >= this.WARNING_THRESHOLD) {
            status = "WARNING";
        } else {
            status = "CRITICAL";
        }

        return {
            currency: upperCurrency,
            userLiabilities,
            platformReserves,
            reserveRatio: Math.round(reserveRatio * 100) / 100, // 2 decimal places
            pendingWithdrawals,
            effectiveReserveRatio: Math.round(effectiveReserveRatio * 100) / 100,
            status,
        };
    }

    /**
     * Gets sum of all user balances from ledger (user liabilities)
     */
    private async getUserLiabilities(currency: string): Promise<Decimal> {
        const latestBalances = await this.prisma.$queryRaw<
            { total: Decimal }[]
        >`
            SELECT COALESCE(SUM(latest."balanceAfter"), 0) as total
            FROM (
                SELECT DISTINCT ON ("userId") "balanceAfter"
                FROM "LedgerEntries"
                WHERE currency = ${currency}
                  AND status != 'FAILED'
                  AND "userId" > 0
                ORDER BY "userId", "createdAt" DESC
            ) as latest
        `;

        return latestBalances[0]?.total ?? new Decimal(0);
    }

    /**
     * Gets platform reserves from blockchain (via Quidax)
     */
    private async getPlatformReserves(currency: string): Promise<Decimal> {
        try {
            const walletData = await this.quidaxService.getUserWallet({
                user_id: "me",
                currency: currency.toLowerCase(),
            });

            if (!walletData?.data) {
                this.logger.warn(`No wallet data for main account ${currency}`);
                return new Decimal(0);
            }

            return new Decimal(walletData.data.balance ?? 0);
        } catch (error) {
            this.logger.error(`Failed to get reserves for ${currency} | ${error.message}`);
            // Return 0 on error (worst case for solvency calculation)
            return new Decimal(0);
        }
    }

    /**
     * Gets pending withdrawals amount
     */
    private async getPendingWithdrawals(currency: string): Promise<Decimal> {
        // Count pending withdrawals (not yet processed or released)
        const result = await this.prisma.withdrawalQueue.aggregate({
            where: {
                currency,
                processedAt: null,
                releasedAt: null,
            },
            _sum: { amount: true },
        });

        return result._sum.amount ?? new Decimal(0);
    }

    /**
     * Get all active currencies from ledger
     */
    private async getActiveCurrencies(): Promise<string[]> {
        const currencies = await this.prisma.ledgerEntry.findMany({
            select: { currency: true },
            distinct: ["currency"],
            where: { userId: { gt: 0 } },
        });

        return currencies.map((c) => c.currency);
    }

    /**
     * Log solvency snapshot to database
     */
    private async logSolvencySnapshot(solvency: CurrencySolvency): Promise<void> {
        // Note: SolvencyLog model will be available after migration
        await (this.prisma as any).solvencyLog.create({
            data: {
                currency: solvency.currency,
                userLiabilities: solvency.userLiabilities,
                platformReserves: solvency.platformReserves,
                reserveRatio: new Decimal(solvency.reserveRatio),
                pendingWithdrawals: solvency.pendingWithdrawals,
                effectiveReserveRatio: new Decimal(solvency.effectiveReserveRatio),
                status: solvency.status,
            },
        });
    }

    /**
     * Send Slack alert for solvency issues
     */
    private async sendSolvencyAlert(solvency: CurrencySolvency): Promise<boolean> {
        const alertKey = `solvency:${solvency.currency}`;
        const lastAlert = this.lastAlertTimestamp.get(alertKey);

        // Check cooldown
        if (lastAlert && Date.now() - lastAlert.getTime() < this.ALERT_COOLDOWN_MS) {
            return false;
        }

        const emoji = solvency.status === "CRITICAL" ? "🚨" : "⚠️";
        const severity = solvency.status === "CRITICAL" ? "CRITICAL" : "WARNING";

        const messageText = [
            `${emoji} *SOLVENCY ${severity}: ${solvency.currency}*`,
            "",
            `• Reserve Ratio: *${solvency.reserveRatio.toFixed(2)}%*`,
            `• User Liabilities: ${solvency.userLiabilities.toString()} ${solvency.currency}`,
            `• Platform Reserves: ${solvency.platformReserves.toString()} ${solvency.currency}`,
            `• Pending Withdrawals: ${solvency.pendingWithdrawals.toString()} ${solvency.currency}`,
            `• Effective Ratio: ${solvency.effectiveReserveRatio.toFixed(2)}%`,
            "",
            solvency.status === "CRITICAL"
                ? "🚨 *IMMEDIATE ACTION REQUIRED* - Platform is severely undercollateralized!"
                : "⚠️ Review reserve levels and consider pausing withdrawals.",
        ].join("\n");

        try {
            await this.slackWebhookService.sendSystemAlert(
                "solvency",
                `SOLVENCY ${severity}: ${solvency.currency}`,
                messageText,
                {
                    currency: solvency.currency,
                    reserveRatio: solvency.reserveRatio,
                    userLiabilities: solvency.userLiabilities.toString(),
                    platformReserves: solvency.platformReserves.toString(),
                },
                solvency.status === "CRITICAL" ? "error" : "warning"
            );

            this.lastAlertTimestamp.set(alertKey, new Date());
            this.logger.warn(`Solvency alert sent for ${solvency.currency}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to send solvency alert: ${error.message}`);
            return false;
        }
    }

    /**
     * Send error alert when solvency check fails completely
     */
    private async sendErrorAlert(error: Error): Promise<void> {
        try {
            await this.slackWebhookService.sendSystemAlert(
                "solvency",
                "SOLVENCY CHECK FAILED",
                `Error: ${error.message}\n\nImmediate investigation required!`,
                { error: error.message },
                "error"
            );
        } catch (slackError) {
            this.logger.error(`Failed to send error alert: ${slackError.message}`);
        }
    }
}
