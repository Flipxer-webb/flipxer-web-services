jest.mock("@/utils/api-response-util", () => ({
    buildResponse: jest.fn((payload) => payload),
    __esModule: true,
}));

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class AuthGuard {
        readonly __stub = true;
    },
    EnabledAccountGuard: class EnabledAccountGuard {
        readonly __stub = true;
    },
    SocketAuthGuard: class SocketAuthGuard {
        readonly __stub = true;
    },
    CountryBlockGuard: class CountryBlockGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class RoleGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class PermissionGuard {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    Permissions: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => undefined,
    ClientData: () => () => undefined,
    UserModule: class UserModuleStub {
        readonly __stub = true;
    },
    AccountDeletedException: class AccountDeletedException extends Error {},
    UserNotFoundException: class UserNotFoundException extends Error {},
    __esModule: true,
}));

import { AuditLogService } from "@/modules/api/audit-log";
import * as adminExports from "../index";
import { AdminWalletController } from "../wallet.controller";
import { AdminSlackWebhookController } from "../slack-webhook.controller";
import { AdminLiquidityAlertController } from "../liquidity-alert.controller";

describe("Operations admin controllers", () => {
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' }, user: { id: 1 } } as any;

    it("re-exports admin controller classes", () => {
        expect(adminExports.AdminWalletController).toBe(AdminWalletController);
        expect(adminExports.AdminSlackWebhookController).toBe(AdminSlackWebhookController);
        expect(adminExports.AdminLiquidityAlertController).toBe(AdminLiquidityAlertController);
    });

    it("delegates wallet controller endpoints", async () => {
        const walletService = {
            getWalletBalances: jest.fn().mockResolvedValue([{ currency: "USDT" }]),
            getWalletBalance: jest.fn().mockResolvedValue({ currency: "BTC" }),
            getWalletStatistics: jest.fn().mockResolvedValue({ totalWallets: 3 }),
            getLiquidityThresholds: jest.fn().mockResolvedValue([{ currency: "BTC", min: 1 }]),
            updateLiquidityThresholds: jest.fn().mockResolvedValue({ updated: 1 }),
            checkLiquidityThresholds: jest.fn().mockResolvedValue({ breaches: [] }),
            invalidateWalletCache: jest.fn().mockResolvedValue(undefined),
        };
        const controller = new AdminWalletController(walletService as any, mockAuditLogService as any);

        await expect(controller.getWalletBalances()).resolves.toEqual(expect.objectContaining({ data: [{ currency: "USDT" }] }));
        await expect(controller.getWalletBalance("btc")).resolves.toEqual(expect.objectContaining({ data: { currency: "BTC" } }));
        await expect(controller.getWalletStatistics()).resolves.toEqual(expect.objectContaining({ data: { totalWallets: 3 } }));
        await expect(controller.getLiquidityThresholds()).resolves.toEqual(expect.objectContaining({ data: [{ currency: "BTC", min: 1 }] }));
        await expect(controller.updateLiquidityThresholds([{ currency: "BTC", min: 2 }] as never, { id: 7 } as never)).resolves.toEqual(expect.objectContaining({ data: { updated: 1 } }));
        await expect(controller.checkLiquidityThresholds()).resolves.toEqual(expect.objectContaining({ data: { breaches: [] } }));
        await expect(controller.invalidateCache({ id: 7 } as never)).resolves.toEqual(expect.objectContaining({ message: "Wallet cache invalidated successfully" }));
    });

    it("delegates slack webhook controller endpoints", async () => {
        const slackService = {
            getWebhooks: jest.fn().mockResolvedValue([{ id: 1 }]),
            getWebhookById: jest.fn().mockResolvedValue({ id: 1 }),
            createWebhook: jest.fn().mockResolvedValue({ id: 2 }),
            updateWebhook: jest.fn().mockResolvedValue({ id: 3 }),
            deleteWebhook: jest.fn().mockResolvedValue(undefined),
            testWebhook: jest.fn().mockResolvedValue({ success: true }),
        };
        const controller = new AdminSlackWebhookController(slackService as any, mockAuditLogService as any);

        await expect(controller.getWebhooks()).resolves.toEqual(expect.objectContaining({ data: [{ id: 1 }] }));
        await expect(controller.getWebhook(1)).resolves.toEqual(expect.objectContaining({ data: { id: 1 } }));
        await expect(controller.createWebhook({ name: "x" } as never, mockReq as never)).resolves.toEqual(expect.objectContaining({ data: { id: 2 } }));
        await expect(controller.updateWebhook(3, { name: "y" } as never, mockReq as never)).resolves.toEqual(expect.objectContaining({ data: { id: 3 } }));
        await expect(controller.deleteWebhook(4, mockReq as never)).resolves.toEqual(expect.objectContaining({ message: "Webhook deleted successfully" }));
        await expect(controller.testWebhook(9)).resolves.toEqual(expect.objectContaining({ data: { success: true } }));
    });

    it("delegates liquidity alert controller endpoints", async () => {
        const alertService = {
            getAlerts: jest.fn().mockResolvedValue({ rows: [] }),
            getPendingAlertsSummary: jest.fn().mockResolvedValue({ pending: 0 }),
            getAlertStatistics: jest.fn().mockResolvedValue({ total: 0 }),
            createAlert: jest.fn().mockResolvedValue({ id: 11 }),
            runLiquidityCheck: jest.fn().mockResolvedValue({ checked: true }),
            acknowledgeAlert: jest.fn().mockResolvedValue({ acknowledged: true }),
            resolveAlert: jest.fn().mockResolvedValue({ resolved: true }),
            escalateAlert: jest.fn().mockResolvedValue({ escalated: true }),
        };
        const controller = new AdminLiquidityAlertController(alertService as any, mockAuditLogService as any);

        await expect(controller.getAlerts("PENDING", "BTC", "LOW", "2026-01-01", "2026-01-31", 2, 10)).resolves.toEqual({ rows: [] });
        await expect(controller.getPendingAlertsSummary()).resolves.toEqual({ pending: 0 });
        await expect(controller.getAlertStatistics()).resolves.toEqual({ total: 0 });
        await expect(controller.createAlert({ currency: "BTC" } as never, { id: 5 } as never)).resolves.toEqual({ id: 11 });
        await expect(controller.runLiquidityCheck({ id: 5 } as never)).resolves.toEqual({ checked: true });
        await expect(controller.acknowledgeAlert(1, { id: 5 } as never)).resolves.toEqual({ acknowledged: true });
        await expect(controller.resolveAlert(1, { id: 5 } as never, { resolution: "fixed" } as never)).resolves.toEqual({ resolved: true });
        await expect(controller.escalateAlert(1, { id: 5 } as never)).resolves.toEqual({ escalated: true });
    });
});
