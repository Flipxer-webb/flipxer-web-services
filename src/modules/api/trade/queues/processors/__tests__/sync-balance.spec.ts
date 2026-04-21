jest.mock("@nestjs/bull", () => ({
    Processor: () => () => undefined,
    Process: () => () => undefined,
    InjectQueue: () => () => undefined,
    __esModule: true,
}));

import { QuidaxTradingBalanceSyncProcessor } from "../sync_balance";

describe("QuidaxTradingBalanceSyncProcessor", () => {
    let prisma: {
        user: { findUnique: jest.Mock };
        assetWallet: { findMany: jest.Mock; update: jest.Mock };
        cryptoWalletAddress: { findMany: jest.Mock };
    };

    let quidaxService: { getUserWalletList: jest.Mock };
    let processor: QuidaxTradingBalanceSyncProcessor;

    beforeEach(() => {
        prisma = {
            user: { findUnique: jest.fn() },
            assetWallet: { findMany: jest.fn(), update: jest.fn() },
            cryptoWalletAddress: { findMany: jest.fn() },
        };

        quidaxService = {
            getUserWalletList: jest.fn(),
        };

        processor = new QuidaxTradingBalanceSyncProcessor(prisma as never, quidaxService as never);
        jest.spyOn((processor as any).logger, "warn").mockImplementation(() => undefined);
        jest.spyOn((processor as any).logger, "debug").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("returns early when user has no sub-account", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 10, cryptoSubAccountId: null });

        await expect(
            processor.handleSyncBalance({ data: { user_id: 10 } } as never),
        ).resolves.toBeUndefined();

        expect(prisma.assetWallet.findMany).not.toHaveBeenCalled();
        expect(quidaxService.getUserWalletList).not.toHaveBeenCalled();
    });

    it("syncs wallet metadata and activates address when deposit address exists", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 20, cryptoSubAccountId: "sub-20" });
        prisma.assetWallet.findMany.mockResolvedValue([
            { id: 1, userId: 20, quidaxWalletId: "w1", assetCurrency: "USDT" },
            { id: 2, userId: 20, quidaxWalletId: "w2", assetCurrency: "USDC" },
        ]);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);

        quidaxService.getUserWalletList.mockResolvedValue({
            data: [
                {
                    id: "w1",
                    currency: "usdt",
                    blockchain_enabled: true,
                    default_network: "TRON",
                    is_crypto: true,
                    networks: ["TRON"],
                    reference_currency: "USDT",
                    deposit_address: "TD123",
                    destination_tag: null,
                },
                {
                    id: "w2",
                    currency: "usdc",
                    blockchain_enabled: true,
                    default_network: "ERC20",
                    is_crypto: true,
                    networks: ["ERC20"],
                    reference_currency: "USDC",
                    deposit_address: null,
                    destination_tag: "100",
                },
            ],
        });

        await expect(
            processor.handleSyncBalance({ data: { user_id: 20 } } as never),
        ).resolves.toBeUndefined();

        expect(prisma.assetWallet.update).toHaveBeenNthCalledWith(1, {
            where: { id: 1 },
            data: expect.objectContaining({
                depositAddress: "TD123",
                addressSynced: true,
                isActive: true,
            }),
        });

        expect(prisma.assetWallet.update).toHaveBeenNthCalledWith(2, {
            where: { id: 2 },
            data: expect.objectContaining({
                depositAddress: null,
                destinationTag: "100",
                addressSynced: false,
                isActive: false,
            }),
        });
    });

    it("falls back to the active default-network child address when provider wallet address is null", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 21, cryptoSubAccountId: "sub-21" });
        prisma.assetWallet.findMany.mockResolvedValue([
            {
                id: 5,
                userId: 21,
                quidaxWalletId: "w5",
                assetCurrency: "TRX",
                defaultNetwork: "trc20",
            },
        ]);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([
            {
                id: 99,
                assetSymbol: "TRX",
                network: "trc20",
                address: "TChild123",
                destination_tag: null,
                updatedAt: new Date("2026-03-28T10:00:00Z"),
            },
        ]);
        quidaxService.getUserWalletList.mockResolvedValue({
            data: [
                {
                    id: "w5",
                    currency: "trx",
                    blockchain_enabled: true,
                    default_network: "TRON",
                    is_crypto: true,
                    networks: ["TRON"],
                    reference_currency: "USDT",
                    deposit_address: null,
                    destination_tag: null,
                },
            ],
        });

        await expect(
            processor.handleSyncBalance({ data: { user_id: 21 } } as never),
        ).resolves.toBeUndefined();

        expect(prisma.assetWallet.update).toHaveBeenCalledWith({
            where: { id: 5 },
            data: expect.objectContaining({
                depositAddress: "TChild123",
                addressSynced: true,
                isActive: true,
            }),
        });
    });

    it("warns when no update payload is found for an existing wallet", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 30, cryptoSubAccountId: "sub-30" });
        prisma.assetWallet.findMany.mockResolvedValue([
            { id: 3, userId: 30, quidaxWalletId: "wallet-missing", assetCurrency: "BTC" },
        ]);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);
        quidaxService.getUserWalletList.mockResolvedValue({ data: [] });

        await expect(
            processor.handleSyncBalance({ data: { user_id: 30 } } as never),
        ).resolves.toBeUndefined();

        expect((processor as any).logger.debug).toHaveBeenCalled();
        expect(prisma.assetWallet.update).not.toHaveBeenCalled();
    });

    it("handles missing wallet data array by using an empty map", async () => {
        prisma.user.findUnique.mockResolvedValue({ id: 31, cryptoSubAccountId: "sub-31" });
        prisma.assetWallet.findMany.mockResolvedValue([
            { id: 4, userId: 31, quidaxWalletId: "w4", assetCurrency: "ETH" },
        ]);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);
        quidaxService.getUserWalletList.mockResolvedValue({});

        await expect(
            processor.handleSyncBalance({ data: { user_id: 31 } } as never),
        ).resolves.toBeUndefined();

        expect((processor as any).logger.debug).toHaveBeenCalled();
    });
});
