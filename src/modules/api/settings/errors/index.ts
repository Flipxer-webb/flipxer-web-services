import { HttpException, HttpStatus } from "@nestjs/common";

export class CryptoRateNotFoundException extends HttpException {
    name = "CryptoRateNotFoundException";
    constructor(
        message = "Crypto asset rate not found",
        status: HttpStatus = HttpStatus.NOT_FOUND
    ) {
        super(message, status);
    }
}

export class CryptoTransactionFeeNotFoundException extends HttpException {
    name = "CryptoTransactionFeeNotFoundException";
    constructor(
        message = "Crypto transaction fee not found",
        status: HttpStatus = HttpStatus.NOT_FOUND
    ) {
        super(message, status);
    }
}

export class AllowedIpNotFoundException extends HttpException {
    name = "AllowedIpNotFoundException";
    constructor(
        message = "Allowed ip not found",
        status: HttpStatus = HttpStatus.NOT_FOUND
    ) {
        super(message, status);
    }
}

export class AllowedIpExistException extends HttpException {
    name = "AllowedIpExistException";
    constructor(
        message = "Allowed ip already exist and active",
        status: HttpStatus = HttpStatus.BAD_REQUEST
    ) {
        super(message, status);
    }
}

export class GenericAllowedIpException extends HttpException {
    name = "GenericAllowedIpException";
}
