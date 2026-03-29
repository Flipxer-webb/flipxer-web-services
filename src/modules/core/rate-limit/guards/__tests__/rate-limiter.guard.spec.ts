import "reflect-metadata";
import { HttpException, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
    RATE_LIMIT_KEY,
    RateLimit,
    RateLimiterGuard,
    RelaxedRateLimit,
    StrictRateLimit,
} from "../rate-limiter.guard";

describe("RateLimiterGuard", () => {
    const checkLimitMock = jest.fn();
    const getAllAndOverrideMock = jest.fn();

    const rateLimiter = {
        checkLimit: checkLimitMock,
    } as any;

    const reflector = {
        getAllAndOverride: getAllAndOverrideMock,
    } as unknown as Reflector;

    const makeContext = (request: any, response: any) =>
        ({
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => response,
            }),
            getHandler: () => jest.fn(),
            getClass: () => {
                class TestClass {
                    static readonly marker = "test";
                }
                return TestClass;
            },
        } as any);

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("allows request when skip returns true", async () => {
        const guard = new RateLimiterGuard(rateLimiter, reflector);
        const request = { path: "/x", ip: "127.0.0.1", headers: {} };
        const response = { setHeader: jest.fn() };

        getAllAndOverrideMock.mockReturnValue({
            skip: () => true,
        });

        await expect(guard.canActivate(makeContext(request, response))).resolves.toBe(true);
        expect(checkLimitMock).not.toHaveBeenCalled();
    });

    it("sets rate limit headers and allows requests", async () => {
        const guard = new RateLimiterGuard(rateLimiter, reflector);
        const request = {
            path: "/orders",
            ip: "127.0.0.1",
            headers: {},
            user: { id: 44 },
        };
        const response = { setHeader: jest.fn() };

        getAllAndOverrideMock.mockReturnValue({ limit: 10, windowSeconds: 60 });
        checkLimitMock.mockResolvedValue({
            allowed: true,
            remaining: 9,
            resetTime: Date.now() + 60000,
        });

        await expect(guard.canActivate(makeContext(request, response))).resolves.toBe(true);
        expect(checkLimitMock).toHaveBeenCalledWith("user:44:/orders", {
            limit: 10,
            windowSeconds: 60,
            failOpen: undefined,
        });
        expect(response.setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 10);
        expect(response.setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 9);
    });

    it("throws 429 and includes retry header when blocked", async () => {
        const guard = new RateLimiterGuard(rateLimiter, reflector);
        const request = { path: "/auth", ip: "127.0.0.1", headers: {} };
        const response = { setHeader: jest.fn() };

        getAllAndOverrideMock.mockReturnValue({
            limit: 2,
            windowSeconds: 60,
            errorMessage: "Slow down",
        });
        checkLimitMock.mockResolvedValue({
            allowed: false,
            remaining: 0,
            resetTime: Date.now() + 60000,
            retryAfter: 30,
        });

        await expect(guard.canActivate(makeContext(request, response))).rejects.toBeInstanceOf(
            HttpException
        );

        await guard.canActivate(makeContext(request, response)).catch((error) => {
            expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
            expect(error.getResponse()).toMatchObject({
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                message: "Slow down",
                retryAfter: 30,
            });
        });

        expect(response.setHeader).toHaveBeenCalledWith("Retry-After", 30);
    });

    it("uses custom key generator when provided", async () => {
        const guard = new RateLimiterGuard(rateLimiter, reflector);
        const request = { path: "/p", ip: "127.0.0.1", headers: {} };
        const response = { setHeader: jest.fn() };

        getAllAndOverrideMock.mockReturnValue({
            keyGenerator: () => "custom-key",
        });
        checkLimitMock.mockResolvedValue({
            allowed: true,
            remaining: 1,
            resetTime: Date.now() + 1000,
        });

        await guard.canActivate(makeContext(request, response));
        expect(checkLimitMock).toHaveBeenCalledWith("custom-key", {
            limit: undefined,
            windowSeconds: undefined,
            failOpen: undefined,
        });
    });

    it("extracts forwarded IP values", () => {
        const guard = new RateLimiterGuard(rateLimiter, reflector);

        expect(
            (guard as any).getClientIp({
                headers: { "x-forwarded-for": "client-a, client-b" },
                ip: "client-fallback",
            })
        ).toBe("client-a");

        expect(
            (guard as any).getClientIp({
                headers: { "x-forwarded-for": ["proxy-client"] },
                ip: "client-fallback",
            })
        ).toBe("proxy-client");

        expect(
            (guard as any).getClientIp({
                headers: {},
            })
        ).toBe("unknown");
    });
});

describe("RateLimiter decorators", () => {
    it("sets metadata for RateLimit / StrictRateLimit / RelaxedRateLimit", () => {
        class Demo {
            @RateLimit({ limit: 7, windowSeconds: 60 })
            a() {
                return true;
            }

            @StrictRateLimit()
            b() {
                return true;
            }

            @RelaxedRateLimit()
            c() {
                return true;
            }
        }

        const rateLimitMeta = Reflect.getMetadata(RATE_LIMIT_KEY, Demo.prototype.a);
        const strictMeta = Reflect.getMetadata(RATE_LIMIT_KEY, Demo.prototype.b);
        const relaxedMeta = Reflect.getMetadata(RATE_LIMIT_KEY, Demo.prototype.c);

        expect(rateLimitMeta).toMatchObject({ limit: 7, windowSeconds: 60 });
        expect(strictMeta).toMatchObject({ limit: 5, windowSeconds: 60, failOpen: false });
        expect(relaxedMeta).toMatchObject({ limit: 200, windowSeconds: 60 });
    });
});