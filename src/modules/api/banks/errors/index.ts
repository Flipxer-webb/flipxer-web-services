import { HttpException } from "@nestjs/common";

export class GenericBankException extends HttpException {
    name = "GenericBankException";
}

export class BankDetailNotFoundException extends HttpException {
    name = "BankDetailNotFoundException";
}
