import {
    QuidaxAuthorizationError,
    QuidaxError,
    QuidaxGenericError,
    QuidaxNotFoundError,
    QuidaxTooManyRequestError,
    QuidaxValidationError,
} from "../index";

describe("quidax error classes", () => {
    it("builds base and generic errors", () => {
        const base = new QuidaxError("base");
        const generic = new QuidaxGenericError("generic");
        generic.status = 500;

        expect(base.name).toBe("QuidaxError");
        expect(base.message).toBe("base");
        expect(generic.name).toBe("QuidaxGenericError");
        expect(generic.status).toBe(500);
    });

    it("sets fixed status codes for authorization/not-found/too-many-requests", () => {
        const authError = new QuidaxAuthorizationError("unauthorized");
        const notFoundError = new QuidaxNotFoundError("missing");
        const tooManyError = new QuidaxTooManyRequestError("rate-limited");

        expect(authError.status).toBe(401);
        expect(notFoundError.status).toBe(404);
        expect(tooManyError.status).toBe(429);
        expect(tooManyError.name).toBe("DojahTooManyRequestError");
    });

    it("stores optional error code for validation errors", () => {
        const errorWithCode = new QuidaxValidationError("validation failed", "E0101");
        const errorWithoutCode = new QuidaxValidationError("validation failed");

        expect(errorWithCode.name).toBe("QuidaxValidationError");
        expect(errorWithCode.status).toBe(400);
        expect(errorWithCode.code).toBe("E0101");
        expect(errorWithoutCode.code).toBeUndefined();
    });
});
