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
