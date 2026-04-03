import { HttpStatus } from "@nestjs/common";
import {
    AllowedIpExistException,
    AllowedIpNotFoundException,
    CryptoRateNotFoundException,
    CryptoTransactionFeeNotFoundException,
    GenericAllowedIpException,
} from "../index";

describe("settings custom exceptions", () => {
    it("creates not-found exceptions with defaults", () => {
        const rateError = new CryptoRateNotFoundException();
        const feeError = new CryptoTransactionFeeNotFoundException();
        const ipError = new AllowedIpNotFoundException();

        expect(rateError.name).toBe("CryptoRateNotFoundException");
        expect(rateError.getStatus()).toBe(HttpStatus.NOT_FOUND);

        expect(feeError.name).toBe("CryptoTransactionFeeNotFoundException");
        expect(feeError.getStatus()).toBe(HttpStatus.NOT_FOUND);

        expect(ipError.name).toBe("AllowedIpNotFoundException");
        expect(ipError.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it("creates bad-request and generic exceptions", () => {
        const existsError = new AllowedIpExistException();
        const genericError = new GenericAllowedIpException("generic ip error", HttpStatus.CONFLICT);

        expect(existsError.name).toBe("AllowedIpExistException");
        expect(existsError.getStatus()).toBe(HttpStatus.BAD_REQUEST);

        expect(genericError.name).toBe("GenericAllowedIpException");
        expect(genericError.getStatus()).toBe(HttpStatus.CONFLICT);
    });
});
