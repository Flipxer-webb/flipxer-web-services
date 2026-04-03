import { Event } from "../../interfaces";
import { QuidaxWebhookEvent } from "../index";

describe("QuidaxWebhookEvent", () => {
    let service: { processWebhookEvent: jest.Mock };
    let eventBus: QuidaxWebhookEvent;

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
        const payload = { event: Event.OrderDone, data: { id: "ord-1" } };

        await eventBus.processor(payload as never);

        expect(service.processWebhookEvent).toHaveBeenCalledWith(payload);
    });

    it("processor should swallow errors and log them", async () => {
        const payload = { event: Event.DepositTransactionSuccessful, data: { id: "dep-1" } };
        service.processWebhookEvent.mockRejectedValue(new Error("processor failed"));

        await expect(eventBus.processor(payload as never)).resolves.toBeUndefined();
        expect((eventBus as any).logger.error).toHaveBeenCalled();
    });

    it("bound listener should trigger processor on process-webhook-event", async () => {
        const processorSpy = jest.spyOn(eventBus, "processor");
        const payload = { event: Event.WalletUpdatedEvent, data: { id: "wallet-1" } };

        eventBus.emit("process-webhook-event", payload as never);

        await new Promise((resolve) => setImmediate(resolve));
        expect(processorSpy).toHaveBeenCalledWith(payload);
    });
});
