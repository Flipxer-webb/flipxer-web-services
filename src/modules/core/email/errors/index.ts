import { HttpException, HttpStatus } from "@nestjs/common";

export class InvalidEmailProviderException extends HttpException {
    name = "InvalidEmailProviderException";

    constructor(message: string) {
        super(message, HttpStatus.BAD_REQUEST); // You can set a specific HTTP status code
    }
}