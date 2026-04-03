jest.mock("../../services", () => ({
    TradingService: class TradingService {},
    __esModule: true,
}));

import { TradingEvent } from "../index";

describe("TradingEvent", () => {
    it("resolves the forwardRef dependency token metadata", () => {
        const deps = Reflect.getMetadata("self:paramtypes", TradingEvent) as Array<
            { index: number; param: { forwardRef?: () => unknown } }
        >;

        expect(Array.isArray(deps)).toBe(true);
        expect(typeof deps[0]?.param?.forwardRef).toBe("function");
        expect(deps[0].param.forwardRef?.()).toBeDefined();
    });

    it("subscribes and emits typed events", () => {
        const tradingService = {} as never;
        const eventBus = new TradingEvent(tradingService);

        const listener = jest.fn();
        const payload = { userId: 10, amount: 2500 } as any;

        const onReturn = eventBus.on("notification" as any, listener);
        const emitReturn = eventBus.emit("notification" as any, payload);

        expect(onReturn).toBe(eventBus);
        expect(emitReturn).toBe(true);
        expect(listener).toHaveBeenCalledWith(payload);
    });

    it("returns false when emitting events without listeners", () => {
        const eventBus = new TradingEvent({} as never);

        const emitted = eventBus.emit("missing-event" as any, { id: 1 } as any);

        expect(emitted).toBe(false);
    });
});
