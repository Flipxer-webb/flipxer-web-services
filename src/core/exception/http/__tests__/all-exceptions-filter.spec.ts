jest.mock("@/config", () => ({
    isProdEnvironment: false,
}));

import { ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { AllExceptionsFilter } from "../index";
import { ValidationException } from "@/core/pipe/error";
import { ErrorCode } from "@/core/exception/error-codes";

describe("AllExceptionsFilter", () => {
    let reply: jest.Mock;
    let filter: AllExceptionsFilter;
    let host: ArgumentsHost;
    let response: Record<string, unknown>;

    beforeEach(() => {
        reply = jest.fn();
        filter = new AllExceptionsFilter({
            httpAdapter: { reply },
        } as any);

        response = {};
        host = {
            switchToHttp: () => ({
                getResponse: () => response,
            }),
        } as any;

        jest.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("should handle Multer LIMIT_FILE_SIZE errors", () => {
        const exception = {
            name: "MulterError",
            code: "LIMIT_FILE_SIZE",
            field: "document",
            message: "File too large",
        };

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            expect.objectContaining({
                success: false,
                message: "One or more files exceed the allowed size limit",
                code: ErrorCode.INVALID_INPUT,
                details: { multerCode: "LIMIT_FILE_SIZE", field: "document" },
            }),
            HttpStatus.PAYLOAD_TOO_LARGE,
        );
    });

    it("should handle ValidationException responses", () => {
        const validationPayload = [{ field: "email", message: "invalid" }];
        const exception = new ValidationException(validationPayload as any, HttpStatus.UNPROCESSABLE_ENTITY);

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                success: false,
                message: "Validation Failed",
                code: ErrorCode.VALIDATION_ERROR,
                errors: validationPayload,
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
        );
    });

    it("should use explicit error code from HttpException response object", () => {
        const exception = new HttpException(
            { message: "Forbidden action", code: "CUSTOM_CODE" },
            HttpStatus.FORBIDDEN,
        );

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                success: false,
                message: "Forbidden action",
                code: "CUSTOM_CODE",
            },
            HttpStatus.FORBIDDEN,
        );
    });

    it("should infer error code from exception name", () => {
        const exception = new HttpException("Unauthorized", HttpStatus.UNAUTHORIZED) as HttpException & { name: string };
        exception.name = "UserUnauthorizedException";

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                success: false,
                message: "Unauthorized",
                code: ErrorCode.UNAUTHORIZED,
            },
            HttpStatus.UNAUTHORIZED,
        );
    });

    it("should hide raw server error messages for generic exceptions", () => {
        const exception = new Error("database is down");

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                success: false,
                message: "Something went wrong",
                code: ErrorCode.SERVER_ERROR,
            },
            HttpStatus.INTERNAL_SERVER_ERROR,
        );
    });

    it("should infer code by status when no code or name mapping exists", () => {
        const exception = new HttpException("Too many requests", HttpStatus.TOO_MANY_REQUESTS);

        filter.catch(exception, host);

        expect(reply).toHaveBeenCalledWith(
            response,
            {
                success: false,
                message: "Too many requests",
                code: ErrorCode.RATE_LIMITED,
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    });
});
