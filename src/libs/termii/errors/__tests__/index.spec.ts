import {
    TermiiError,
    TermiiAuthorizationError,
    TermiiValidationError,
    TermiiInsufficientBalanceError,
    TermiiGenericError,
} from "../index";

describe("Termii errors", () => {
    it("creates base termii error", () => {
        const error = new TermiiError("base-error");

        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("TermiiError");
        expect(error.message).toBe("base-error");
        expect(error.status).toBeUndefined();
    });

    it("uses defaults for specialized errors", () => {
        expect(new TermiiAuthorizationError().status).toBe(401);
        expect(new TermiiValidationError().status).toBe(400);
        expect(new TermiiInsufficientBalanceError().status).toBe(402);
        expect(new TermiiGenericError().name).toBe("TermiiGenericError");
    });

    it("supports custom messages", () => {
        const auth = new TermiiAuthorizationError("bad-key");
        const validation = new TermiiValidationError("bad-payload");
        const balance = new TermiiInsufficientBalanceError("no-funds");

        expect(auth.message).toBe("bad-key");
        expect(validation.message).toBe("bad-payload");
        expect(balance.message).toBe("no-funds");
    });
});