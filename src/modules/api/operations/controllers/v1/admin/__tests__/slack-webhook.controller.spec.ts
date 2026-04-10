jest.mock("@/utils/api-response-util", () => ({
    buildResponse: jest.fn((payload) => payload),
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { readonly __stub = true; },
    EnabledAccountGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class { readonly __stub = true; },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    __esModule: true,
}));

import { AdminSlackWebhookController } from "../slack-webhook.controller";

describe("AdminSlackWebhookController", () => {
    let controller: AdminSlackWebhookController;
    const mockSlackService = {
        getWebhooks: jest.fn(),
        getWebhookById: jest.fn(),
        createWebhook: jest.fn(),
        updateWebhook: jest.fn(),
        deleteWebhook: jest.fn(),
        testWebhook: jest.fn(),
    };
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockReq = { user: { id: 1 }, ip: "127.0.0.1", headers: { "user-agent": "test" } } as any;

    beforeEach(() => {
        jest.clearAllMocks();
        controller = new AdminSlackWebhookController(
            mockSlackService as any,
            mockAuditLogService as any,
        );
    });

    it("should get all webhooks", async () => {
        mockSlackService.getWebhooks.mockResolvedValue([]);
        await controller.getWebhooks();
        expect(mockSlackService.getWebhooks).toHaveBeenCalled();
    });

    it("should get single webhook", async () => {
        mockSlackService.getWebhookById.mockResolvedValue({ id: 1 });
        await controller.getWebhook(1);
        expect(mockSlackService.getWebhookById).toHaveBeenCalledWith(1);
    });

    it("should create webhook and log audit", async () => {
        const dto = { name: "alerts", channel: "#ops", url: "https://hooks.slack.com/test" };
        mockSlackService.createWebhook.mockResolvedValue({ id: 1, ...dto });
        await controller.createWebhook(dto as any, mockReq);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "CREATE_SLACK_WEBHOOK", adminId: 1 }),
        );
    });

    it("should update webhook and log audit", async () => {
        const dto = { name: "updated" };
        mockSlackService.updateWebhook.mockResolvedValue({ id: 1 });
        await controller.updateWebhook(1, dto as any, mockReq);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "UPDATE_SLACK_WEBHOOK", resourceId: "1" }),
        );
    });

    it("should delete webhook and log audit", async () => {
        mockSlackService.deleteWebhook.mockResolvedValue(undefined);
        await controller.deleteWebhook(1, mockReq);
        expect(mockAuditLogService.log).toHaveBeenCalledWith(
            expect.objectContaining({ action: "DELETE_SLACK_WEBHOOK", resourceId: "1" }),
        );
    });

    it("should test webhook", async () => {
        mockSlackService.testWebhook.mockResolvedValue({ success: true });
        await controller.testWebhook(1);
        expect(mockSlackService.testWebhook).toHaveBeenCalledWith(1);
    });
});
