import { CryptoAccountQueueProducer } from "../producer.service";
import { QuidaxTradingQueue } from "../../interfaces";

describe("CryptoAccountQueueProducer", () => {
    it("enqueues account init job", async () => {
        const quidaxCryptoQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const syncBalanceQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const service = new CryptoAccountQueueProducer(quidaxCryptoQueue as any, syncBalanceQueue as any);
        await service.enqueue(42);

        expect(quidaxCryptoQueue.add).toHaveBeenCalledWith(QuidaxTradingQueue.TRADING_ACCOUNT_INIT, {
            user_id: 42,
        });
    });

    it("enqueues sync balance job", async () => {
        const quidaxCryptoQueue = { add: jest.fn().mockResolvedValue(undefined) };
        const syncBalanceQueue = { add: jest.fn().mockResolvedValue(undefined) };

        const service = new CryptoAccountQueueProducer(quidaxCryptoQueue as any, syncBalanceQueue as any);
        await service.enqueueSyncBalance(17);

        expect(syncBalanceQueue.add).toHaveBeenCalledWith(QuidaxTradingQueue.SYNC_CRYPTO_BALANCE, {
            user_id: 17,
        });
    });
});