import { HttpStatus } from "@nestjs/common";
import {
    FINCRABankException,
    FincraWorkflowException,
    FincraVerifyTransactionException,
    FincraTransferException,
} from "../fincra.error";
import {
    NOMBABankException,
    NombaWorkflowException,
    NombaTransferException,
    NombaVerifyTransactionException,
    NombaVirtualAccountException,
} from "../nomba.error";

describe("Bank factory error classes", () => {
    it("creates fincra exceptions with expected names", () => {
        const bankError = new FINCRABankException("bank-error", HttpStatus.BAD_GATEWAY);
        const workflowError = new FincraWorkflowException("workflow", HttpStatus.BAD_REQUEST);
        const verifyError = new FincraVerifyTransactionException("verify", HttpStatus.CONFLICT);
        const transferError = new FincraTransferException("transfer", HttpStatus.UNPROCESSABLE_ENTITY);

        expect(bankError.name).toBe("FINCRABankException");
        expect(workflowError.name).toBe("FincraWorkflowException");
        expect(verifyError.name).toBe("FincraVerifyTransactionException");
        expect(transferError.name).toBe("FincraTransferException");
    });

    it("uses default and custom status codes for nomba exceptions", () => {
        const bankDefault = new NOMBABankException("bank-default");
        const workflowDefault = new NombaWorkflowException("workflow-default");
        const transferDefault = new NombaTransferException("transfer-default");
        const verifyDefault = new NombaVerifyTransactionException("verify-default");
        const vaDefault = new NombaVirtualAccountException("va-default");

        const custom = new NOMBABankException("bank-custom", HttpStatus.SERVICE_UNAVAILABLE);

        expect(bankDefault.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(workflowDefault.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
        expect(transferDefault.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(verifyDefault.getStatus()).toBe(HttpStatus.NOT_IMPLEMENTED);
        expect(vaDefault.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(custom.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });
});