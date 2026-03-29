import { of } from "rxjs";
import { RateLimitInterceptor } from "../rate-limit.interceptor";

describe("RateLimitInterceptor", () => {
    it("uses user key and sets rate limit headers", async () => {
        const rateLimiter = {
            checkLimit: jest.fn().mockResolvedValue({
                allowed: true,
                remaining: 77,
                resetTime: 1_700_000_000_000,
            }),
        };

        const interceptor = new RateLimitInterceptor(rateLimiter as never);
        const setHeader = jest.fn();
        const request = { headers: {}, ip: "127.0.0.1", user: { id: 9 } };
        const context = {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => ({ setHeader }),
            }),
        };
        const next = { handle: jest.fn(() => of("ok")) };

        const result = await interceptor.intercept(context as never, next as never);

        expect(rateLimiter.checkLimit).toHaveBeenCalledWith("user:9");
        expect(setHeader).toHaveBeenCalledWith("X-RateLimit-Limit", 100);
        expect(setHeader).toHaveBeenCalledWith("X-RateLimit-Remaining", 77);
        expect(setHeader).toHaveBeenCalledWith("X-RateLimit-Reset", 1700000000);
        expect(next.handle).toHaveBeenCalledTimes(1);
        expect(result).toBeDefined();
    });

    it("uses x-forwarded-for ip key when user is missing", async () => {
        const rateLimiter = {
            checkLimit: jest.fn().mockResolvedValue({
                allowed: true,
                remaining: 1,
                resetTime: 2_000,
            }),
        };

        const interceptor = new RateLimitInterceptor(rateLimiter as never);
        const request = {
            headers: { "x-forwarded-for": "10.10.0.1, 10.10.0.2" },
            ip: "127.0.0.1",
            user: undefined,
        };
        const context = {
            switchToHttp: () => ({
                getRequest: () => request,
                getResponse: () => ({ setHeader: jest.fn() }),
            }),
        };

        await interceptor.intercept(context as never, { handle: () => of("ok") } as never);

        expect(rateLimiter.checkLimit).toHaveBeenCalledWith("ip:10.10.0.1");
    });
});