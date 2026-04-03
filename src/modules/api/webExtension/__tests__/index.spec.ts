import { WebExtension } from "../index";
import { WebExtensionController } from "../controllers";
import { WebExtensionService } from "../services";

describe("WebExtension module", () => {
    it("registers controllers and providers metadata", () => {
        const controllers = Reflect.getMetadata("controllers", WebExtension) as unknown[];
        const providers = Reflect.getMetadata("providers", WebExtension) as unknown[];

        expect(controllers).toEqual([WebExtensionController]);
        expect(providers).toEqual([WebExtensionService]);
    });
});