jest.mock("@/config", () => ({
    mailConfig: { senderMail: "noreply@example.com" },
    emailTemplateConfig: { transaction_notification: "transaction-template" },
    COMPANY_NAME: "Flipxer",
}));

import { NotificationEvent } from "../notification.event";

describe("NotificationEvent", () => {
    const payload = {
        email: "user@example.com",
        notice: "Your order completed",
        transactionType: "deposit",
        transactionId: "TX-1",
        amount: "100",
        currency: "BTC",
        status: "completed",
        date: "2026-03-29",
    } as any;

    it("sends templated transaction notification", async () => {
        const emailService = {
            sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
        };

        const event = new NotificationEvent(emailService as any);
        await event.sendTransactionNotification(payload);

        expect(emailService.sendMailWithTemplate).toHaveBeenCalledWith(
            expect.objectContaining({
                template_key: "transaction-template",
                merge_info: expect.objectContaining({
                    header: "Deposit Received",
                    transaction_id: "TX-1",
                }),
            })
        );
    });

    it("handles send failures without throwing", async () => {
        const emailService = {
            sendMailWithTemplate: jest.fn().mockRejectedValue(new Error("mail down")),
        };

        const event = new NotificationEvent(emailService as any);
        const loggerSpy = jest.spyOn((event as any).logger, "log").mockImplementation();

        await expect(event.sendTransactionNotification(payload)).resolves.toBeUndefined();
        expect(loggerSpy).toHaveBeenCalled();

        loggerSpy.mockRestore();
    });

    it("emits and listens to typed event names", async () => {
        const emailService = {
            sendMailWithTemplate: jest.fn().mockResolvedValue(undefined),
        };

        const event = new NotificationEvent(emailService as any);
        const listener = jest.fn();

        event.on("transaction_notification", listener as any);
        event.emit("transaction_notification", payload);

        await new Promise((resolve) => setImmediate(resolve));
        expect(listener).toHaveBeenCalledWith(payload);
    });
});
