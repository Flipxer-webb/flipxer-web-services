const RedisMock = jest.fn();

jest.mock("ioredis", () => ({
    __esModule: true,
    default: RedisMock,
}));

jest.mock("@/config", () => ({
    redisConfig: {
        host: "127.0.0.1",
        port: 6379,
        user: "default",
        password: "secret",
        redisOptions: {},
    },
}));

import { RateLimiterService } from "../rate-limiter.service";

describe("RateLimiterService redis initialization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("initializes redis client and toggles connect/error state handlers", async () => {
        const handlers: Record<string, (arg?: unknown) => void> = {};
        const client = {
            on: jest.fn((event: string, cb: (arg?: unknown) => void) => {
                handlers[event] = cb;
                return client;
            }),
            quit: jest.fn().mockResolvedValue("OK"),
        };
        RedisMock.mockImplementation(() => client);

        const service = new RateLimiterService({
            limit: 10,
            windowSeconds: 60,
            useRedis: true,
            keyPrefix: "rl:",
        } as never);

        await service.onModuleInit();

        expect(RedisMock).toHaveBeenCalled();
        expect(client.on).toHaveBeenCalledWith("connect", expect.any(Function));
        expect(client.on).toHaveBeenCalledWith("error", expect.any(Function));

        handlers.connect();
        expect((service as any).isRedisConnected).toBe(true);

        handlers.error(new Error("redis failed"));
        expect((service as any).isRedisConnected).toBe(false);

        await service.onModuleDestroy();
        expect(client.quit).toHaveBeenCalledTimes(1);
    });

    it("swallows redis constructor failure and logs warning", async () => {
        RedisMock.mockImplementation(() => {
            throw new Error("cannot connect");
        });

        const service = new RateLimiterService({
            limit: 10,
            windowSeconds: 60,
            useRedis: true,
            keyPrefix: "rl:",
        } as never);

        const warnSpy = jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);

        await expect(service.onModuleInit()).resolves.toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
    });
});