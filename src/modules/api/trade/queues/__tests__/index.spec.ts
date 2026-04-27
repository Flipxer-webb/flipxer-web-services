import { quidaxSyncBalanceQueue } from "..";
import { TradingQueue } from "../interfaces";

describe("quidaxSyncBalanceQueue", () => {
    it("paces balance sync jobs to avoid wallet-list bursts", () => {
        expect(quidaxSyncBalanceQueue).toEqual(
            expect.objectContaining({
                name: TradingQueue.QUIDAX_SYNC_BALANCE,
                limiter: {
                    max: 1,
                    duration: 1000,
                },
            }),
        );
    });
});