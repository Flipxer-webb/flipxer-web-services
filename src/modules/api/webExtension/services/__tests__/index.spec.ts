import { WebExtensionService } from "../index";

describe("WebExtensionService", () => {
    it("returns health response payload", () => {
        const service = new WebExtensionService();
        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(123456789);

        const result = service.health();

        expect(result).toEqual({
            success: true,
            message: "OK",
            timestamp: 123456789,
        });

        nowSpy.mockRestore();
    });
});