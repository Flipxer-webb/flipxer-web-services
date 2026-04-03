jest.mock("../controllers", () => ({
    QuidaxWebhookController: class QuidaxWebhookController {},
}));

jest.mock("../events", () => ({
    QuidaxWebhookEvent: class QuidaxWebhookEvent {},
}));

jest.mock("../services", () => ({
    QuidaxWebhookService: class QuidaxWebhookService {},
}));

jest.mock("@/modules/api/trade", () => ({
    TradingModule: class TradingModule {},
}));

jest.mock("@/modules/api/session", () => ({
    SessionModule: class SessionModule {},
}));

import { QuidaxWebhookModule } from "../index";
import { QuidaxWebhookController } from "../controllers";
import { QuidaxWebhookEvent } from "../events";
import { QuidaxWebhookService } from "../services";

describe("QuidaxWebhookModule", () => {
    it("registers webhook providers and controller", () => {
        const providers = Reflect.getMetadata("providers", QuidaxWebhookModule) as unknown[];
        const controllers = Reflect.getMetadata("controllers", QuidaxWebhookModule) as unknown[];

        expect(providers).toEqual([QuidaxWebhookService, QuidaxWebhookEvent]);
        expect(controllers).toEqual([QuidaxWebhookController]);
    });
});