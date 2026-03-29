import { MODULE_METADATA } from "@nestjs/common/constants";

describe("AppModule", () => {
    it("registers module imports and root module factories", async () => {
        jest.resetModules();
        const testRedisPassword = process.env.TEST_REDIS_PASSWORD ?? "";

        const scheduleForRootMock = jest.fn(() => ({ token: "ScheduleModule.forRoot" }));
        const configForRootMock = jest.fn((options) => ({ token: "ConfigModule.forRoot", options }));
        const rateLimitForRootMock = jest.fn((options) => ({ token: "RateLimitModule.forRoot", options }));
        const bullForRootAsyncMock = jest.fn((options) => ({ token: "BullModule.forRootAsync", options }));

        jest.doMock("../api", () => ({
            APIModule: class APIModule {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("../core", () => ({
            CoreModule: class CoreModule {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("../factory", () => ({
            FactoryModule: class FactoryModule {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("../scheduler", () => ({
            SchedulerModule: class SchedulerModule {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("../webhook", () => ({
            WebhookModule: class WebhookModule {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("@/config", () => ({
            redisConfig: {
                port: 6380,
                user: "redis-user",
                password: testRedisPassword,
                host: "redis.host",
                redisOptions: {
                    tls: { rejectUnauthorized: false },
                },
            },
            __esModule: true,
        }));

        jest.doMock("@nestjs/schedule", () => ({
            ScheduleModule: {
                forRoot: scheduleForRootMock,
            },
            __esModule: true,
        }));

        jest.doMock("@nestjs/config", () => ({
            ConfigModule: {
                forRoot: configForRootMock,
            },
            ConfigService: class ConfigService {
                readonly __stub = true;
            },
            __esModule: true,
        }));

        jest.doMock("@/modules/core/rate-limit", () => ({
            RateLimitModule: {
                forRoot: rateLimitForRootMock,
            },
            __esModule: true,
        }));

        jest.doMock("@nestjs/bull", () => ({
            BullModule: {
                forRootAsync: bullForRootAsyncMock,
            },
            __esModule: true,
        }));

        const { AppModule } = await import("../index");
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as Array<any>;

        expect(scheduleForRootMock).toHaveBeenCalledTimes(1);
        expect(configForRootMock).toHaveBeenCalledWith({ isGlobal: true });
        expect(rateLimitForRootMock).toHaveBeenCalledWith({ limit: 100, windowSeconds: 60 });
        expect(bullForRootAsyncMock).toHaveBeenCalledTimes(1);

        expect(imports.some((item) => item?.token === "ScheduleModule.forRoot")).toBe(true);
        expect(imports.some((item) => item?.token === "ConfigModule.forRoot")).toBe(true);
        expect(imports.some((item) => item?.token === "RateLimitModule.forRoot")).toBe(true);
        expect(imports.some((item) => item?.token === "BullModule.forRootAsync")).toBe(true);

        const bullRootConfig = imports.find((item) => item?.token === "BullModule.forRootAsync").options;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
        const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);

        const resolved = await bullRootConfig.useFactory();

        expect(resolved.redis.port).toBe(6380);
        expect(resolved.redis.username).toBe("redis-user");
        expect(resolved.redis.password).toBe(testRedisPassword);
        expect(resolved.redis.host).toBe("redis.host");
        expect(resolved.redis.tls).toEqual({ rejectUnauthorized: false });

        expect(resolved.redis.retryStrategy(2)).toBe(400);
        expect(resolved.redis.retryStrategy(11)).toBeNull();
        expect(errorSpy).toHaveBeenCalledWith("Bull Redis: Max retries exceeded");

        expect(resolved.redis.reconnectOnError(new Error("Too many requests from redis"))).toBe(true);
        expect(logSpy).toHaveBeenCalledWith("Bull Redis: Reconnecting due to rate limit");
        expect(resolved.redis.reconnectOnError(new Error("socket closed"))).toBe(false);

        errorSpy.mockRestore();
        logSpy.mockRestore();
    });
});
