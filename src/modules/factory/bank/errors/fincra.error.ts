import { NonApiServiceHttpException } from "@/utils/errors";
import { HttpException } from "@nestjs/common";

export class FINCRABankException extends NonApiServiceHttpException {
    name = "FINCRABankException";
}

export class FincraWorkflowException extends HttpException {
    name = "FincraWorkflowException";
}

export class FincraVerifyTransactionException extends HttpException {
    name = "FincraVerifyTransactionException";
}

export class FincraTransferException extends HttpException {
    name = "FincraTransferException";
}
