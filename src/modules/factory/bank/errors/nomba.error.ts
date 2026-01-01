import { HttpException, HttpStatus } from "@nestjs/common";

export class NOMBABankException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class NombaWorkflowException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.NOT_IMPLEMENTED
    ) {
        super(message, status);
    }
}

export class NombaTransferException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class NombaVerifyTransactionException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.NOT_IMPLEMENTED
    ) {
        super(message, status);
    }
}

export class NombaVirtualAccountException extends HttpException {
    constructor(
        message: string,
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}
