import { BullModuleOptions } from "@nestjs/bull";
import { TradingQueue } from "./interfaces";
import { BullBoardQueueOptions } from "@bull-board/nestjs";
import { BullAdapter } from "@bull-board/api/bullAdapter";
export * from "./interfaces";

export const quidaxTradingOptions: BullModuleOptions = {
    name: TradingQueue.QUIDAX_ACCOUNT_INIT,
    defaultJobOptions: {
        attempts: 3, //If a job fails, retry once more (total 3 attempts).
        delay: 60 * 3 * 1000, //each job execution will be delayed by 3min
        removeOnFail: true, //automatically removes failed jobs.
        removeOnComplete: true, //automatically removes successfully completed jobs.
    },
};

export const quidaxSyncBalanceQueue: BullModuleOptions = {
    name: TradingQueue.QUIDAX_SYNC_BALANCE,
    defaultJobOptions: {
        attempts: 3,
        delay: 10000, // maybe 10 sec delay for balance sync (optional)
        removeOnFail: true,
        removeOnComplete: true,
    },
};

export const quidaxQueueConfig: BullModuleOptions[] = [
    quidaxTradingOptions,
    quidaxSyncBalanceQueue,
];
export const quidaxBoardQueueConfig: BullBoardQueueOptions[] = [
    {
        name: TradingQueue.QUIDAX_ACCOUNT_INIT,
        adapter: BullAdapter,
    },
    {
        name: TradingQueue.QUIDAX_SYNC_BALANCE,
        adapter: BullAdapter,
    },
];
