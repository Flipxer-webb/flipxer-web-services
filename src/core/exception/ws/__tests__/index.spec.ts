import { WsException } from "@nestjs/websockets";
import { AllExceptionsWsFilter } from "../index";
import { WsValidationException } from "../pipe/error";

describe("AllExceptionsWsFilter", () => {
    const originalNodeEnv = process.env.NODE_ENV;

    const setupHost = () => {
        const emit = jest.fn();
        const host = {
            switchToWs: () => ({
                getClient: () => ({ emit }),
            }),
        } as any;

        return { host, emit };
    };

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("emits ws exception payload in non-production", () => {
        process.env.NODE_ENV = "development";
        const filter = new AllExceptionsWsFilter();
        const { host, emit } = setupHost();

        const exception = new WsException("socket-failed");
        filter.catch(exception, host);

        expect(emit).toHaveBeenCalledWith(
            "exception",
            expect.objectContaining({
                event: "exception",
                message: "socket-failed",
                success: false,
            })
        );
    });

    it("hides stack in production mode", () => {
        process.env.NODE_ENV = "production";
        const filter = new AllExceptionsWsFilter();
        const { host, emit } = setupHost();

        const exception = new WsException("socket-failed");
        filter.catch(exception, host);

        expect(emit).toHaveBeenCalledWith(
            "exception",
            expect.objectContaining({
                message: "socket-failed",
                stack: undefined,
            })
        );
    });

    it("falls back to internal server error for non-ws exceptions", () => {
        process.env.NODE_ENV = "development";
        const filter = new AllExceptionsWsFilter();
        const { host, emit } = setupHost();

        const exception = {
            message: "unexpected",
            stack: "some-stack",
        };

        filter.catch(exception, host);

        expect(emit).toHaveBeenCalledWith(
            "exception",
            expect.objectContaining({
                message: "Internal server error",
                stack: "some-stack",
            })
        );
    });

    it("WsValidationException stores and returns response", () => {
        const responsePayload = [{ fieldName: "email", message: "Invalid" }];
        const exception = new WsValidationException(responsePayload);

        expect(exception.getResponse()).toEqual(responsePayload);
    });
});
