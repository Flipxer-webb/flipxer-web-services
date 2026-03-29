jest.mock("../../services", () => ({
    QuidaxWebhookService: jest.fn(),
    __esModule: true,
}));

import { QuidaxWebhookEvent } from "../index";

describe("QuidaxWebhookEvent", () => {
    let service: { processWebhookEvent: jest.Mock };
    let eventBus: QuidaxWebhookEvent;

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

        eventBus = new QuidaxWebhookEvent(service as never);
        jest.spyOn((eventBus as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((eventBus as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("processor should call webhook service", async () => {
        await eventBus.processor(orderDonePayload as never);

        expect(service.processWebhookEvent).toHaveBeenCalledWith(orderDonePayload);
    });

    it("processor should swallow errors and log them", async () => {
        service.processWebhookEvent.mockRejectedValue(new Error("processor failed"));

        await expect(eventBus.processor(depositPayload as never)).resolves.toBeUndefined();
        expect((eventBus as any).logger.error).toHaveBeenCalled();
    });

    it("bound listener should trigger processor on process-webhook-event", async () => {
        const listeners = eventBus.listeners("process-webhook-event");
        expect(listeners).toHaveLength(1);

        await (listeners[0] as (payload: typeof walletPayload) => Promise<void>)(walletPayload);
        expect(service.processWebhookEvent).toHaveBeenCalledWith(walletPayload);
    });
});
