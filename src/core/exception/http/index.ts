import { isProdEnvironment } from "@/config";
import { ValidationException } from "@/core/pipe/error";
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
    constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

    catch(exception: any, host: ArgumentsHost): void {
        // In certain situations `httpAdapter` might not be available in the
        // constructor method, thus we should resolve it here.

        const { httpAdapter } = this.httpAdapterHost;

        const ctx = host.switchToHttp();

        const httpStatus =
            exception instanceof HttpException
                ? exception.getStatus()
                : HttpStatus.INTERNAL_SERVER_ERROR;

        switch (true) {
            case exception instanceof ValidationException: {
                const exceptionResponse = exception.getResponse();
                const responseBody = {
                    success: false,
                    message: "Failed Validation",
                    errors: exceptionResponse,
                    stack: isProdEnvironment ? undefined : exception.stack, //only show stack in development
                };
                return httpAdapter.reply(
                    ctx.getResponse(),
                    responseBody,
                    httpStatus
                );
            }

            default: {
                const responseBody = {
                    success: false,
                    message:
                        httpStatus == 500
                            ? "Something went wrong"
                            : exception.message,
                    stack: isProdEnvironment ? undefined : exception.stack, //only show stack in development
                };
                httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
            }
        }
    }
}
