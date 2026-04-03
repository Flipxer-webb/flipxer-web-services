import { Logger } from "@nestjs/common";
import { RequestLoggerMiddleware } from "../request-logger.middleware";

describe("RequestLoggerMiddleware", () => {
    it("logs API hit on response finish and calls next", () => {
        const middleware = new RequestLoggerMiddleware();
        const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();

        const req = {
            method: "GET",
            originalUrl: "/api/test",
        } as any;

        const res = {
            statusCode: 200,
            on: jest.fn((event: string, cb: () => void) => {
                if (event === "finish") {
                    cb();
                }
            }),
        } as any;

        const next = jest.fn();

        middleware.use(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.on).toHaveBeenCalledWith("finish", expect.any(Function));
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("[API_HIT] GET /api/test 200 +"));

        logSpy.mockRestore();
    });
});
