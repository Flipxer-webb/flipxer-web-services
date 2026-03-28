import { Test, TestingModule } from "@nestjs/testing";

jest.mock("@/modules/api/auth/guard", () => ({
    AuthGuard: class { isStub() { return true; } },
    CountryBlockGuard: class { isStub() { return true; } },
    EnabledAccountGuard: class { isStub() { return true; } },
    __esModule: true,
}));

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    __esModule: true,
}));

import { PriceAlertController } from "../price-alert.controller";
import { PriceAlertService } from "../../../services/price-alert.service";

describe("PriceAlertController", () => {
    let controller: PriceAlertController;
    let priceAlertService: {
        createAlert: jest.Mock;
        getUserAlerts: jest.Mock;
        getAlert: jest.Mock;
        updateAlert: jest.Mock;
        deleteAlert: jest.Mock;
    };

    const user = { id: 7, email: "test@flipxer.com" } as any;

    beforeEach(async () => {
        priceAlertService = {
            createAlert: jest.fn(),
            getUserAlerts: jest.fn(),
            getAlert: jest.fn(),
            updateAlert: jest.fn(),
            deleteAlert: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            controllers: [PriceAlertController],
            providers: [
                { provide: PriceAlertService, useValue: priceAlertService },
            ],
        }).compile();

        controller = module.get(PriceAlertController);
    });

    afterEach(() => jest.clearAllMocks());

    it("should create an alert", async () => {
        const dto = { currency: "BTC", targetPrice: 50000000, direction: "ABOVE" } as any;
        priceAlertService.createAlert.mockResolvedValue({ message: "created" });

        const result = await controller.createAlert(user, dto);

        expect(priceAlertService.createAlert).toHaveBeenCalledWith(user, dto);
        expect(result).toEqual({ message: "created" });
    });

    it("should return all user alerts", async () => {
        priceAlertService.getUserAlerts.mockResolvedValue({ data: [{ id: 1 }] });

        const result = await controller.getAlerts(user);

        expect(priceAlertService.getUserAlerts).toHaveBeenCalledWith(user);
        expect(result.data).toHaveLength(1);
    });

    it("should return a single alert", async () => {
        priceAlertService.getAlert.mockResolvedValue({ data: { id: 12 } });

        const result = await controller.getAlert(user, 12);

        expect(priceAlertService.getAlert).toHaveBeenCalledWith(user, 12);
        expect(result.data.id).toBe(12);
    });

    it("should update an alert", async () => {
        const dto = { isActive: false } as any;
        priceAlertService.updateAlert.mockResolvedValue({ message: "updated" });

        const result = await controller.updateAlert(user, 4, dto);

        expect(priceAlertService.updateAlert).toHaveBeenCalledWith(user, 4, dto);
        expect(result.message).toBe("updated");
    });

    it("should delete an alert", async () => {
        priceAlertService.deleteAlert.mockResolvedValue({ message: "deleted" });

        const result = await controller.deleteAlert(user, 9);

        expect(priceAlertService.deleteAlert).toHaveBeenCalledWith(user, 9);
        expect(result.message).toBe("deleted");
    });
});