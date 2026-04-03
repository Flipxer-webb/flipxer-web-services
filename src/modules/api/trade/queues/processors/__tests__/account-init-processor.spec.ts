jest.mock("@nestjs/bull", () => ({
    Processor: () => () => undefined,
    Process: () => () => undefined,
    InjectQueue: () => () => undefined,
    __esModule: true,
}));

jest.mock("@/modules/api/trade/services", () => ({
    TradingService: class TradingService {},
    __esModule: true,
}));

jest.mock("@/modules/api/trade/events", () => ({
    TradingEvent: class TradingEvent {},
    __esModule: true,
}));

import { QuidaxTradingCryptoAccountInitQueueProcessor } from "../account_init_processor";

describe("QuidaxTradingCryptoAccountInitQueueProcessor", () => {
    const tradingEvent = {} as never;

    let prisma: {
        user: { findUnique: jest.Mock; update: jest.Mock };
    };
    let quidaxService: { createSubAccount: jest.Mock };
    let tradingService: { ensureWalletPaymentAddresses: jest.Mock };

    let processor: QuidaxTradingCryptoAccountInitQueueProcessor;

    beforeEach(() => {
        prisma = {
            user: {
                findUnique: jest.fn(),
                update: jest.fn(),
            },
        };

        quidaxService = {
            createSubAccount: jest.fn(),
        };

        tradingService = {
            ensureWalletPaymentAddresses: jest.fn(),
        };

        processor = new QuidaxTradingCryptoAccountInitQueueProcessor(
            tradingEvent,
            prisma as never,
            quidaxService as never,
            tradingService as never,
        );

        jest.spyOn((processor as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((processor as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((processor as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns user_not_found when user does not exist", async () => {
        prisma.user.findUnique.mockResolvedValue(null);

        await expect(
            processor.processQuidaxAccountCreation({ data: { user_id: 99 } } as never),
        ).resolves.toBe("user_not_found");

        expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 99 } });
        expect((processor as any).logger.warn).toHaveBeenCalled();
    });

    it("returns subaccount_failed when sub-account creation is unsuccessful", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 7, email: "u@x.com", firstName: "A", lastName: "B" });
        quidaxService.createSubAccount.mockResolvedValue({ status: "failed", data: null });

        await expect(
            processor.processQuidaxAccountCreation({ data: { user_id: 7 } } as never),
        ).resolves.toBe("subaccount_failed");

        expect(quidaxService.createSubAccount).toHaveBeenCalledWith({
            email: "u@x.com",
            first_name: "A",
            last_name: "B",
        });
    });

    it("returns no_wallets_created when all ensured address lists are empty", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 4, email: "u@x.com", firstName: "A", lastName: "B" });
        quidaxService.createSubAccount.mockResolvedValue({ status: "success", data: { id: "sub-1" } });
        prisma.user.update.mockResolvedValue({ id: 4 });
        tradingService.ensureWalletPaymentAddresses.mockResolvedValue([]);

        await expect(
            processor.processQuidaxAccountCreation({ data: { user_id: 4 } } as never),
        ).resolves.toBe("no_wallets_created");

        expect(tradingService.ensureWalletPaymentAddresses).toHaveBeenCalledTimes(3);
    });

    it("returns true when at least one wallet address set is created", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 11, email: "u@x.com", firstName: "A", lastName: "B" });
        quidaxService.createSubAccount.mockResolvedValue({ status: "success", data: { id: "sub-11" } });
        prisma.user.update.mockResolvedValue({ id: 11 });

        tradingService.ensureWalletPaymentAddresses.mockImplementation(async ({ assetSymbol }: { assetSymbol: string }) => {
            if (assetSymbol === "BTC") return [{ address: "btc-addr" }];
            if (assetSymbol === "USDT") throw new Error("usdt failed");
            return [];
        });

        await expect(
            processor.processQuidaxAccountCreation({ data: { user_id: 11 } } as never),
        ).resolves.toBe(true);

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: { cryptoSubAccountId: "sub-11" },
        });
        expect((processor as any).logger.error).toHaveBeenCalled();
    });

    it("returns false when unexpected errors occur", async () => {
        prisma.user.findUnique.mockRejectedValue(new Error("db down"));

        await expect(
            processor.processQuidaxAccountCreation({ data: { user_id: 5 } } as never),
        ).resolves.toBe(false);

        expect((processor as any).logger.error).toHaveBeenCalled();
    });
});
