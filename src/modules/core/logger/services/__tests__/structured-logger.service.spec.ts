const uuidMock = jest.fn(() => "corr-123");

jest.mock("node:crypto", () => ({
    ...jest.requireActual("node:crypto"),
    randomUUID: uuidMock,
}));

import {
    createLogger,
    StructuredLoggerService,
} from "../structured-logger.service";

describe("StructuredLoggerService", () => {
    let logger: StructuredLoggerService;

    beforeEach(() => {
        jest.clearAllMocks();
        logger = new StructuredLoggerService();
    });

    it("setContext and child preserve correlation/request context", () => {
        logger.setContext("ParentCtx").setRequestContext({
            correlationId: "parent-corr",
            method: "GET",
            path: "/health",
            userId: 9,
            startTime: 1000,
        });

        const child = logger.child("ChildCtx");
        const infoSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);

        child.log("child-message", { x: 1 });

        const entry = JSON.parse(String(infoSpy.mock.calls[0][0]));
        expect(entry.context).toBe("ChildCtx");
        expect(entry.correlationId).toBe("parent-corr");
        expect(entry.data.requestMethod).toBe("GET");
        expect(entry.data.requestPath).toBe("/health");
        expect(entry.data.userId).toBe(9);

        infoSpy.mockRestore();
    });

    it("getCorrelationId generates one when unset", () => {
        const correlationId = logger.getCorrelationId();
        expect(correlationId).toBe("corr-123");
        expect(uuidMock).toHaveBeenCalled();
    });

    it("routes levels to expected console methods", () => {
        const debugSpy = jest
            .spyOn(console, "debug")
            .mockImplementation(() => undefined);
        const infoSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);
        const warnSpy = jest
            .spyOn(console, "warn")
            .mockImplementation(() => undefined);
        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => undefined);

        logger.debug("debug-msg", { a: 1 });
        logger.log("info-msg", { b: 2 });
        logger.warn("warn-msg", { c: 3 });
        logger.error("error-msg", new Error("boom"), { d: 4 });

        expect(JSON.parse(String(debugSpy.mock.calls[0][0])).level).toBe(
            "debug",
        );
        expect(JSON.parse(String(infoSpy.mock.calls[0][0])).level).toBe("info");
        expect(JSON.parse(String(warnSpy.mock.calls[0][0])).level).toBe("warn");

        const errorEntry = JSON.parse(String(errorSpy.mock.calls[0][0]));
        expect(errorEntry.level).toBe("error");
        expect(errorEntry.error.name).toBe("Error");
        expect(errorEntry.error.message).toBe("boom");

        debugSpy.mockRestore();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it("logRequestStart and logRequestEnd track duration and clear context", () => {
        const infoSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);
        const nowSpy = jest.spyOn(Date, "now");

        nowSpy.mockReturnValueOnce(1000);
        const correlationId = logger.logRequestStart(
            "POST",
            "/api/v1/session",
            42,
        );
        expect(correlationId).toBe("corr-123");

        nowSpy.mockReturnValueOnce(1750);
        logger.logRequestEnd(201, { result: "ok" });

        const endEntry = JSON.parse(String(infoSpy.mock.calls[1][0]));
        expect(endEntry.message).toBe("Request completed");
        expect(endEntry.data.duration).toBe(750);
        expect(endEntry.data.statusCode).toBe(201);

        const afterClearId = logger.getCorrelationId();
        expect(afterClearId).toBe("corr-123");

        nowSpy.mockRestore();
        infoSpy.mockRestore();
    });

    it("logOperation logs completion path with duration", async () => {
        const infoSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);
        const nowSpy = jest.spyOn(Date, "now");

        nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(240);

        const result = await logger.logOperation(
            "SyncBalances",
            async () => "done",
            {
                accountId: "acc-1",
            },
        );

        expect(result).toBe("done");
        expect(JSON.parse(String(infoSpy.mock.calls[0][0])).message).toBe(
            "SyncBalances started",
        );

        const completedEntry = JSON.parse(String(infoSpy.mock.calls[1][0]));
        expect(completedEntry.message).toBe("SyncBalances completed");
        expect(completedEntry.data.duration).toBe(140);

        nowSpy.mockRestore();
        infoSpy.mockRestore();
    });

    it("logOperation logs failure path and rethrows", async () => {
        const errorSpy = jest
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const nowSpy = jest.spyOn(Date, "now");

        nowSpy.mockReturnValueOnce(500).mockReturnValueOnce(900);

        await expect(
            logger.logOperation(
                "PersistEvent",
                async () => {
                    throw new Error("db failure");
                },
                { eventId: "evt-1" },
            ),
        ).rejects.toThrow("db failure");

        const failedEntry = JSON.parse(String(errorSpy.mock.calls[0][0]));
        expect(failedEntry.message).toBe("PersistEvent failed");
        expect(failedEntry.data.duration).toBe(400);
        expect(failedEntry.error.message).toBe("db failure");

        nowSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it("createLogger returns logger with provided context", () => {
        const infoSpy = jest
            .spyOn(console, "log")
            .mockImplementation(() => undefined);

        const customLogger = createLogger("CustomCtx");
        customLogger.log("hello");

        const entry = JSON.parse(String(infoSpy.mock.calls[0][0]));
        expect(entry.context).toBe("CustomCtx");

        infoSpy.mockRestore();
    });
});
