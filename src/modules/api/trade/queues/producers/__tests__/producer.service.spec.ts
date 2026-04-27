import { CryptoAccountQueueProducer } from "../producer.service";
import { QuidaxTradingQueue } from "../../interfaces";

describe("CryptoAccountQueueProducer", () => {
    it("enqueues account init job", async () => {
        const quidaxCryptoQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const syncBalanceQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const depositSyncQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const service = new CryptoAccountQueueProducer(
            quidaxCryptoQueue as any,
            syncBalanceQueue as any,
            depositSyncQueue as any
        );
        await service.enqueue(42);

        expect(quidaxCryptoQueue.add).toHaveBeenCalledWith(QuidaxTradingQueue.TRADING_ACCOUNT_INIT, {
            user_id: 42,
        });
    });

    it("enqueues sync balance job", async () => {
        const quidaxCryptoQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const syncBalanceQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const depositSyncQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const service = new CryptoAccountQueueProducer(
            quidaxCryptoQueue as any,
            syncBalanceQueue as any,
            depositSyncQueue as any
        );
        await service.enqueueSyncBalance(17);

        expect(syncBalanceQueue.add).toHaveBeenCalledWith(
            QuidaxTradingQueue.SYNC_CRYPTO_BALANCE,
            {
                user_id: 17,
            },
            {
                jobId: "sync-balance:17",
            },
        );
    });

    it("enqueues deposit sync job", async () => {
        const quidaxCryptoQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const syncBalanceQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const depositSyncQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const service = new CryptoAccountQueueProducer(
            quidaxCryptoQueue as any,
            syncBalanceQueue as any,
            depositSyncQueue as any
        );
        await service.enqueueDepositSync(99);

        expect(depositSyncQueue.add).toHaveBeenCalledWith(
            QuidaxTradingQueue.SYNC_USER_DEPOSITS,
            { user_id: 99 },
            { jobId: "sync-deposits:99" },
        );
    });
});