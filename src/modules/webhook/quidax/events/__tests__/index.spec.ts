jest.mock("../../services", () => ({
    QuidaxWebhookService: jest.fn(),
    __esModule: true,
}));

import { QuidaxWebhookEvent } from "../index";

describe("QuidaxWebhookEvent", () => {
    let service: { processWebhookEvent: jest.Mock };
    let eventBus: any;

    const orderDonePayload = { event: "order.done", data: { id: "ord-1" } };
    const depositPayload = {
        event: "deposit.transaction.successful",
        data: { id: "dep-1" },
    };
    const walletPayload = { event: "wallet.updated", data: { id: "wallet-1" } };

    beforeEach(() => {
        service = {
            processWebhookEvent: jest.fn(),
        };

        eventBus = new QuidaxWebhookEvent(service as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("processor should call webhook service", async () => {
        await eventBus.processor(orderDonePayload as any);

        expect(service.processWebhookEvent).toHaveBeenCalledWith(orderDonePayload);
    });

    it("processor should swallow errors and log them", async () => {
        service.processWebhookEvent.mockRejectedValue(new Error("processor failed"));

        await expect(eventBus.processor(depositPayload as any)).resolves.toBeUndefined();
        expect(service.processWebhookEvent).toHaveBeenCalledWith(depositPayload);
    });

    it("bound listener should trigger processor on process-webhook-event", async () => {
        eventBus.emit("process-webhook-event", walletPayload as any);

        await new Promise((resolve) => setImmediate(resolve));
        expect(service.processWebhookEvent).toHaveBeenCalledWith(walletPayload);
    });
});
