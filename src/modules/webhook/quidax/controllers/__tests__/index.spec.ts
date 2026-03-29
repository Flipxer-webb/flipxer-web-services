import { PATH_METADATA } from "@nestjs/common/constants";

jest.mock("@/modules/api/auth/guard", () => ({
    QuidaxWebhookGuard: class QuidaxWebhookGuard {
        canActivate() {
            return true;
        }
    },
    AuthGuard: class AuthGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {
        canActivate() {
            return true;
        }
    },
}));

jest.mock("@/modules/api/auth", () => ({
    AuthModule: class AuthModule {
        isMock = true;
    },
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class UserModule {
        isMock = true;
    },
}));

jest.mock("@/modules/api/trade/gateway/v1", () => ({
    WsGateway: class WsGateway {
        isMock = true;
    },
}));

jest.mock("@/modules/api/trade/gateway/v1/index", () => ({
    WsGateway: class WsGateway {
        isMock = true;
    },
}));

import { QuidaxWebhookController } from "../index";

describe("QuidaxWebhookController", () => {
    it("queues webhook event and returns 200", async () => {
        const quidaxWebhookEvent = { emit: jest.fn() };
        const quidaxWebhookService = { getMetrics: jest.fn() };
        const response = { sendStatus: jest.fn() };

        const controller = new QuidaxWebhookController(
            quidaxWebhookEvent as any,
            quidaxWebhookService as any,
        );

        await controller.processWebhook({ event: "wallet.updated", data: {} } as any, response as any);

        expect(quidaxWebhookEvent.emit).toHaveBeenCalledWith("process-webhook-event", {
            event: "wallet.updated",
            data: {},
        });
        expect(response.sendStatus).toHaveBeenCalledWith(200);
    });

    it("returns 500 when event emit throws", async () => {
        const quidaxWebhookEvent = {
            emit: jest.fn(() => {
                throw new Error("queue-failed");
            }),
        };
        const quidaxWebhookService = { getMetrics: jest.fn() };
        const response = { sendStatus: jest.fn() };

        const controller = new QuidaxWebhookController(
            quidaxWebhookEvent as any,
            quidaxWebhookService as any,
        );

        await controller.processWebhook({ event: "wallet.updated", data: {} } as any, response as any);

        expect(response.sendStatus).toHaveBeenCalledWith(500);
    });

    it("returns metrics payload", () => {
        const metrics = { totalReceived: 3 };
        const quidaxWebhookEvent = { emit: jest.fn() };
        const quidaxWebhookService = { getMetrics: jest.fn().mockReturnValue(metrics) };

        const controller = new QuidaxWebhookController(
            quidaxWebhookEvent as any,
            quidaxWebhookService as any,
        );

        const result = controller.getMetrics();

        expect(result).toEqual({
            success: true,
            message: "Webhook metrics retrieved",
            data: metrics,
        });
        expect(quidaxWebhookService.getMetrics).toHaveBeenCalledTimes(1);
    });

    it("defines controller path metadata", () => {
        const pathMeta = Reflect.getMetadata(PATH_METADATA, QuidaxWebhookController);
        expect(pathMeta).toBe("quidax");
    });
});
