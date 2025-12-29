import { isProdEnvironment } from "@/config";
import { ValidationException } from "@/core/pipe/error";
import { ErrorCode } from "@/core/exception/error-codes";
import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
    constructor(private readonly httpAdapterHost: HttpAdapterHost) { }

    catch(exception: any, host: ArgumentsHost): void {
        const { httpAdapter } = this.httpAdapterHost;
        const ctx = host.switchToHttp();

        const httpStatus =
            exception instanceof HttpException
                ? exception.getStatus()
                : HttpStatus.INTERNAL_SERVER_ERROR;

        // Extract error code from exception if available
        let errorCode: ErrorCode | string | undefined;
        let errorMessage: string;

        if (exception instanceof HttpException) {
            const response = exception.getResponse();

            // Check if response is an object with code/message
            if (typeof response === "object" && response !== null) {
                const responseObj = response as Record<string, unknown>;
                errorCode = responseObj.code as string | undefined;
                errorMessage = (responseObj.message as string) || exception.message;
            } else {
                errorMessage = typeof response === "string" ? response : exception.message;
            }

            // If no code provided, try to infer from exception name
            if (!errorCode && exception.name) {
                errorCode = this.inferErrorCodeFromName(exception.name);
            }
        } else {
            errorMessage = exception.message || "An unexpected error occurred";
        }

        // Handle ValidationException specially
        if (exception instanceof ValidationException) {
            const exceptionResponse = exception.getResponse();
            const responseBody = {
                success: false,
                message: "Validation Failed",
                code: ErrorCode.VALIDATION_ERROR,
                errors: exceptionResponse,
                stack: isProdEnvironment ? undefined : exception.stack,
            };
            return httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
        }

        // Build response body
        const responseBody: Record<string, unknown> = {
            success: false,
            message: httpStatus === 500 ? "Something went wrong" : errorMessage,
            code: errorCode || this.inferErrorCodeFromStatus(httpStatus),
            stack: isProdEnvironment ? undefined : exception.stack,
        };

        // Log 500 errors for debugging
        if (httpStatus >= 500 && !isProdEnvironment) {
            console.error("[AllExceptionsFilter] Server Error:", exception);
        }

        httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
    }

    /**
     * Infer error code from exception class name
     */
    private inferErrorCodeFromName(name: string): ErrorCode | undefined {
        const nameToCodeMap: Record<string, ErrorCode> = {
            InvalidCredentialException: ErrorCode.INVALID_CREDENTIALS,
            UserUnauthorizedException: ErrorCode.UNAUTHORIZED,
            UserForbiddenException: ErrorCode.FORBIDDEN,
            UserAccountDisabledException: ErrorCode.ACCOUNT_DISABLED,
            UserNotFoundException: ErrorCode.NOT_FOUND,
            InvalidVerificationCodeException: ErrorCode.INVALID_OTP,
            VerificationCodeExpiredException: ErrorCode.OTP_EXPIRED,
            InvalidRefreshToken: ErrorCode.SESSION_EXPIRED,
            AuthGenericException: ErrorCode.UNKNOWN_ERROR,
        };
        return nameToCodeMap[name];
    }

    /**
     * Infer error code from HTTP status code
     */
    private inferErrorCodeFromStatus(status: number): ErrorCode {
        const statusToCodeMap: Record<number, ErrorCode> = {
            400: ErrorCode.INVALID_INPUT,
            401: ErrorCode.UNAUTHORIZED,
            403: ErrorCode.FORBIDDEN,
            404: ErrorCode.NOT_FOUND,
            409: ErrorCode.CONFLICT,
            422: ErrorCode.VALIDATION_ERROR,
            429: ErrorCode.RATE_LIMITED,
            500: ErrorCode.SERVER_ERROR,
        };
        return statusToCodeMap[status] || ErrorCode.UNKNOWN_ERROR;
    }
}

