import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "./slack-webhook.service";
import { WalletManagementService } from "./wallet-management.service";
import { 
    CreateLiquidityAlertDto, 
    ResolveLiquidityAlertDto, 
    LiquidityAlertFilters 
} from "../types";
import { LiquidityAlertStatus, LiquidityAlertType, Prisma } from "@prisma/client";

@Injectable()
export class LiquidityAlertService {
    private readonly logger = new Logger(LiquidityAlertService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly slackService: SlackWebhookService,
        private readonly walletService: WalletManagementService,
    ) {}

    /**
     * Create a new liquidity alert
     */
    async createAlert(dto: CreateLiquidityAlertDto) {
        const alert = await this.prisma.liquidityAlert.create({
            data: {
                currency: dto.currency.toUpperCase(),
                alertType: dto.alertType as LiquidityAlertType,
                threshold: dto.threshold,
                currentValue: dto.currentValue,
                status: "PENDING",
            },
        });

        // Send Slack notification
        await this.slackService.sendAlert(
            dto.alertType,
            {
                text: `⚠️ Liquidity Alert: ${dto.currency.toUpperCase()}`,
                blocks: [
                    {
                        type: "header",
                        text: {
                            type: "plain_text",
                            text: `⚠️ ${this.formatAlertType(dto.alertType)} Alert`,
                            emoji: true,
                        },
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Currency:* ${dto.currency.toUpperCase()}\n*Alert Type:* ${this.formatAlertType(dto.alertType)}\n*Threshold:* ${dto.threshold}\n*Current Value:* ${dto.currentValue || "N/A"}`,
                        },
                    },
                ],
            },
            {
                alertKey: `${dto.alertType.toLowerCase()}:${dto.currency.toLowerCase()}`,
            }
        );

        this.logger.log(`Created liquidity alert: ${dto.alertType} for ${dto.currency}`);
        return alert;
    }

    /**
     * Get alerts with filtering and pagination
     */
    async getAlerts(filters: LiquidityAlertFilters) {
        const {
            status,
            currency,
            alertType,
            startDate,
            endDate,
            page = 1,
            limit = 20,
        } = filters;

        const where: Prisma.LiquidityAlertWhereInput = {};

        if (status) {
            where.status = status as LiquidityAlertStatus;
        }

        if (currency) {
            where.currency = currency.toUpperCase();
        }

        if (alertType) {
            where.alertType = alertType as LiquidityAlertType;
        }

        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = startDate;
            if (endDate) where.createdAt.lte = endDate;
        }

        const [alerts, total] = await Promise.all([
            this.prisma.liquidityAlert.findMany({
                where,
                orderBy: { createdAt: "desc" },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.liquidityAlert.count({ where }),
        ]);

        return {
            data: alerts,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
    }

    /**
     * Get pending alerts count by type
     */
    async getPendingAlertsSummary() {
        const summary = await this.prisma.liquidityAlert.groupBy({
            by: ["alertType", "status"],
            _count: true,
            where: {
                status: { in: ["PENDING", "ESCALATED"] },
            },
        });

        return summary.reduce((acc, item) => {
            const key = item.alertType;
            if (!acc[key]) acc[key] = { pending: 0, escalated: 0 };
            if (item.status === "PENDING") acc[key].pending = item._count;
            if (item.status === "ESCALATED") acc[key].escalated = item._count;
            return acc;
        }, {} as Record<string, { pending: number; escalated: number }>);
    }

    /**
     * Acknowledge an alert
     */
    async acknowledgeAlert(id: number, adminId: number) {
        return this.prisma.liquidityAlert.update({
            where: { id },
            data: {
                status: "ACKNOWLEDGED",
            },
        });
    }

    /**
     * Resolve an alert
     */
    async resolveAlert(id: number, adminId: number, dto: ResolveLiquidityAlertDto) {
        return this.prisma.liquidityAlert.update({
            where: { id },
            data: {
                status: "RESOLVED",
                resolvedBy: adminId,
                resolvedAt: new Date(),
                resolvedNote: dto.note,
            },
        });
    }

    /**
     * Escalate an alert
     */
    async escalateAlert(id: number) {
        const alert = await this.prisma.liquidityAlert.update({
            where: { id },
            data: { status: "ESCALATED" },
        });

        // Send escalation notification
        await this.slackService.sendAlert(
            "ESCALATED",
            {
                text: `🚨 ESCALATED: ${alert.alertType} Alert for ${alert.currency}`,
                blocks: [
                    {
                        type: "header",
                        text: {
                            type: "plain_text",
                            text: "🚨 ESCALATED ALERT",
                            emoji: true,
                        },
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `*Currency:* ${alert.currency}\n*Alert Type:* ${this.formatAlertType(alert.alertType)}\n*Threshold:* ${alert.threshold}\n*Status:* ESCALATED`,
                        },
                    },
                    {
                        type: "section",
                        text: {
                            type: "mrkdwn",
                            text: `_This alert has been escalated and requires immediate attention._`,
                        },
                    },
                ],
            },
            { respectCooldown: false } // Don't respect cooldown for escalations
        );

        return alert;
    }

    /**
     * Run automated liquidity check and create alerts as needed
     */
    async runLiquidityCheck(): Promise<{ newAlerts: number; existingAlerts: number }> {
        this.logger.log("Running automated liquidity check...");

        const { breaches } = await this.walletService.checkLiquidityThresholds();

        let newAlerts = 0;
        let existingAlerts = 0;

        for (const breach of breaches) {
            // Check if there's already a pending/escalated alert for this currency
            const existingAlert = await this.prisma.liquidityAlert.findFirst({
                where: {
                    currency: breach.wallet.currency.toUpperCase(),
                    alertType: breach.breachType === "low" ? "LOW_BALANCE" : "HIGH_BALANCE",
                    status: { in: ["PENDING", "ESCALATED"] },
                },
            });

            if (existingAlert) {
                existingAlerts++;
                continue;
            }

            // Create new alert
            await this.createAlert({
                currency: breach.wallet.currency,
                alertType: breach.breachType === "low" ? "LOW_BALANCE" : "HIGH_BALANCE",
                threshold: breach.breachType === "low" 
                    ? breach.threshold.minBalance 
                    : breach.threshold.maxBalance,
                currentValue: parseFloat(breach.wallet.availableBalance),
            });

            newAlerts++;
        }

        this.logger.log(`Liquidity check complete: ${newAlerts} new alerts, ${existingAlerts} existing`);
        return { newAlerts, existingAlerts };
    }

    /**
     * Get alert statistics
     */
    async getAlertStatistics(days: number = 30) {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const [totalAlerts, byStatus, byCurrency, byType] = await Promise.all([
            this.prisma.liquidityAlert.count({
                where: { createdAt: { gte: startDate } },
            }),
            this.prisma.liquidityAlert.groupBy({
                by: ["status"],
                _count: true,
                where: { createdAt: { gte: startDate } },
            }),
            this.prisma.liquidityAlert.groupBy({
                by: ["currency"],
                _count: true,
                where: { createdAt: { gte: startDate } },
                orderBy: { _count: { currency: "desc" } },
                take: 5,
            }),
            this.prisma.liquidityAlert.groupBy({
                by: ["alertType"],
                _count: true,
                where: { createdAt: { gte: startDate } },
            }),
        ]);

        return {
            totalAlerts,
            byStatus: byStatus.reduce((acc, item) => {
                acc[item.status] = item._count;
                return acc;
            }, {} as Record<string, number>),
            byCurrency: byCurrency.map(item => ({
                currency: item.currency,
                count: item._count,
            })),
            byType: byType.reduce((acc, item) => {
                acc[item.alertType] = item._count;
                return acc;
            }, {} as Record<string, number>),
        };
    }

    private formatAlertType(type: string): string {
        return type
            .split("_")
            .map(word => word.charAt(0) + word.slice(1).toLowerCase())
            .join(" ");
    }
}
