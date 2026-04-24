// Break circular dependency while importing trade services from scheduler modules.
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

import { CryptoWalletStatus } from "@prisma/client";

import { AssetBalanceSchedulerService } from "../manageBalance";

describe("AssetBalanceSchedulerService", () => {
    const prisma = {
        user: {
            findMany: jest.fn(),
        },
        cryptoWalletAddress: {
            findMany: jest.fn(),
            update: jest.fn(),
        },
    };

    const cryptoAccountProducer = {
        enqueueSyncBalance: jest.fn(),
    };

    const tradingService = {
        getGeneratedWalletAddress: jest.fn(),
        walletAddressCreatedSuccessHandler: jest.fn(),
        syncUserDeposits: jest.fn(),
    };

    let service: AssetBalanceSchedulerService;

    beforeEach(() => {
        jest.resetAllMocks();
        service = new AssetBalanceSchedulerService(
            prisma as never,
            cryptoAccountProducer as never,
            tradingService as never,
        );

        jest.spyOn((service as any).logger, "debug").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "log").mockImplementation(() => undefined);
        jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("syncAllQuidaxAssetBalance enqueues users and releases lock", async () => {
        const release = jest.fn();
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);
        jest.spyOn(service, "getAllUserIdsWithSubAccounts").mockResolvedValue([1, 2, 3]);

        await service.syncAllQuidaxAssetBalance();

        expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenCalledTimes(3);
        expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenCalledWith(1);
        expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenCalledWith(2);
        expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenCalledWith(3);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("syncAllQuidaxAssetBalance still releases lock when queueing fails", async () => {
        const release = jest.fn();
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);
        jest.spyOn(service, "getAllUserIdsWithSubAccounts").mockResolvedValue([1]);
        cryptoAccountProducer.enqueueSyncBalance.mockRejectedValue(new Error("queue down"));

        await service.syncAllQuidaxAssetBalance();

        expect(release).toHaveBeenCalledTimes(1);
    });

    it("syncWalletAddress updates wallet when provider returns address", async () => {
        const release = jest.fn();
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);

        prisma.cryptoWalletAddress.findMany.mockResolvedValue([
            {
                id: 11,
                walletAddressId: "addr-1",
                assetSymbol: "BTC",
                updatedAt: new Date("2026-04-21T17:00:00Z"),
                user: { cryptoSubAccountId: "sub-1" },
            },
            {
                id: 12,
                walletAddressId: "addr-2",
                assetSymbol: "ETH",
                updatedAt: new Date("2026-04-21T17:00:00Z"),
                user: { cryptoSubAccountId: null },
            },
        ]);

        tradingService.getGeneratedWalletAddress.mockResolvedValue({
            data: {
                address: "bc1wallet",
                total_payments: 2,
                destination_tag: "memo",
            },
        });

        await service.syncWalletAddress();

        expect(tradingService.getGeneratedWalletAddress).toHaveBeenCalledWith({
            address_id: "addr-1",
            user_id: "sub-1",
            currency: "btc",
        });
        expect(tradingService.walletAddressCreatedSuccessHandler).toHaveBeenCalledWith({
            walletAddressId: "addr-1",
            walletAddress: "bc1wallet",
            totalPayments: 2,
            destination_tag: "memo",
        });
        expect(prisma.cryptoWalletAddress.update).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("syncWalletAddress marks long-lived null provider addresses as failed", async () => {
        const release = jest.fn();
        const nowSpy = jest.spyOn(Date, "now").mockReturnValue(
            new Date("2026-04-21T18:00:00Z").getTime()
        );
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);

        prisma.cryptoWalletAddress.findMany.mockResolvedValue([
            {
                id: 13,
                walletAddressId: "addr-3",
                assetSymbol: "USDC",
                updatedAt: new Date("2026-04-21T17:20:00Z"),
                user: { cryptoSubAccountId: "sub-3" },
            },
        ]);

        tradingService.getGeneratedWalletAddress.mockResolvedValue({
            data: {
                address: null,
                total_payments: 0,
                destination_tag: null,
            },
        });

        await service.syncWalletAddress();

        expect(prisma.cryptoWalletAddress.update).toHaveBeenCalledWith({
            where: { id: 13 },
            data: { status: CryptoWalletStatus.FAILED },
        });
        expect(tradingService.walletAddressCreatedSuccessHandler).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);

        nowSpy.mockRestore();
    });

    it("syncWalletAddress exits early when there are no pending addresses", async () => {
        const release = jest.fn();
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);

        await service.syncWalletAddress();

        expect(tradingService.getGeneratedWalletAddress).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("getAllUserIdsWithSubAccounts paginates until exhausted", async () => {
        const firstBatch = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 }));
        const secondBatch = [{ id: 1001 }, { id: 1002 }];

        prisma.user.findMany
            .mockResolvedValueOnce(firstBatch)
            .mockResolvedValueOnce(secondBatch)
            .mockResolvedValueOnce([]);

        const result = await service.getAllUserIdsWithSubAccounts();

        expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
        expect(result).toHaveLength(1002);
        expect(result[0]).toBe(1);
        expect(result.at(-1)).toBe(1002);
    });

    it("syncMissedDeposits syncs active users and tracks failures", async () => {
        const release = jest.fn();
        (service as any).depositSyncMutex.acquire = jest
            .fn()
            .mockResolvedValue(release);

        jest.spyOn(service, "getRecentlyActiveUsersWithSubAccounts").mockResolvedValue([1, 2, 3]);

        tradingService.syncUserDeposits
            .mockResolvedValueOnce({ data: { synced: 2 } })
            .mockRejectedValueOnce(new Error("provider timeout"))
            .mockResolvedValueOnce({ data: { synced: 1 } });

        await service.syncMissedDeposits();

        expect(tradingService.syncUserDeposits).toHaveBeenCalledTimes(3);
        expect(tradingService.syncUserDeposits).toHaveBeenCalledWith(1);
        expect(tradingService.syncUserDeposits).toHaveBeenCalledWith(2);
        expect(tradingService.syncUserDeposits).toHaveBeenCalledWith(3);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("syncMissedDeposits returns early when no active users exist", async () => {
        const release = jest.fn();
        (service as any).depositSyncMutex.acquire = jest
            .fn()
            .mockResolvedValue(release);

        jest.spyOn(service, "getRecentlyActiveUsersWithSubAccounts").mockResolvedValue([]);

        await service.syncMissedDeposits();

        expect(tradingService.syncUserDeposits).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(1);
    });

    it("getRecentlyActiveUsersWithSubAccounts returns mapped ids", async () => {
        prisma.user.findMany.mockResolvedValue([{ id: 77 }, { id: 99 }]);

        const result = await service.getRecentlyActiveUsersWithSubAccounts();

        expect(prisma.user.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    cryptoSubAccountId: { not: null },
                }),
                take: 500,
            }),
        );
        expect(result).toEqual([77, 99]);
    });

    it("syncWalletAddress queries only pending wallet records", async () => {
        const release = jest.fn();
        (service as any).mutex.acquire = jest.fn().mockResolvedValue(release);
        prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);

        await service.syncWalletAddress();

        expect(prisma.cryptoWalletAddress.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: CryptoWalletStatus.PENDING,
                }),
            }),
        );
    });
});
