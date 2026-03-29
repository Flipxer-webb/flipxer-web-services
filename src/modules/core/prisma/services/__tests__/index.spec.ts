import { PrismaService } from "../index";

describe("PrismaService", () => {
    let service: PrismaService;

    beforeEach(() => {
        jest.clearAllMocks();
        service = new PrismaService();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("connects on module init and registers listeners", async () => {
        process.env.NODE_ENV = "test";

        const connectMock = jest.fn().mockResolvedValue(undefined);
        const onMock = jest.fn();

        (service as any).$connect = connectMock;
        (service as any).$on = onMock;

        await service.onModuleInit();

        expect(connectMock).toHaveBeenCalled();
        expect(onMock).toHaveBeenCalledWith("query", expect.any(Function));
        expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
        expect(service.getPoolStats().isConnected).toBe(true);
    });

    it("does not register query listener in production", async () => {
        process.env.NODE_ENV = "production";

        (service as any).$connect = jest.fn().mockResolvedValue(undefined);
        const onMock = jest.fn();
        (service as any).$on = onMock;

        await service.onModuleInit();

        expect(onMock.mock.calls.some(([event]) => event === "query")).toBe(false);
        expect(onMock.mock.calls.some(([event]) => event === "error")).toBe(true);
    });

    it("retries failed connections and eventually succeeds", async () => {
        const connectMock = jest
            .fn()
            .mockRejectedValueOnce(new Error("db down"))
            .mockResolvedValueOnce(undefined);

        const setTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((cb: (...args: unknown[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        (service as any).$connect = connectMock;
        (service as any).$on = jest.fn();

        await service.onModuleInit();

        expect(connectMock).toHaveBeenCalledTimes(2);
        expect(setTimeoutSpy).toHaveBeenCalled();
    });

    it("throws after max retries", async () => {
        const setTimeoutSpy = jest
            .spyOn(globalThis, "setTimeout")
            .mockImplementation(((cb: (...args: unknown[]) => void) => {
                cb();
                return 0 as any;
            }) as any);

        const connectMock = jest.fn().mockRejectedValue(new Error("always failing"));

        (service as any).$connect = connectMock;
        (service as any).$on = jest.fn();

        await expect(service.onModuleInit()).rejects.toThrow(
            "Failed to connect to database after 5 attempts"
        );
        expect(connectMock).toHaveBeenCalledTimes(5);
        expect(setTimeoutSpy).toHaveBeenCalled();
    });

    it("disconnects on module destroy", async () => {
        (service as any).$disconnect = jest.fn().mockResolvedValue(undefined);
        await service.onModuleDestroy();
        expect((service as any).$disconnect).toHaveBeenCalled();
        expect(service.getPoolStats().isConnected).toBe(false);
    });

    it("registers shutdown hook and closes app", async () => {
        const app = {
            close: jest.fn().mockResolvedValue(undefined),
        };

        let beforeExitHandler: (() => Promise<void>) | undefined;

        (service as any).$on = jest.fn((event: string, handler: () => Promise<void>) => {
            if (event === "beforeExit") {
                beforeExitHandler = handler;
            }
        });

        await service.enableShutdownHooks(app as any);
        expect(beforeExitHandler).toBeDefined();

        await beforeExitHandler?.();
        expect(app.close).toHaveBeenCalled();
    });

    it("reports health status", async () => {
        (service as any).$queryRaw = jest.fn().mockResolvedValue([{ ok: 1 }]);
        await expect(service.isHealthy()).resolves.toBe(true);

        (service as any).$queryRaw = jest.fn().mockRejectedValue(new Error("no"));
        await expect(service.isHealthy()).resolves.toBe(false);
    });

    it("logs slow query and prisma errors via registered listeners", async () => {
        process.env.NODE_ENV = "test";

        const listeners: Record<string, (event: any) => void> = {};
        (service as any).$connect = jest.fn().mockResolvedValue(undefined);
        (service as any).$on = jest.fn((event: string, handler: (payload: any) => void) => {
            listeners[event] = handler;
        });

        const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
        const errorSpy = jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

        await service.onModuleInit();

        listeners.query?.({ duration: 1501, query: "SELECT 1" });
        listeners.error?.({ message: "db event" });

        expect(warnSpy).toHaveBeenCalledWith("Slow query (1501ms): SELECT 1");
        expect(errorSpy).toHaveBeenCalledWith("Prisma error: db event");
    });

    it("executes transactions with defaults and overrides", async () => {
        const callback = jest.fn().mockResolvedValue("done");

        (service as any).$transaction = jest.fn().mockResolvedValue("done");

        await expect(service.executeTransaction(callback as any)).resolves.toBe("done");
        expect((service as any).$transaction).toHaveBeenLastCalledWith(callback, {
            maxWait: 5000,
            timeout: 10000,
            isolationLevel: undefined,
        });

        await service.executeTransaction(callback as any, {
            maxWait: 100,
            timeout: 200,
            isolationLevel: "Serializable" as any,
        });

        expect((service as any).$transaction).toHaveBeenLastCalledWith(callback, {
            maxWait: 100,
            timeout: 200,
            isolationLevel: "Serializable",
        });
    });
});