import { MODULE_METADATA } from "@nestjs/common/constants";

jest.mock("../services/wallet-management.service", () => ({
    WalletManagementService: class WalletManagementServiceStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../services/slack-webhook.service", () => ({
    SlackWebhookService: class SlackWebhookServiceStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../services/liquidity-alert.service", () => ({
    LiquidityAlertService: class LiquidityAlertServiceStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/wallet.controller", () => ({
    AdminWalletController: class AdminWalletControllerStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/slack-webhook.controller", () => ({
    AdminSlackWebhookController: class AdminSlackWebhookControllerStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../controllers/v1/admin/liquidity-alert.controller", () => ({
    AdminLiquidityAlertController: class AdminLiquidityAlertControllerStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("../../session", () => ({
    SessionModule: class SessionModuleStub {
        readonly stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/factory/trading", () => ({
    TradingFactoryModule: class TradingFactoryModuleStub {
        readonly stub = true;
    },
    __esModule: true,
}));

import { OperationsModule } from "../index";
import { WalletManagementService } from "../services/wallet-management.service";
import { SlackWebhookService } from "../services/slack-webhook.service";
import { LiquidityAlertService } from "../services/liquidity-alert.service";

describe("OperationsModule", () => {
    it("registers imports, controllers, providers, and exports", () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, OperationsModule) as unknown[];
        const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, OperationsModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, OperationsModule) as unknown[];
        const exportsMeta = Reflect.getMetadata(MODULE_METADATA.EXPORTS, OperationsModule) as unknown[];

        expect(Array.isArray(imports)).toBe(true);
        expect(Array.isArray(controllers)).toBe(true);
        expect(providers).toEqual([
            WalletManagementService,
            SlackWebhookService,
            LiquidityAlertService,
        ]);
        expect(exportsMeta).toEqual([
            WalletManagementService,
            SlackWebhookService,
            LiquidityAlertService,
        ]);
    });
});