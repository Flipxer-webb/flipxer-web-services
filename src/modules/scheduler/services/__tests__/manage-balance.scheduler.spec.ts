import { CryptoWalletStatus } from "@prisma/client";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class { readonly __stub = true },
    AccountDeletedException: class extends Error {},
    UserNotFoundException: class extends Error {},
    DuplicateUserException: class extends Error {},
    __esModule: true,
}));

import { AssetBalanceSchedulerService } from "../manageBalance";

describe("AssetBalanceSchedulerService", () => {
    let service: AssetBalanceSchedulerService;
    let prisma: {
        user: {
            findMany: jest.Mock;
        };
        cryptoWalletAddress: {
            findMany: jest.Mock;
        };
    };
    let cryptoAccountProducer: {
        enqueueSyncBalance: jest.Mock;
    };
    let tradingService: {
        getGeneratedWalletAddress: jest.Mock;
        walletAddressCreatedSuccessHandler: jest.Mock;
        syncUserDeposits: jest.Mock;
    };

    beforeEach(() => {
        prisma = {
            user: {
                findMany: jest.fn(),
            },
            cryptoWalletAddress: {
                findMany: jest.fn(),
            },
        };

        cryptoAccountProducer = {
            enqueueSyncBalance: jest.fn().mockResolvedValue(undefined),
        };

        tradingService = {
            getGeneratedWalletAddress: jest.fn(),
            walletAddressCreatedSuccessHandler: jest.fn().mockResolvedValue(undefined),
            syncUserDeposits: jest.fn(),
        };

        service = new AssetBalanceSchedulerService(
            prisma as any,
            cryptoAccountProducer as any,
            tradingService as any,
        );
    });

    describe("syncAllQuidaxAssetBalance", () => {
        it("should enqueue balance sync for each user id", async () => {
            jest.spyOn(service, "getAllUserIdsWithSubAccounts").mockResolvedValue([1, 2, 3]);

            await service.syncAllQuidaxAssetBalance();

            expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenCalledTimes(3);
            expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenNthCalledWith(1, 1);
            expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenNthCalledWith(2, 2);
            expect(cryptoAccountProducer.enqueueSyncBalance).toHaveBeenNthCalledWith(3, 3);
        });

        it("should swallow producer errors", async () => {
            jest.spyOn(service, "getAllUserIdsWithSubAccounts").mockResolvedValue([9]);
            cryptoAccountProducer.enqueueSyncBalance.mockRejectedValue(new Error("queue down"));

            await expect(service.syncAllQuidaxAssetBalance()).resolves.toBeUndefined();
        });
    });

    describe("syncWalletAddress", () => {
        it("should return when no pending addresses are found", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);

            await service.syncWalletAddress();

            expect(tradingService.getGeneratedWalletAddress).not.toHaveBeenCalled();
        });

        it("should sync and mark created wallet addresses", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 1,
                    walletAddressId: "wa-1",
                    assetSymbol: "BTC",
                    user: { cryptoSubAccountId: "sub-1" },
                },
            ]);
            tradingService.getGeneratedWalletAddress.mockResolvedValue({
                data: {
                    address: "bc1qtest",
                    total_payments: 3,
                    destination_tag: "memo-1",
                },
            });

            await service.syncWalletAddress();

            expect(tradingService.getGeneratedWalletAddress).toHaveBeenCalledWith({
                address_id: "wa-1",
                user_id: "sub-1",
                currency: "btc",
            });
            expect(tradingService.walletAddressCreatedSuccessHandler).toHaveBeenCalledWith({
                walletAddressId: "wa-1",
                walletAddress: "bc1qtest",
                totalPayments: 3,
                destination_tag: "memo-1",
            });
        });

        it("should skip addresses that are still missing generated wallet values", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 2,
                    walletAddressId: "wa-2",
                    assetSymbol: "ETH",
                    user: { cryptoSubAccountId: "sub-2" },
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

            expect(tradingService.walletAddressCreatedSuccessHandler).not.toHaveBeenCalled();
        });

        it("should swallow per-address sync failures", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 3,
                    walletAddressId: "wa-3",
                    assetSymbol: "USDT",
                    user: { cryptoSubAccountId: "sub-3" },
                },
            ]);
            tradingService.getGeneratedWalletAddress.mockRejectedValue(new Error("quidax error"));

            await expect(service.syncWalletAddress()).resolves.toBeUndefined();
        });

        it("should query all pending wallet addresses", async () => {
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

    describe("getAllUserIdsWithSubAccounts", () => {
        it("should collect ids across paginated batches", async () => {
            const firstBatch = Array.from({ length: 1000 }, (_, idx) => ({ id: idx + 1 }));
            const secondBatch = [{ id: 1001 }, { id: 1002 }];

            prisma.user.findMany
                .mockResolvedValueOnce(firstBatch)
                .mockResolvedValueOnce(secondBatch);

            const ids = await service.getAllUserIdsWithSubAccounts();

            expect(ids.length).toBe(1002);
            expect(ids[0]).toBe(1);
            expect(ids[1001]).toBe(1002);
            expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
            expect(prisma.user.findMany).toHaveBeenLastCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        id: { gt: 1000 },
                    }),
                }),
            );
        });

        it("should return an empty list when no users match", async () => {
            prisma.user.findMany.mockResolvedValue([]);

            const ids = await service.getAllUserIdsWithSubAccounts();

            expect(ids).toEqual([]);
        });
    });

    describe("syncMissedDeposits", () => {
        it("should return when no active users are found", async () => {
            jest.spyOn(service, "getRecentlyActiveUsersWithSubAccounts").mockResolvedValue([]);

            await service.syncMissedDeposits();

            expect(tradingService.syncUserDeposits).not.toHaveBeenCalled();
        });

        it("should sync deposits for active users", async () => {
            jest.spyOn(service, "getRecentlyActiveUsersWithSubAccounts").mockResolvedValue([101, 102]);
            tradingService.syncUserDeposits
                .mockResolvedValueOnce({ data: { synced: 2 } })
                .mockResolvedValueOnce({ data: { synced: 0 } });

            await service.syncMissedDeposits();

            expect(tradingService.syncUserDeposits).toHaveBeenCalledTimes(2);
            expect(tradingService.syncUserDeposits).toHaveBeenNthCalledWith(1, 101);
            expect(tradingService.syncUserDeposits).toHaveBeenNthCalledWith(2, 102);
        });

        it("should tolerate per-user sync failures", async () => {
            jest.spyOn(service, "getRecentlyActiveUsersWithSubAccounts").mockResolvedValue([201, 202]);
            tradingService.syncUserDeposits
                .mockRejectedValueOnce(new Error("sync failed"))
                .mockResolvedValueOnce({ data: { synced: 1 } });

            await expect(service.syncMissedDeposits()).resolves.toBeUndefined();
        });
    });

    describe("getRecentlyActiveUsersWithSubAccounts", () => {
        it("should return user ids for recently active sub-account users", async () => {
            prisma.user.findMany.mockResolvedValue([{ id: 8 }, { id: 9 }]);

            const ids = await service.getRecentlyActiveUsersWithSubAccounts();

            expect(ids).toEqual([8, 9]);
            expect(prisma.user.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        cryptoSubAccountId: { not: null },
                        lastLogin: { gte: expect.any(Date) },
                    }),
                }),
            );
        });
    });
});
