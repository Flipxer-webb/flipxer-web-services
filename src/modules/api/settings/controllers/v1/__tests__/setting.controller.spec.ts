jest.mock("@nestjs/common", () => {
    const actual = jest.requireActual("@nestjs/common");
    return {
        ...actual,
        UseGuards: () => () => undefined,
        UsePipes: () => () => undefined,
    };
});

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        canActivate() {
            return true;
        }
    },
    EnabledAccountGuard: class {
        canActivate() {
            return true;
        }
    },
    CountryBlockGuard: class {
        canActivate() {
            return true;
        }
    },
    SocketAuthGuard: class {
        canActivate() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {
        readonly __stub = true;
    },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

jest.mock("@/modules/core/rate-limit/guards/rate-limiter.guard", () => ({
    RATE_LIMIT_KEY: "rateLimit",
    RateLimiterGuard: class {
        isStub() {
            return true;
        }
    },
    RateLimit: (options: unknown) => {
        const { SetMetadata } = jest.requireActual("@nestjs/common");
        return SetMetadata("rateLimit", options);
    },
    StrictRateLimit: () => () => undefined,
    __esModule: true,
}));

import {
    settingsSecuritySendOtpRateLimit,
    settingsSecuritySendOtpWindowSeconds,
    settingsSecurityVerifyRateLimit,
    settingsSecurityVerifyWindowSeconds,
} from "@/config";
import { RATE_LIMIT_KEY } from "@/modules/core/rate-limit/guards/rate-limiter.guard";
import { SettingController } from "../index";

describe("SettingController", () => {
    let controller: SettingController;
    let settingService: {
        getCryptoTransactionFeesCategories: jest.Mock;
        getCryptoTransactionFeeList: jest.Mock;
        getCryptoTransactionFeePerAsset: jest.Mock;
        get2FAStatus: jest.Mock;
        setup2FA: jest.Mock;
        enable2FA: jest.Mock;
        disable2FA: jest.Mock;
        verify2FAForTransaction: jest.Mock;
        getSecurityPreferences: jest.Mock;
        updateSecurityPreferences: jest.Mock;
        setTradingPassword: jest.Mock;
        generateNewBackupCodes: jest.Mock;
        getBackupCodesCount: jest.Mock;
        sendTransactionOtp: jest.Mock;
        verifySecurityMethod: jest.Mock;
        getTransactionSecurityRequirements: jest.Mock;
    };
    let rateService: {
        getAllRates: jest.Mock;
        getAssetRate: jest.Mock;
    };

    const user = { id: 12 } as any;

    beforeEach(() => {
        settingService = {
            getCryptoTransactionFeesCategories: jest.fn(),
            getCryptoTransactionFeeList: jest.fn(),
            getCryptoTransactionFeePerAsset: jest.fn(),
            get2FAStatus: jest.fn(),
            setup2FA: jest.fn(),
            enable2FA: jest.fn(),
            disable2FA: jest.fn(),
            verify2FAForTransaction: jest.fn(),
            getSecurityPreferences: jest.fn(),
            updateSecurityPreferences: jest.fn(),
            setTradingPassword: jest.fn(),
            generateNewBackupCodes: jest.fn(),
            getBackupCodesCount: jest.fn(),
            sendTransactionOtp: jest.fn(),
            verifySecurityMethod: jest.fn(),
            getTransactionSecurityRequirements: jest.fn(),
        };

        rateService = {
            getAllRates: jest.fn(),
            getAssetRate: jest.fn(),
        };

        controller = new SettingController(
            settingService as never,
            rateService as never,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("maps dynamic crypto rates list and per-asset payloads", async () => {
        rateService.getAllRates.mockResolvedValue([
            { currency: "BTC", buyRate: 100, sellRate: 120, lastUpdated: "2026-03-29T00:00:00.000Z" },
        ]);
        rateService.getAssetRate.mockResolvedValue({
            currency: "ETH",
            buyRate: 200,
            sellRate: 230,
            lastUpdated: "2026-03-29T00:00:00.000Z",
        });

        const list = await controller.getCryptoRateList();
        const single = await controller.getCryptoRatePerAsset("ETH");

        expect(list.message).toBe("Crypto rate list retrieved");
        expect(list.data[0]).toEqual(
            expect.objectContaining({
                id: 0,
                currency: "BTC",
                buyRate: 100,
                sellRate: 120,
            }),
        );
        expect(single.data).toEqual(
            expect.objectContaining({
                id: 0,
                currency: "ETH",
                buyRate: 200,
                sellRate: 230,
            }),
        );
    });

    it("delegates transaction-fee endpoints", async () => {
        settingService.getCryptoTransactionFeesCategories.mockResolvedValue({ categories: ["withdrawal"] });
        settingService.getCryptoTransactionFeeList.mockResolvedValue({ fees: ["BTC"] });
        settingService.getCryptoTransactionFeePerAsset.mockResolvedValue({ asset: "BTC", fee: 0.2 });

        await expect(controller.getCryptoTransactionFeesCategories()).resolves.toEqual({ categories: ["withdrawal"] });
        await expect(controller.getCryptoTransactionFees()).resolves.toEqual({ fees: ["BTC"] });
        await expect(
            controller.getCryptoTransactionFeePerAsset("BTC", { category: "withdrawal" } as any),
        ).resolves.toEqual({ asset: "BTC", fee: 0.2 });

        expect(settingService.getCryptoTransactionFeePerAsset).toHaveBeenCalledWith(
            { category: "withdrawal" },
            "BTC",
        );
    });

    it("delegates 2FA and security preference endpoints", async () => {
        settingService.get2FAStatus.mockResolvedValue({ enabled: false });
        settingService.setup2FA.mockResolvedValue({ qrCode: "otpauth://..." });
        settingService.enable2FA.mockResolvedValue({ enabled: true });
        settingService.disable2FA.mockResolvedValue({ enabled: false });
        settingService.verify2FAForTransaction.mockResolvedValue({ valid: true });
        settingService.getSecurityPreferences.mockResolvedValue({ method: "2FA" });
        settingService.updateSecurityPreferences.mockResolvedValue({ method: "OTP" });
        settingService.setTradingPassword.mockResolvedValue({ updated: true });
        settingService.generateNewBackupCodes.mockResolvedValue({ count: 5 });
        settingService.getBackupCodesCount.mockResolvedValue({ count: 8 });

        await expect(controller.get2FAStatus(user)).resolves.toEqual({ enabled: false });
        await expect(controller.setup2FA(user)).resolves.toEqual({ qrCode: "otpauth://..." });
        await expect(controller.enable2FA(user, { token: "111111" } as any)).resolves.toEqual({ enabled: true });
        await expect(controller.disable2FA(user, { token: "111111" } as any)).resolves.toEqual({ enabled: false });
        await expect(controller.verify2FA(user, { token: "111111" } as any)).resolves.toEqual({ valid: true });
        await expect(controller.getSecurityPreferences(user)).resolves.toEqual({ method: "2FA" });
        await expect(
            controller.updateSecurityPreferences(user, { transactionMethod: "OTP" } as any),
        ).resolves.toEqual({ method: "OTP" });
        await expect(controller.setTradingPassword(user, { password: "Aaa123456!" } as any)).resolves.toEqual({ updated: true });
        await expect(controller.generateBackupCodes(user)).resolves.toEqual({ count: 5 });
        await expect(controller.getBackupCodesCount(user)).resolves.toEqual({ count: 8 });
    });

    it("handles otp send, unified security verification and requirements parsing", async () => {
        settingService.sendTransactionOtp.mockResolvedValue({ sent: true });
        settingService.verifySecurityMethod.mockResolvedValue({ verified: true, method: "OTP" });
        settingService.getTransactionSecurityRequirements.mockResolvedValue({ requiredMethods: ["OTP"] });

        await expect(
            controller.sendTransactionOtp(user, { method: "OTP" } as any),
        ).resolves.toEqual({ sent: true });

        expect(settingService.sendTransactionOtp).toHaveBeenCalledWith(user, "OTP");

        const verify = await controller.verifySecurityMethod(user, {
            method: "OTP",
            code: "123456",
        } as any);
        expect(verify).toEqual({
            success: true,
            message: "Verification successful",
            data: { verified: true, method: "OTP" },
        });

        await controller.getTransactionSecurityRequirements(user, "1200.50");
        await controller.getTransactionSecurityRequirements(user, "not-a-number");

        expect(settingService.getTransactionSecurityRequirements).toHaveBeenNthCalledWith(1, user, 1200.5);
        expect(settingService.getTransactionSecurityRequirements).toHaveBeenNthCalledWith(2, user, 0);
    });

    it("applies settings-specific rate limits to otp send and verify endpoints", () => {
        const sendOtpRateLimit = Reflect.getMetadata(
            RATE_LIMIT_KEY,
            SettingController.prototype.sendTransactionOtp,
        );
        const verifyRateLimit = Reflect.getMetadata(
            RATE_LIMIT_KEY,
            SettingController.prototype.verifySecurityMethod,
        );

        expect(sendOtpRateLimit).toEqual({
            limit: settingsSecuritySendOtpRateLimit,
            windowSeconds: settingsSecuritySendOtpWindowSeconds,
            failOpen: false,
        });
        expect(verifyRateLimit).toEqual({
            limit: settingsSecurityVerifyRateLimit,
            windowSeconds: settingsSecurityVerifyWindowSeconds,
            failOpen: false,
        });
    });
});
