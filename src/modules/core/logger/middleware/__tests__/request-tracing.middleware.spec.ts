import { EventEmitter } from "events";

import {
    RequestTracingMiddleware,
    getCorrelationId,
} from "../request-tracing.middleware";

describe("RequestTracingMiddleware", () => {
    const createFixture = () => {
        const requestLogger = {
            setCorrelationId: jest.fn(),
            setRequestContext: jest.fn(),
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            clearRequestContext: jest.fn(),
        };

        const baseLogger = {
            setContext: jest.fn(),
            generateCorrelationId: jest.fn().mockReturnValue("generated-correlation-id"),
            child: jest.fn().mockReturnValue(requestLogger),
        };

        const middleware = new RequestTracingMiddleware(baseLogger as any);

        const response = new EventEmitter() as any;
        response.statusCode = 200;
        response.setHeader = jest.fn();
        response.get = jest.fn().mockReturnValue("123");

        const req: any = {
            method: "GET",
            originalUrl: "/api/v1/resource",
            ip: "127.0.0.1",
            headers: {
                "user-agent": "jest-agent",
                "content-type": "application/json",
            },
            query: {},
        };

        const next = jest.fn();

        return { middleware, baseLogger, requestLogger, response, req, next };
    };

    it("sets logger context in constructor", () => {
        const { baseLogger } = createFixture();
        expect(baseLogger.setContext).toHaveBeenCalledWith("RequestTracing");
    });

    it("uses incoming x-correlation-id and logs successful request completion", () => {
        const { middleware, baseLogger, requestLogger, response, req, next } = createFixture();
        req.headers["x-correlation-id"] = "cid-from-header";

        middleware.use(req, response, next);

        expect(baseLogger.generateCorrelationId).not.toHaveBeenCalled();
        expect(req.correlationId).toBe("cid-from-header");
        expect(req.logger).toBe(requestLogger);
        expect(response.setHeader).toHaveBeenCalledWith("x-correlation-id", "cid-from-header");
        expect(response.setHeader).toHaveBeenCalledWith("x-request-id", "cid-from-header");
        expect(next).toHaveBeenCalled();

        response.emit("finish");
        expect(requestLogger.log).toHaveBeenCalledWith(
            "Request completed",
            expect.objectContaining({ statusCode: 200 }),
        );
        expect(requestLogger.clearRequestContext).toHaveBeenCalled();
    });

    it("falls back to x-request-id when x-correlation-id is absent", () => {
        const { middleware, baseLogger, requestLogger, response, req, next } = createFixture();
        req.headers["x-request-id"] = "rid-header";

        middleware.use(req, response, next);

        expect(baseLogger.generateCorrelationId).not.toHaveBeenCalled();
        expect(requestLogger.setCorrelationId).toHaveBeenCalledWith("rid-header");
        expect(req.correlationId).toBe("rid-header");
    });

    it("generates a new correlation ID and uses user.id when present", () => {
        const { middleware, baseLogger, requestLogger, response, req, next } = createFixture();
        req.user = { id: 42 };

        middleware.use(req, response, next);

        expect(baseLogger.generateCorrelationId).toHaveBeenCalled();
        expect(requestLogger.setRequestContext).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 42 }),
        );
        expect(req.correlationId).toBe("generated-correlation-id");
    });

    it("extracts userId from query string for admin-like routes", () => {
        const { middleware, requestLogger, response, req, next } = createFixture();
        req.query.userId = "88";

        middleware.use(req, response, next);

        expect(requestLogger.setRequestContext).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 88 }),
        );
    });

    it("handles invalid query userId by setting undefined userId", () => {
        const { middleware, requestLogger, response, req, next } = createFixture();
        req.query.userId = "not-a-number";

        middleware.use(req, response, next);

        expect(requestLogger.setRequestContext).toHaveBeenCalledWith(
            expect.objectContaining({ userId: undefined }),
        );
    });

    it("logs client errors with warn on 4xx responses", () => {
        const { middleware, requestLogger, response, req, next } = createFixture();

        middleware.use(req, response, next);
        response.statusCode = 404;
        response.emit("finish");

        expect(requestLogger.warn).toHaveBeenCalledWith(
            "Request client error",
            expect.objectContaining({ statusCode: 404 }),
        );
    });

    it("logs server errors with error on 5xx responses", () => {
        const { middleware, requestLogger, response, req, next } = createFixture();

        middleware.use(req, response, next);
        response.statusCode = 500;
        response.emit("finish");

        expect(requestLogger.error).toHaveBeenCalledWith(
            "Request failed",
            undefined,
            expect.objectContaining({ statusCode: 500 }),
        );
    });

    it("returns unknown correlation id when request does not have one", () => {
        expect(getCorrelationId({} as any)).toBe("unknown");
        expect(getCorrelationId({ correlationId: "cid" } as any)).toBe("cid");
    });

    it("uses x-forwarded-for when req.ip is not available", () => {
        const { middleware, requestLogger, response, req, next } = createFixture();
        req.ip = undefined;
        req.headers["x-forwarded-for"] = "10.10.10.10";

        middleware.use(req, response, next);

        expect(requestLogger.log).toHaveBeenCalledWith(
            "Request received",
            expect.objectContaining({ ip: "10.10.10.10" }),
        );
    });
});
