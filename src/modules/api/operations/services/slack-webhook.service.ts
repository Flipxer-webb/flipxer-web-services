import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import Axios from "axios";
import {
    SlackMessage,
    CreateSlackWebhookDto,
    UpdateSlackWebhookDto,
    AlertCooldownCheck,
} from "../types";

@Injectable()
export class SlackWebhookService {
    private readonly logger = new Logger(SlackWebhookService.name);

    constructor(private readonly prisma: PrismaService) { }

    /**
     * Create a new Slack webhook configuration
     */
    async createWebhook(dto: CreateSlackWebhookDto) {
        return this.prisma.slackWebhook.create({
            data: {
                name: dto.name,
                webhookUrl: dto.webhookUrl,
                channel: dto.channel,
                alertTypes: dto.alertTypes,
                isActive: dto.isActive ?? true,
            },
        });
    }

    /**
     * Update an existing Slack webhook
     */
    async updateWebhook(id: number, dto: UpdateSlackWebhookDto) {
        return this.prisma.slackWebhook.update({
            where: { id },
            data: dto,
        });
    }

    /**
     * Delete a Slack webhook
     */
    async deleteWebhook(id: number) {
        return this.prisma.slackWebhook.delete({
            where: { id },
        });
    }

    /**
     * Get all Slack webhooks
     */
    async getWebhooks() {
        return this.prisma.slackWebhook.findMany({
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * Get webhook by ID
     */
    async getWebhookById(id: number) {
        return this.prisma.slackWebhook.findUnique({
            where: { id },
        });
    }

    /**
     * Check if an alert can be sent based on cooldown
     */
    async checkCooldown(alertKey: string): Promise<AlertCooldownCheck> {
        const cooldown = await this.prisma.alertCooldown.findUnique({
            where: { alertKey },
        });

        if (!cooldown) {
            return { canAlert: true };
        }

        const now = new Date();
        const cooldownEnd = new Date(
            cooldown.lastAlertedAt.getTime() + cooldown.cooldownMinutes * 60 * 1000
        );

        if (now >= cooldownEnd) {
            return { canAlert: true, lastAlertedAt: cooldown.lastAlertedAt };
        }

        const remainingMs = cooldownEnd.getTime() - now.getTime();
        const remainingMinutes = Math.ceil(remainingMs / 60000);

        return {
            canAlert: false,
            lastAlertedAt: cooldown.lastAlertedAt,
            cooldownRemainingMinutes: remainingMinutes,
        };
    }

    /**
     * Update cooldown after sending an alert
     */
    async updateCooldown(alertKey: string, cooldownMinutes: number = 60): Promise<void> {
        await this.prisma.alertCooldown.upsert({
            where: { alertKey },
            update: {
                lastAlertedAt: new Date(),
                cooldownMinutes,
            },
            create: {
                alertKey,
                lastAlertedAt: new Date(),
                cooldownMinutes,
            },
        });
    }

    /**
     * Send an alert to all webhooks subscribed to the alert type
     */
    async sendAlert(
        alertType: string,
        message: SlackMessage,
        options: { respectCooldown?: boolean; cooldownMinutes?: number; alertKey?: string } = {}
    ): Promise<{ sent: number; skipped: number; errors: string[] }> {
        const {
            respectCooldown = true,
            cooldownMinutes = 60,
            alertKey = alertType,
        } = options;

        // Check cooldown if enabled
        if (respectCooldown) {
            const cooldownCheck = await this.checkCooldown(alertKey);
            if (!cooldownCheck.canAlert) {
                this.logger.debug(
                    `Alert ${alertKey} skipped due to cooldown (${cooldownCheck.cooldownRemainingMinutes} min remaining)`
                );
                return { sent: 0, skipped: 1, errors: [] };
            }
        }

        // Get all active webhooks subscribed to this alert type
        const webhooks = await this.prisma.slackWebhook.findMany({
            where: {
                isActive: true,
                alertTypes: { has: alertType },
            },
        });

        if (webhooks.length === 0) {
            this.logger.debug(`No active webhooks for alert type: ${alertType}`);
            return { sent: 0, skipped: 0, errors: [] };
        }

        let sent = 0;
        let skipped = 0;
        const errors: string[] = [];

        // Send to all subscribed webhooks
        for (const webhook of webhooks) {
            try {
                await this.sendToWebhook(webhook.webhookUrl, message);

                // Update webhook last triggered
                await this.prisma.slackWebhook.update({
                    where: { id: webhook.id },
                    data: { lastTriggered: new Date(), failureCount: 0 },
                });

                sent++;
                this.logger.log(`Alert sent to webhook: ${webhook.name}`);
            } catch (error) {
                // Increment failure count
                await this.prisma.slackWebhook.update({
                    where: { id: webhook.id },
                    data: { failureCount: { increment: 1 } },
                });

                errors.push(`${webhook.name}: ${error.message}`);
                skipped++;
                this.logger.error(`Failed to send to webhook ${webhook.name}: ${error.message}`);
            }
        }

        // Update cooldown if at least one was sent
        if (sent > 0 && respectCooldown) {
            await this.updateCooldown(alertKey, cooldownMinutes);
        }

        return { sent, skipped, errors };
    }

    /**
     * Send message to a specific Slack webhook URL
     */
    private async sendToWebhook(webhookUrl: string, message: SlackMessage): Promise<void> {
        await Axios.post(webhookUrl, message, {
            headers: { "Content-Type": "application/json" },
            timeout: 10000,
        });
    }

    /**
     * Send a low balance alert
     */
    async sendLowBalanceAlert(
        currency: string,
        currentBalance: string,
        threshold: number
    ): Promise<{ sent: number; skipped: number; errors: string[] }> {
        const alertKey = `low_balance:${currency.toLowerCase()}`;

        const message: SlackMessage = {
            text: `⚠️ Low Balance Alert: ${currency.toUpperCase()}`,
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "⚠️ Low Balance Alert",
                        emoji: true,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Currency:* ${currency.toUpperCase()}\n*Current Balance:* ${currentBalance}\n*Threshold:* ${threshold}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `_Action Required: Please review and replenish the ${currency.toUpperCase()} wallet._`,
                    },
                },
            ],
        };

        return this.sendAlert("LOW_BALANCE", message, { alertKey });
    }

    /**
     * Send unusual activity alert
     */
    async sendUnusualActivityAlert(
        description: string,
        details: Record<string, any>
    ): Promise<{ sent: number; skipped: number; errors: string[] }> {
        const message: SlackMessage = {
            text: `🚨 Unusual Activity Detected`,
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "🚨 Unusual Activity Detected",
                        emoji: true,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Description:* ${description}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Details:*\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``,
                    },
                },
            ],
        };

        return this.sendAlert("UNUSUAL_ACTIVITY", message, {
            alertKey: "unusual_activity",
            cooldownMinutes: 30, // Shorter cooldown for unusual activity
        });
    }
    /**
     * Send webhook failure alert for payment processing errors
     * Uses SLACK_WEBHOOK_URL environment variable directly for simplicity
     */
    async sendWebhookFailureAlert(
        provider: 'fincra' | 'quidax',
        reference: string,
        error: string,
        details: Record<string, any> = {}
    ): Promise<{ sent: boolean; error?: string }> {
        const webhookUrl = process.env.SLACK_WEBHOOK_URL;

        if (!webhookUrl) {
            this.logger.debug('SLACK_WEBHOOK_URL not configured, skipping alert');
            return { sent: false, error: 'SLACK_WEBHOOK_URL not configured' };
        }

        const message: SlackMessage = {
            text: `🔴 ${provider.toUpperCase()} Webhook Failed`,
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: `🔴 ${provider.toUpperCase()} Webhook Processing Failed`,
                        emoji: true,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Provider:* ${provider.toUpperCase()}\n*Reference:* ${reference}\n*Error:* ${error}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Time:* ${new Date().toISOString()}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `_⚠️ Action Required: Check the order and manually process if payment was confirmed._`,
                    },
                },
            ],
        };

        try {
            await this.sendToWebhook(webhookUrl, message);
            this.logger.log(`Webhook failure alert sent for ${provider}:${reference}`);
            return { sent: true };
        } catch (err) {
            this.logger.error(`Failed to send Slack alert: ${err.message}`);
            return { sent: false, error: err.message };
        }
    }

    /**
     * Test a webhook by sending a test message
     */
    async testWebhook(id: number): Promise<{ success: boolean; error?: string }> {
        const webhook = await this.prisma.slackWebhook.findUnique({
            where: { id },
        });

        if (!webhook) {
            return { success: false, error: "Webhook not found" };
        }

        const testMessage: SlackMessage = {
            text: "🧪 Test message from Flipxer Admin",
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: "🧪 Test Message",
                        emoji: true,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `This is a test message from *Flipxer Admin*.\n\nWebhook: *${webhook.name}*\nTimestamp: ${new Date().toISOString()}`,
                    },
                },
            ],
        };

        try {
            await this.sendToWebhook(webhook.webhookUrl, testMessage);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    /**
     * Send a generic system alert
     * Used for withdrawal queue, reconciliation, and other system alerts
     */
    async sendSystemAlert(
        category: string,
        title: string,
        message: string,
        details: Record<string, any> = {},
        severity: 'info' | 'warning' | 'error' = 'warning'
    ): Promise<{ sent: boolean; error?: string }> {
        const webhookUrl = process.env.SLACK_WEBHOOK_URL;

        if (!webhookUrl) {
            this.logger.debug('SLACK_WEBHOOK_URL not configured, skipping alert');
            return { sent: false, error: 'SLACK_WEBHOOK_URL not configured' };
        }

        const emoji = severity === 'error' ? '🔴' : severity === 'warning' ? '🟡' : 'ℹ️';

        const slackMessage: SlackMessage = {
            text: `${emoji} [${category.toUpperCase()}] ${title}`,
            blocks: [
                {
                    type: "header",
                    text: {
                        type: "plain_text",
                        text: `${emoji} ${title}`,
                        emoji: true,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Category:* ${category}\n*Message:* ${message}`,
                    },
                },
                {
                    type: "section",
                    text: {
                        type: "mrkdwn",
                        text: `*Details:*\n\`\`\`${JSON.stringify(details, null, 2)}\`\`\``,
                    },
                },
                {
                    type: "context",
                    elements: [
                        {
                            type: "mrkdwn",
                            text: `🕐 ${new Date().toISOString()}`,
                        },
                    ],
                },
            ],
        };

        try {
            await this.sendToWebhook(webhookUrl, slackMessage);
            this.logger.log(`System alert sent: ${category} - ${title}`);
            return { sent: true };
        } catch (error) {
            this.logger.error(`Failed to send system alert: ${error.message}`);
            return { sent: false, error: error.message };
        }
    }
}

