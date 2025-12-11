import { HttpException, HttpStatus } from "@nestjs/common";

export class SessionNotFoundException extends HttpException {
    constructor(message: string, status: HttpStatus = HttpStatus.NOT_FOUND) {
        super(
            {
                success: false,
                message,
            },
            status
        );
    }
}

export class SessionExpiredException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.UNAUTHORIZED
    ) {
        super(
            {
                success: false,
                message,
            },
            status
        );
    }
}

export class SessionRevokedException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.UNAUTHORIZED
    ) {
        super(
            {
                success: false,
                message,
            },
            status
        );
    }
}

export class InvalidSessionException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(
            {
                success: false,
                message,
            },
            status
        );
    }
}
