import { PATH_METADATA, VERSION_METADATA } from "@nestjs/common/constants";
import { VERSION_NEUTRAL } from "@nestjs/common";
import { WebExtensionController } from "../index";

describe("WebExtensionController", () => {
    it("returns health payload from service", () => {
        const webExtensionService = {
            health: jest.fn().mockReturnValue({ status: "ok" }),
        };

        const controller = new WebExtensionController(webExtensionService as any);
        const result = controller.health();

        expect(webExtensionService.health).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ status: "ok" });
    });

    it("defines version-neutral controller and health route", () => {
        const classVersion = Reflect.getMetadata(VERSION_METADATA, WebExtensionController);
        const methodPath = Reflect.getMetadata(PATH_METADATA, WebExtensionController.prototype.health);

        expect(classVersion).toBe(VERSION_NEUTRAL);
        expect(methodPath).toBe("health");
    });
});
