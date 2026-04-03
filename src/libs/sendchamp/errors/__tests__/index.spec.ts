import {
    SendchampAuthorizationError,
    SendchampError,
    SendchampGenericError,
    SendchampInsufficientBalanceError,
    SendchampValidationError,
} from "../index";

describe("sendchamp error classes", () => {
    it("creates base SendchampError", () => {
        const err = new SendchampError("base-message");
        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe("SendchampError");
        expect(err.message).toBe("base-message");
        expect(err.status).toBeUndefined();
    });

    it("creates authorization error with default status", () => {
        const err = new SendchampAuthorizationError();
        expect(err.name).toBe("SendchampAuthorizationError");
        expect(err.status).toBe(401);
        expect(err.message).toContain("Unauthorized");
    });

    it("creates validation error with custom message", () => {
        const err = new SendchampValidationError("bad payload");
        expect(err.name).toBe("SendchampValidationError");
        expect(err.status).toBe(422);
        expect(err.message).toBe("bad payload");
    });

    it("creates insufficient-balance error", () => {
        const err = new SendchampInsufficientBalanceError();
        expect(err.name).toBe("SendchampInsufficientBalanceError");
        expect(err.status).toBe(402);
        expect(err.message).toBe("Insufficient balance");
    });

    it("creates generic error with default status", () => {
        const err = new SendchampGenericError();
        expect(err.name).toBe("SendchampGenericError");
        expect(err.status).toBe(500);
        expect(err.message).toBe("An error occurred");
    });
});
