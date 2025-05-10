import { NonApiServiceHttpException } from "@/utils/errors";
import { HttpException } from "@nestjs/common";

export class PAYSTACKBankException extends NonApiServiceHttpException {
    name = "PAYSTACKBankException";
}

export class PaystackWorkflowException extends HttpException {
    name = "PaystackWorkflowException";
}

export class PaystackVerifyTransactionException extends HttpException {
    name = "PaystackVerifyTransactionException";
}
