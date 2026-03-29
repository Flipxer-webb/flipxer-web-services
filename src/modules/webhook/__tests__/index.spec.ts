jest.mock("../quidax", () => ({
    QuidaxWebhookModule: class QuidaxWebhookModule {},
}));

jest.mock("../fincra", () => ({
    FincraWebhookModule: class FincraWebhookModule {},
}));

import { WebhookModule } from "../index";
import { QuidaxWebhookModule } from "../quidax";
import { FincraWebhookModule } from "../fincra";

describe("WebhookModule", () => {
    it("includes fincra and quidax webhook modules", () => {
        const importsMetadata = Reflect.getMetadata("imports", WebhookModule) as unknown[];

        expect(Array.isArray(importsMetadata)).toBe(true);
        expect(importsMetadata).toEqual(
            expect.arrayContaining([QuidaxWebhookModule, FincraWebhookModule]),
        );
    });
});