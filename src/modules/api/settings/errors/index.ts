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
