import { Catch, ArgumentsHost, WsExceptionFilter } from "@nestjs/common";
import { WsException } from "@nestjs/websockets";
import { WsValidationException } from "./pipe/error";

@Catch(WsException)
export class AllExceptionsWsFilter implements WsExceptionFilter {
    catch(exception: any, host: ArgumentsHost) {
        const client = host.switchToWs().getClient();

        const response = {
            event: "exception",
            data: null,
            message: "",
            success: false,
            stack: undefined,
        };

        if (exception instanceof WsException) {
            response.message = exception.message;
            response.stack =
                process.env.NODE_ENV === "production"
                    ? undefined
                    : exception.stack;
        } else if (exception instanceof WsValidationException) {
            response.message = "Failed Validation";
            response.data = exception.getResponse();
            response.stack =
                process.env.NODE_ENV === "production"
                    ? undefined
                    : exception.stack;
        } else {
            response.message = "Internal server error";
            response.stack =
                process.env.NODE_ENV === "production"
                    ? undefined
                    : exception.stack;
        }

        client.emit(response.event, response);
    }
}
