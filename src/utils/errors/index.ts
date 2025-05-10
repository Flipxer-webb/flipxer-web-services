import { HttpException } from "@nestjs/common";

export class APIServiceHttpException extends HttpException {
    constructor(options: ErrorResponseBody, status: number) {
        super(options, status);
    }
}

export class NonApiServiceHttpException extends HttpException {}
