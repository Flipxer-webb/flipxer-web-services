import { CryptoWalletStatus } from "@prisma/client";

jest.mock("@/modules/api/user", () => ({
    User: () => () => {},
    ClientData: () => () => {},
    UserModule: class {
        readonly __stub = true;
    },
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
            update: jest.Mock;
        };
    };
    let cryptoAccountProducer: {
        enqueueSyncBalance: jest.Mock;
        enqueueDepositSync: jest.Mock;
    };
    let tradingService: {
        getGeneratedWalletAddress: jest.Mock;
        walletAddressCreatedSuccessHandler: jest.Mock;
        syncUserDeposits: jest.Mock;
    };
    let distributedLockService: {
        acquireLock: jest.Mock;
        releaseLock: jest.Mock;
    };

    beforeEach(() => {
        prisma = {
            user: {
                findMany: jest.fn(),
            },
            cryptoWalletAddress: {
                findMany: jest.fn(),
                update: jest.fn(),
            },
        };

        cryptoAccountProducer = {
            enqueueSyncBalance: jest.fn().mockResolvedValue(undefined),
            enqueueDepositSync: jest.fn().mockResolvedValue(undefined),
        };

        tradingService = {
            getGeneratedWalletAddress: jest.fn(),
            walletAddressCreatedSuccessHandler: jest
                .fn()
                .mockResolvedValue(undefined),
            syncUserDeposits: jest.fn(),
        };

        distributedLockService = {
            acquireLock: jest.fn().mockResolvedValue("lock-token"),
            releaseLock: jest.fn().mockResolvedValue(true),
        };

        service = new AssetBalanceSchedulerService(
            prisma as any,
            cryptoAccountProducer as any,
            tradingService as any,
            distributedLockService as any,
        );
    });

    describe("syncAllQuidaxAssetBalance", () => {
        it("should enqueue balance sync for each user id", async () => {
            jest.spyOn(
                service,
                "getEligibleUserIdsForBalanceSync",
            ).mockResolvedValue([1, 2, 3]);

            await service.syncAllQuidaxAssetBalance();

            expect(
                cryptoAccountProducer.enqueueSyncBalance,
            ).toHaveBeenCalledTimes(3);
            expect(
                cryptoAccountProducer.enqueueSyncBalance,
            ).toHaveBeenNthCalledWith(1, 1);
            expect(
                cryptoAccountProducer.enqueueSyncBalance,
            ).toHaveBeenNthCalledWith(2, 2);
            expect(
                cryptoAccountProducer.enqueueSyncBalance,
            ).toHaveBeenNthCalledWith(3, 3);
            expect(distributedLockService.acquireLock).toHaveBeenCalledWith(
                "job:quidax-balance-sync:process",
                expect.objectContaining({ maxWaitMs: 0, strict: true }),
            );
            expect(distributedLockService.releaseLock).toHaveBeenCalledWith(
                "job:quidax-balance-sync:process",
                "lock-token",
            );
        });

        it("should swallow producer errors", async () => {
            jest.spyOn(
                service,
                "getEligibleUserIdsForBalanceSync",
            ).mockResolvedValue([9]);
            cryptoAccountProducer.enqueueSyncBalance.mockRejectedValue(
                new Error("queue down"),
            );

            await expect(
                service.syncAllQuidaxAssetBalance(),
            ).resolves.toBeUndefined();
        });

        it("should skip queueing when the distributed lock is already held", async () => {
            distributedLockService.acquireLock.mockResolvedValueOnce(null);

            await service.syncAllQuidaxAssetBalance();

            expect(
                cryptoAccountProducer.enqueueSyncBalance,
            ).not.toHaveBeenCalled();
            expect(distributedLockService.releaseLock).not.toHaveBeenCalled();
        });
    });

    describe("syncWalletAddress", () => {
        it("should return when no pending addresses are found", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([]);

            await service.syncWalletAddress();

            expect(
                tradingService.getGeneratedWalletAddress,
            ).not.toHaveBeenCalled();
        });

        it("should sync and mark created wallet addresses", async () => {
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 1,
                    walletAddressId: "wa-1",
                    assetSymbol: "BTC",
                    updatedAt: new Date("2026-04-21T17:00:00Z"),
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

            expect(
                tradingService.getGeneratedWalletAddress,
            ).toHaveBeenCalledWith({
                address_id: "wa-1",
                user_id: "sub-1",
                currency: "btc",
            });
            expect(
                tradingService.walletAddressCreatedSuccessHandler,
            ).toHaveBeenCalledWith({
                walletAddressId: "wa-1",
                walletAddress: "bc1qtest",
                totalPayments: 3,
                destination_tag: "memo-1",
            });
        });

        it("should skip addresses that are still missing generated wallet values", async () => {
            // Pin "now" within the 30-minute stale window so the stale-cleanup branch does not fire.
            const nowSpy = jest
                .spyOn(Date, "now")
                .mockReturnValue(new Date("2026-04-21T18:00:00Z").getTime());
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 2,
                    walletAddressId: "wa-2",
                    assetSymbol: "ETH",
                    updatedAt: new Date("2026-04-21T17:45:00Z"),
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

            expect(
                tradingService.walletAddressCreatedSuccessHandler,
            ).not.toHaveBeenCalled();
            expect(prisma.cryptoWalletAddress.update).not.toHaveBeenCalled();

            nowSpy.mockRestore();
        });

        it("should mark stale null provider responses as failed", async () => {
            const nowSpy = jest
                .spyOn(Date, "now")
                .mockReturnValue(new Date("2026-04-21T18:00:00Z").getTime());
            prisma.cryptoWalletAddress.findMany.mockResolvedValue([
                {
                    id: 4,
                    walletAddressId: "wa-4",
                    assetSymbol: "USDT",
                    updatedAt: new Date("2026-04-21T17:20:00Z"),
                    user: { cryptoSubAccountId: "sub-4" },
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
                where: { id: 4 },
                data: { status: CryptoWalletStatus.FAILED },
            });
            expect(
                tradingService.walletAddressCreatedSuccessHandler,
            ).not.toHaveBeenCalled();

            nowSpy.mockRestore();
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
            tradingService.getGeneratedWalletAddress.mockRejectedValue(
                new Error("quidax error"),
            );

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

    describe("getEligibleUserIdsForBalanceSync", () => {
        it("should collect ids across paginated eligible batches", async () => {
            const firstBatch = Array.from({ length: 1000 }, (_, idx) => ({
                id: idx + 1,
            }));
            const secondBatch = [{ id: 1001 }, { id: 1002 }];

            prisma.user.findMany
                .mockResolvedValueOnce(firstBatch)
                .mockResolvedValueOnce(secondBatch);

            const ids = await service.getEligibleUserIdsForBalanceSync();

            expect(ids.length).toBe(1002);
            expect(ids[0]).toBe(1);
            expect(ids[1001]).toBe(1002);
            expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
            expect(prisma.user.findMany).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    where: expect.objectContaining({
                        cryptoSubAccountId: { not: null },
                        OR: [
                            { lastLogin: { gte: expect.any(Date) } },
                            { createdAt: { gte: expect.any(Date) } },
                        ],
                    }),
                }),
            );
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

            const ids = await service.getEligibleUserIdsForBalanceSync();

            expect(ids).toEqual([]);
        });
    });

    describe("syncMissedDeposits", () => {
        it("should return when no active users are found", async () => {
            jest.spyOn(
                service,
                "getRecentlyActiveUsersWithSubAccounts",
            ).mockResolvedValue([]);

            await service.syncMissedDeposits();

            expect(
                cryptoAccountProducer.enqueueDepositSync,
            ).not.toHaveBeenCalled();
        });

        it("should enqueue deposit sync for active users", async () => {
            jest.spyOn(
                service,
                "getRecentlyActiveUsersWithSubAccounts",
            ).mockResolvedValue([101, 102]);

            await service.syncMissedDeposits();

            expect(
                cryptoAccountProducer.enqueueDepositSync,
            ).toHaveBeenCalledTimes(2);
            expect(
                cryptoAccountProducer.enqueueDepositSync,
            ).toHaveBeenNthCalledWith(1, 101);
            expect(
                cryptoAccountProducer.enqueueDepositSync,
            ).toHaveBeenNthCalledWith(2, 102);
        });

        it("should tolerate per-user enqueue failures", async () => {
            jest.spyOn(
                service,
                "getRecentlyActiveUsersWithSubAccounts",
            ).mockResolvedValue([201, 202]);
            cryptoAccountProducer.enqueueDepositSync
                .mockRejectedValueOnce(new Error("queue down"))
                .mockResolvedValueOnce(undefined);

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
