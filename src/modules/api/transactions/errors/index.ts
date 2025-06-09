import { HttpException } from "@nestjs/common";

export class TransactionNotFoundException extends HttpException {
    name = "TransactionNotFoundException";
}

export class TransactionRefNotFoundException extends HttpException {
    name = "TransactionRefNotFoundException";
}

export class DuplicateTransactionException extends HttpException {
    name = "DuplicateTransactionException";
}
