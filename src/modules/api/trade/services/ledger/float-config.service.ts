import { Injectable, Logger } from "@nestjs/common";
import { FloatConfig } from "@prisma/client";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { Decimal } from "@prisma/client/runtime/library";

/**
 * Float status for a currency
 */
export interface FloatStatus {
    currency: string;
    currentFloat: Decimal;
    floatAllowance: Decimal;
    usagePercent: number;
    isOverThreshold: boolean;
    alertThreshold: number;
}

/**
 * FloatConfigService
 *
 * Manages per-currency float configuration for the omnibus wallet.
 * Float = sum of user balances - blockchain balance in main wallet
 *
 * Design decisions (from user requirements):
 * - Alerting only: Float threshold breaches trigger Slack alerts, but don't block deposits
 * - Always credit deposits: User gets credited immediately regardless of float
 * - Per-crypto float: Each currency has its own allowance/threshold
 * - USDT aggregate for reporting: Dashboard shows USDT-equivalent totals
 *
 * Float monitoring is critical for:
 * 1. Risk management: Know exposure before it becomes problematic
 * 2. Liquidity planning: Trigger top-ups before withdrawals queue
 * 3. Reconciliation: Early warning of discrepancies
 */
@Injectable()
export class FloatConfigService {
    private readonly logger = new Logger(FloatConfigService.name);

    // Default alert threshold (percentage)
    private readonly DEFAULT_ALERT_THRESHOLD = new Decimal(80);

    // Cache TTL for float configs (5 minutes)
    private readonly configCache: Map<
        string,
        { config: FloatConfig; cachedAt: number }
    > = new Map();
    private readonly CACHE_TTL_MS = 5 * 60 * 1000;

    constructor(
        private readonly prisma: PrismaService,
        private readonly slackWebhookService: SlackWebhookService
    ) {}

    /**
     * Gets float configuration for a currency
     * Creates default config if none exists
     *
     * @param currency Currency symbol
     * @returns Float configuration
     */
    async getConfig(currency: string): Promise<FloatConfig> {
        const upperCurrency = currency.toUpperCase();

        // Check cache
        const cached = this.configCache.get(upperCurrency);
        if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
            return cached.config;
        }

        // Fetch from database
        let config = await this.prisma.floatConfig.findUnique({
            where: { currency: upperCurrency },
        });

        // Create default if not exists
        if (!config) {
            config = await this.createDefaultConfig(upperCurrency);
        }

        // Update cache
        this.configCache.set(upperCurrency, { config, cachedAt: Date.now() });

        return config;
    }

    /**
     * Creates default float configuration for a new currency
     *
     * @param currency Currency symbol
     * @returns Created config
     */
    private async createDefaultConfig(currency: string): Promise<FloatConfig> {
        // Default allowances based on typical volumes
        const defaultAllowances: Record<string, Decimal> = {
            BTC: new Decimal(1),
            ETH: new Decimal(10),
            USDT: new Decimal(50000),
            USDC: new Decimal(50000),
            BNB: new Decimal(50),
            SOL: new Decimal(100),
            XRP: new Decimal(10000),
        };

        const floatAllowance = defaultAllowances[currency] ?? new Decimal(1000);

        const config = await this.prisma.floatConfig.create({
            data: {
                currency,
                floatAllowance,
                alertThreshold: this.DEFAULT_ALERT_THRESHOLD,
                isActive: true,
            },
        });

        this.logger.log(
            `Created default float config | ${JSON.stringify({
                currency,
                floatAllowance: floatAllowance.toString(),
                alertThreshold: this.DEFAULT_ALERT_THRESHOLD.toString(),
            })}`
        );

        return config;
    }

    /**
     * Updates float configuration for a currency
     *
     * @param currency Currency symbol
     * @param updates Updated values
     * @returns Updated config
     */
    async updateConfig(
        currency: string,
        updates: {
            floatAllowance?: Decimal | number;
            alertThreshold?: Decimal | number;
            isActive?: boolean;
        }
    ): Promise<FloatConfig> {
        const upperCurrency = currency.toUpperCase();

        const data: any = {};
        if (updates.floatAllowance !== undefined) {
            data.floatAllowance = new Decimal(
                updates.floatAllowance.toString()
            );
        }
        if (updates.alertThreshold !== undefined) {
            data.alertThreshold = new Decimal(
                updates.alertThreshold.toString()
            );
        }
        if (updates.isActive !== undefined) {
            data.isActive = updates.isActive;
        }

        const config = await this.prisma.floatConfig.upsert({
            where: { currency: upperCurrency },
            update: data,
            create: {
                currency: upperCurrency,
                floatAllowance: data.floatAllowance ?? new Decimal(1000),
                alertThreshold:
                    data.alertThreshold ?? this.DEFAULT_ALERT_THRESHOLD,
                isActive: data.isActive ?? true,
            },
        });

        // Invalidate cache
        this.configCache.delete(upperCurrency);

        this.logger.log(
            `Float config updated | ${JSON.stringify({
                currency: upperCurrency,
                updates,
            })}`
        );

        return config;
    }

    /**
     * Checks current float status and sends alerts if over threshold
     *
     * @param currency Currency symbol
     * @param currentFloat Current float amount
     * @returns Float status
     */
    async checkFloatStatus(
        currency: string,
        currentFloat: Decimal
    ): Promise<FloatStatus> {
        const config = await this.getConfig(currency);

        const usagePercent = config.floatAllowance.isZero()
            ? 100
            : currentFloat
                  .dividedBy(config.floatAllowance)
                  .times(100)
                  .toNumber();

        const isOverThreshold =
            usagePercent >= config.alertThreshold.toNumber();

        const status: FloatStatus = {
            currency: config.currency,
            currentFloat,
            floatAllowance: config.floatAllowance,
            usagePercent: Math.round(usagePercent * 100) / 100,
            isOverThreshold,
            alertThreshold: config.alertThreshold.toNumber(),
        };

        if (isOverThreshold && config.isActive) {
            await this.sendFloatAlert(status);
        }

        return status;
    }

    /**
     * Sends Slack alert for float threshold breach
     *
     * @param status Float status
     */
    private async sendFloatAlert(status: FloatStatus): Promise<void> {
        try {
            const messageText = [
                `🚨 *Float Alert: ${status.currency}*`,
                ``,
                `Current Float: ${status.currentFloat.toString()} ${
                    status.currency
                }`,
                `Float Allowance: ${status.floatAllowance.toString()} ${
                    status.currency
                }`,
                `Usage: ${status.usagePercent}% (threshold: ${status.alertThreshold}%)`,
                ``,
                `⚠️ Consider topping up the main wallet or reviewing recent deposits.`,
            ].join("\n");

            await this.slackWebhookService.sendAlert(
                "FLOAT_THRESHOLD",
                { text: messageText },
                { alertKey: `float:${status.currency}` }
            );

            this.logger.warn(`Float alert sent | ${JSON.stringify(status)}`);
        } catch (error) {
            this.logger.error(
                `Failed to send float alert | ${JSON.stringify({
                    currency: status.currency,
                    error: error.message,
                })}`
            );
        }
    }

    /**
     * Gets float status for all active currencies
     *
     * @returns Map of currency to float status
     */
    async getAllFloatConfigs(): Promise<FloatConfig[]> {
        return this.prisma.floatConfig.findMany({
            where: { isActive: true },
            orderBy: { currency: "asc" },
        });
    }

    /**
     * Calculates float for a currency given ledger total and blockchain balance
     *
     * @param currency Currency symbol
     * @param ledgerTotal Sum of all user balances in ledger
     * @param blockchainBalance Actual balance in main wallet
     * @returns Float amount (positive = users owed more than we have)
     */
    calculateFloat(ledgerTotal: Decimal, blockchainBalance: Decimal): Decimal {
        // Float = what we owe users - what we have
        // Positive float means we owe more than we have (users are "credited ahead")
        return ledgerTotal.minus(blockchainBalance);
    }

    /**
     * Clears the config cache (useful after bulk updates)
     */
    clearCache(): void {
        this.configCache.clear();
        this.logger.debug("Float config cache cleared");
    }
}
