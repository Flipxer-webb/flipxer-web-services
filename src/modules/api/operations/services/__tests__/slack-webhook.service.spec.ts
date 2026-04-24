jest.mock("axios", () => ({
    __esModule: true,
    default: {
        post: jest.fn(),
    },
}));

import Axios from "axios";

import { SlackWebhookService } from "../slack-webhook.service";

function buildSlackWebhookService() {
    const prisma = {
        slackWebhook: {
            create: jest.fn(),
            update: jest.fn(),
            delete: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
        },
        alertCooldown: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
    };

    const service = new SlackWebhookService(prisma as never);
    return { service, prisma };
}

describe("SlackWebhookService", () => {
    const axiosPost = Axios.post as jest.Mock;
    const originalWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    afterEach(() => {
        process.env.SLACK_WEBHOOK_URL = originalWebhookUrl;
    });

    it("creates, updates, deletes and fetches webhook records", async () => {
        const { service, prisma } = buildSlackWebhookService();

        prisma.slackWebhook.create.mockResolvedValue({ id: 1, name: "ops" });
        prisma.slackWebhook.update.mockResolvedValue({ id: 1, name: "ops-2" });
        prisma.slackWebhook.delete.mockResolvedValue({ id: 1 });
        prisma.slackWebhook.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
        prisma.slackWebhook.findUnique.mockResolvedValue({ id: 1 });

        await expect(
            service.createWebhook({
                name: "ops",
                webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX",
                channel: "ops",
                alertTypes: ["LOW_BALANCE"],
                isActive: true,
            }),
        ).resolves.toEqual({ id: 1, name: "ops" });

        await expect(service.updateWebhook(1, { channel: "ops-2" })).resolves.toEqual({
            id: 1,
            name: "ops-2",
        });
        await expect(service.deleteWebhook(1)).resolves.toEqual({ id: 1 });
        await expect(service.getWebhooks()).resolves.toHaveLength(2);
        await expect(service.getWebhookById(1)).resolves.toEqual({ id: 1 });
    });

    it("returns canAlert true when no cooldown exists", async () => {
        const { service, prisma } = buildSlackWebhookService();
        prisma.alertCooldown.findUnique.mockResolvedValue(null);

        await expect(service.checkCooldown("low_balance:btc")).resolves.toEqual({
            canAlert: true,
        });
    });

    it("returns cooldown remaining when cooldown is still active", async () => {
        const { service, prisma } = buildSlackWebhookService();
        const now = Date.now();
        prisma.alertCooldown.findUnique.mockResolvedValue({
            alertKey: "low_balance:btc",
            lastAlertedAt: new Date(now - (10 * 60 * 1000)),
            cooldownMinutes: 20,
        });

        const result = await service.checkCooldown("low_balance:btc");

        expect(result.canAlert).toBe(false);
        expect(result.cooldownRemainingMinutes).toBeGreaterThanOrEqual(9);
        expect(result.cooldownRemainingMinutes).toBeLessThanOrEqual(10);
    });

    it("sends alerts to subscribed webhooks and updates cooldown", async () => {
        const { service, prisma } = buildSlackWebhookService();

        prisma.alertCooldown.findUnique.mockResolvedValue(null);
        prisma.slackWebhook.findMany.mockResolvedValue([
            {
                id: 11,
                name: "ops-main",
                webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/MAINXXXX",
                isActive: true,
                alertTypes: ["LOW_BALANCE"],
            },
        ]);
        prisma.slackWebhook.update.mockResolvedValue({ id: 11 });
        prisma.alertCooldown.upsert.mockResolvedValue({});
        axiosPost.mockResolvedValue({ status: 200 });

        const result = await service.sendAlert(
            "LOW_BALANCE",
            { text: "low balance" },
            { respectCooldown: true, cooldownMinutes: 15, alertKey: "low_balance:btc" },
        );

        expect(result).toEqual({ sent: 1, skipped: 0, errors: [] });
        expect(axiosPost).toHaveBeenCalledWith(
            "https://hooks.slack.com/services/T00000000/B00000000/MAINXXXX",
            { text: "low balance" },
            expect.objectContaining({ timeout: 10000 }),
        );
        expect(prisma.alertCooldown.upsert).toHaveBeenCalledTimes(1);
    });

    it("tracks webhook failures and returns skipped count", async () => {
        const { service, prisma } = buildSlackWebhookService();

        prisma.alertCooldown.findUnique.mockResolvedValue(null);
        prisma.slackWebhook.findMany.mockResolvedValue([
            {
                id: 22,
                name: "ops-fail",
                webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/FAILXXXX",
                isActive: true,
                alertTypes: ["LOW_BALANCE"],
            },
        ]);
        prisma.slackWebhook.update.mockResolvedValue({ id: 22 });
        axiosPost.mockRejectedValue(new Error("webhook timeout"));

        const result = await service.sendAlert(
            "LOW_BALANCE",
            { text: "low balance" },
            { respectCooldown: false },
        );

        expect(result.sent).toBe(0);
        expect(result.skipped).toBe(1);
        expect(result.errors).toEqual(["ops-fail: webhook timeout"]);
        expect(prisma.slackWebhook.update).toHaveBeenCalledWith({
            where: { id: 22 },
            data: { failureCount: { increment: 1 } },
        });
    });

    it("skips webhook-failure alert when SLACK_WEBHOOK_URL is not configured", async () => {
        const { service } = buildSlackWebhookService();
        delete process.env.SLACK_WEBHOOK_URL;

        await expect(
            service.sendWebhookFailureAlert("quidax", "ref-1", "processing failed"),
        ).resolves.toEqual({
            sent: false,
            error: "SLACK_WEBHOOK_URL not configured",
        });

        expect(axiosPost).not.toHaveBeenCalled();
    });

    it("sends webhook-failure alert when SLACK_WEBHOOK_URL is configured", async () => {
        const { service } = buildSlackWebhookService();
        process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T00000000/B00000000/SYSTEMXX";
        axiosPost.mockResolvedValue({ status: 200 });

        await expect(
            service.sendWebhookFailureAlert("nomba", "ref-2", "signature invalid", {
                receivedAmount: 50000,
                senderAccountName: "Test Sender",
            }),
        ).resolves.toEqual({ sent: true });

        expect(axiosPost).toHaveBeenCalledTimes(1);
        expect(axiosPost).toHaveBeenCalledWith(
            "https://hooks.slack.com/services/T00000000/B00000000/SYSTEMXX",
            expect.objectContaining({
                blocks: expect.arrayContaining([
                    expect.objectContaining({
                        text: expect.objectContaining({
                            text: expect.stringContaining("Received Amount"),
                        }),
                    }),
                ]),
            }),
            expect.any(Object),
        );
    });

    it("returns not-found error when testing an unknown webhook", async () => {
        const { service, prisma } = buildSlackWebhookService();
        prisma.slackWebhook.findUnique.mockResolvedValue(null);

        await expect(service.testWebhook(404)).resolves.toEqual({
            success: false,
            error: "Webhook not found",
        });
    });

    it("sends a test webhook and system alert payloads", async () => {
        const { service, prisma } = buildSlackWebhookService();
        process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T00000000/B00000000/SYSTEMXX";

        prisma.slackWebhook.findUnique.mockResolvedValue({
            id: 3,
            name: "ops-test",
            webhookUrl: "https://hooks.slack.com/services/T00000000/B00000000/TESTXXXX",
        });
        axiosPost.mockResolvedValue({ status: 200 });

        await expect(service.testWebhook(3)).resolves.toEqual({ success: true });
        await expect(
            service.sendSystemAlert("withdrawal", "Queue Delay", "Orders pending", { pending: 4 }, "warning"),
        ).resolves.toEqual({ sent: true });

        expect(axiosPost).toHaveBeenCalledTimes(2);
    });

    it("rejects non-Slack webhook URLs to prevent SSRF", async () => {
        const { service } = buildSlackWebhookService();

        await expect(
            service.createWebhook({
                name: "malicious",
                webhookUrl: "https://169.254.169.254/latest/meta-data",
                alertTypes: ["LOW_BALANCE"],
            }),
        ).rejects.toThrow("Only valid Slack incoming webhook URLs are allowed");
    });
});