import { HttpException } from "@nestjs/common";

export class WalletAddressNotFoundException extends HttpException {
    name = "WalletAddressNotFoundException";
}

export class AccountCreationException extends HttpException {
    name = "AccountCreationException";
}

export class IncompleteAccountSetupException extends HttpException {
    name = "IncompleteAccountSetupException";
}

export class TransactionNotFoundException extends HttpException {
    name = "TransactionNotFoundException";
}

export class TransactionCompletedException extends HttpException {
    name = "TransactionCompletedException";
}

export class AssetNotFoundException extends HttpException {
    name = "AssetNotFoundException";
}

export class OutOfRangeException extends HttpException {
    name = "OutOfRangeException";
}

export class UnknownFeeStructureException extends HttpException {
    name = "UnknownFeeStructureException";
}

export class GeneralTransactionException extends HttpException {
    name = "GeneralTransactionException";
}
