import { HttpException, HttpStatus } from "@nestjs/common";

class SessionException extends HttpException {
    constructor(message: string, status: HttpStatus) {
        super(
            {
                success: false,
                message,
            },
            status
        );
    }
}

export class SessionNotFoundException extends SessionException {
    constructor(message: string, status: HttpStatus = HttpStatus.NOT_FOUND) {
        super(message, status);
    }
}

export class SessionExpiredException extends SessionException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.UNAUTHORIZED
    ) {
        super(message, status);
    }
}

export class SessionRevokedException extends SessionExpiredException {}

export class InvalidSessionException extends SessionException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}
