jest.mock("../controllers", () => ({
    FincraWebhookController: class FincraWebhookController {
        isMock = true;
    },
}));

jest.mock("../services", () => ({
    FincraWebhookService: class FincraWebhookService {
        isMock = true;
    },
}));

jest.mock("@/modules/api/banks", () => ({
    BankModule: class BankModule {
        isMock = true;
    },
}));

jest.mock("@/modules/api/operations", () => ({
    OperationsModule: class OperationsModule {
        isMock = true;
    },
}));

import { FincraWebhookModule } from "../index";
import { FincraWebhookController } from "../controllers";
import { FincraWebhookService } from "../services";

describe("PaymentWebhookModule", () => {
    it("registers webhook provider and controller", () => {
        const providers = Reflect.getMetadata("providers", FincraWebhookModule) as unknown[];
        const controllers = Reflect.getMetadata("controllers", FincraWebhookModule) as unknown[];

        expect(providers).toEqual([FincraWebhookService]);
        expect(controllers).toEqual([FincraWebhookController]);
    });
});