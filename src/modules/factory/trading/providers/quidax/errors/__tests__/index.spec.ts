import { QuidaxException } from "../index";

describe("QuidaxException", () => {
    it("sets message, status, name and code when provided", () => {
        const error = new QuidaxException("quidax failed", 422, "E0101");

        expect(error.name).toBe("QuidaxException");
        expect(error.message).toBe("quidax failed");
        expect(error.getStatus()).toBe(422);
        expect(error.code).toBe("E0101");
    });

    it("keeps code undefined when not provided", () => {
        const error = new QuidaxException("no code", 400);

        expect(error.getStatus()).toBe(400);
        expect(error.code).toBeUndefined();
    });
});
