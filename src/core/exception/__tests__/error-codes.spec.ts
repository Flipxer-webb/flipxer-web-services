import { ErrorCode, createError } from "../error-codes";

describe("error-codes", () => {
    it("should expose known enum values", () => {
        const values = Object.values(ErrorCode);

        expect(values).toContain("INVALID_CREDENTIALS");
        expect(values).toContain("VALIDATION_ERROR");
        expect(values).toContain("RATE_LIMITED");
        expect(values).toContain("SERVER_ERROR");
        expect(values.length).toBeGreaterThan(20);
    });

    it("should build a structured error response with details", () => {
        const error = createError(
            ErrorCode.INVALID_INPUT,
            "Invalid payload",
            { field: "email", reason: "required" },
        );

        expect(error).toEqual({
            code: ErrorCode.INVALID_INPUT,
            message: "Invalid payload",
            details: { field: "email", reason: "required" },
        });
    });

    it("should build a structured error response without details", () => {
        const error = createError(ErrorCode.NOT_FOUND, "Resource not found");

        expect(error.code).toBe(ErrorCode.NOT_FOUND);
        expect(error.message).toBe("Resource not found");
        expect(error.details).toBeUndefined();
    });
});
