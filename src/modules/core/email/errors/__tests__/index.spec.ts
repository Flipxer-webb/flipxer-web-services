import { HttpStatus } from "@nestjs/common";
import { InvalidEmailProviderException } from "../index";

describe("InvalidEmailProviderException", () => {
    it("sets exception metadata", () => {
        const error = new InvalidEmailProviderException("provider-not-supported");

        expect(error.name).toBe("InvalidEmailProviderException");
        expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        expect(error.message).toBe("provider-not-supported");
    });
});