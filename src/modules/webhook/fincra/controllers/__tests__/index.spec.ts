import { PATH_METADATA, VERSION_METADATA } from "@nestjs/common/constants";
import { VERSION_NEUTRAL } from "@nestjs/common";

jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        UseGuards: () => () => undefined,
    };
});

jest.mock("@/modules/api/auth/guard", () => ({
    FincraWebhookGuard: class FincraWebhookGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/auth", () => ({}));

import { FincraWebhookController } from "../index";

describe("FincraWebhookController", () => {
    it("processes webhook and responds with 200", async () => {
        const fincraWebhookService = {
            processWebhookEvent: jest.fn().mockResolvedValue(undefined),
        };

        const controller = new FincraWebhookController(fincraWebhookService as any);
        const payload = { event: "transfer" } as any;
        const res = { sendStatus: jest.fn() } as any;

        await controller.processWebhook(payload, res);

        expect(fincraWebhookService.processWebhookEvent).toHaveBeenCalledWith(payload);
        expect(res.sendStatus).toHaveBeenCalledWith(200);
    });

    it("defines controller metadata", () => {
        const pathMeta = Reflect.getMetadata(PATH_METADATA, FincraWebhookController);
        const versionMeta = Reflect.getMetadata(VERSION_METADATA, FincraWebhookController);

        expect(pathMeta).toBe("fincra");
        expect(versionMeta).toBe(VERSION_NEUTRAL);
    });
});
