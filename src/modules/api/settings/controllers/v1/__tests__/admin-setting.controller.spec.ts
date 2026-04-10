jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class {
        isStub() {
            return true;
        }
    },
    EnabledAccountGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/role.guard", () => ({
    RoleGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/guards/permission.guard", () => ({
    PermissionGuard: class {
        isStub() {
            return true;
        }
    },
    __esModule: true,
}));

jest.mock("@/modules/api/authorize/decorator", () => ({
    UserTypes: () => () => undefined,
    ADMIN_USER_TYPES: ["SUPER_ADMIN"],
    Permissions: () => () => undefined,
    __esModule: true,
}));

// Prevent auth/service import chains from resolving real user controllers during unit tests.
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

jest.mock("../../../services", () => ({
    SettingService: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

jest.mock("@/modules/api/trade/services/rate.service", () => ({
    RateService: class {
        readonly __stub = true;
    },
    __esModule: true,
}));

import { AdminSettingController } from "../admin";

describe("AdminSettingController", () => {
    let controller: AdminSettingController;
    const mockAuditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const mockReq = { ip: '127.0.0.1', headers: { 'user-agent': 'test' }, user: { id: 1 } } as any;
    let settingService: {
        getCryptoRateList: jest.Mock;
        getCryptoTransactionFeeList: jest.Mock;
        createOrUpdateCryptoRate: jest.Mock;
        createOrUpdateCryptoTransactionFee: jest.Mock;
        getCryptoRateDetail: jest.Mock;
        getCryptoTransactionFeeDetail: jest.Mock;
        deleteCryptoRate: jest.Mock;
        deleteCryptoTransactionFee: jest.Mock;
    };
    let rateService: {
        getAllRates: jest.Mock;
        getStatus: jest.Mock;
        setDynamicRatesEnabled: jest.Mock;
        invalidateUsdtCache: jest.Mock;
    };

    beforeEach(() => {
        settingService = {
            getCryptoRateList: jest.fn(),
            getCryptoTransactionFeeList: jest.fn(),
            createOrUpdateCryptoRate: jest.fn(),
            createOrUpdateCryptoTransactionFee: jest.fn(),
            getCryptoRateDetail: jest.fn(),
            getCryptoTransactionFeeDetail: jest.fn(),
            deleteCryptoRate: jest.fn(),
            deleteCryptoTransactionFee: jest.fn(),
        };

        rateService = {
            getAllRates: jest.fn(),
            getStatus: jest.fn(),
            setDynamicRatesEnabled: jest.fn(),
            invalidateUsdtCache: jest.fn(),
        };

        controller = new AdminSettingController(
            settingService as never,
            rateService as never,
            mockAuditLogService as never,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("returns crypto rates and transaction fee lists", async () => {
        settingService.getCryptoRateList.mockResolvedValue({ rates: ["BTC"] });
        settingService.getCryptoTransactionFeeList.mockResolvedValue({ fees: ["USDT"] });

        await expect(controller.getCryptoRateList()).resolves.toEqual({ rates: ["BTC"] });
        await expect(controller.getCryptoTransactionFees()).resolves.toEqual({ fees: ["USDT"] });
    });

    it("creates and updates crypto rate and fee records", async () => {
        const rateDto = { currency: "BTC", buyRate: 100, sellRate: 110 };
        const feeDto = { currency: "BTC", percentageFee: 1.5 };

        settingService.createOrUpdateCryptoRate.mockResolvedValue({ id: 1 });
        settingService.createOrUpdateCryptoTransactionFee.mockResolvedValue({ id: 2 });

        await controller.createOrUpdateCryptoRate(rateDto as never, mockReq as never);
        await controller.createOrUpdateCryptoTransactionFee(feeDto as never, mockReq as never);

        expect(settingService.createOrUpdateCryptoRate).toHaveBeenCalledWith(rateDto);
        expect(settingService.createOrUpdateCryptoTransactionFee).toHaveBeenCalledWith(feeDto);
    });

    it("gets and deletes crypto rate and fee details", async () => {
        settingService.getCryptoRateDetail.mockResolvedValue({ id: 3 });
        settingService.getCryptoTransactionFeeDetail.mockResolvedValue({ id: 4 });
        settingService.deleteCryptoRate.mockResolvedValue({ deleted: true });
        settingService.deleteCryptoTransactionFee.mockResolvedValue({ deleted: true });

        await expect(controller.getCryptoRateDetail(3)).resolves.toEqual({ id: 3 });
        await expect(controller.getCryptoTransactionFeeDetail(4)).resolves.toEqual({ id: 4 });
        await expect(controller.deleteCryptoRate(3, mockReq as never)).resolves.toEqual({ deleted: true });
        await expect(controller.deleteCryptoTransactionFee(4, mockReq as never)).resolves.toEqual({ deleted: true });
    });

    it("returns calculated rates payload with dynamic status metadata", async () => {
        rateService.getAllRates.mockResolvedValue([{ currency: "BTC", buyRate: 100 }]);
        rateService.getStatus.mockResolvedValue({
            isDynamic: true,
            usdtRate: 1610,
            priceSource: "livecoinwatch",
            lastPriceUpdate: "2026-03-29T00:00:00.000Z",
        });

        const result = await controller.getCalculatedRates();

        expect(result.message).toBe("Calculated rates retrieved");
        expect(result.data.isDynamic).toBe(true);
        expect(result.data.rates).toHaveLength(1);
    });

    it("returns dynamic rate status, toggles feature and invalidates cache", async () => {
        rateService.getStatus.mockResolvedValue({ isDynamic: false, usdtRate: 1600 });

        const statusResult = await controller.getDynamicRatesStatus();
        const toggleOnResult = await controller.toggleDynamicRates({ enabled: true }, mockReq as never);
        const toggleOffResult = await controller.toggleDynamicRates({ enabled: false }, mockReq as never);
        const invalidateResult = await controller.invalidateRateCache(mockReq as never);

        expect(statusResult.message).toBe("Dynamic rates status retrieved");
        expect(toggleOnResult.message).toContain("enabled");
        expect(toggleOffResult.message).toContain("disabled");
        expect(rateService.setDynamicRatesEnabled).toHaveBeenCalledTimes(2);
        expect(rateService.invalidateUsdtCache).toHaveBeenCalledTimes(1);
        expect(invalidateResult.message).toBe("USDT rate cache invalidated");
    });
});