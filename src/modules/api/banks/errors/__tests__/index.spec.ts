import { HttpStatus } from "@nestjs/common";
import { BankDetailNotFoundException, GenericBankException } from "../index";

describe("banks error classes", () => {
    it("creates generic bank exception with status and payload", () => {
        const payload = { message: "bank provider failed" };
        const error = new GenericBankException(payload, HttpStatus.BAD_GATEWAY);

        expect(error.name).toBe("GenericBankException");
        expect(error.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
        expect(error.getResponse()).toEqual(payload);
    });

    it("creates bank detail not found exception", () => {
        const error = new BankDetailNotFoundException("bank details missing", HttpStatus.NOT_FOUND);

        expect(error.name).toBe("BankDetailNotFoundException");
        expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(error.getResponse()).toBe("bank details missing");
    });
});
