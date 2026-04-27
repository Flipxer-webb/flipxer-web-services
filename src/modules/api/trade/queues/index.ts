import { BullModuleOptions } from "@nestjs/bull";
import { TradingQueue } from "./interfaces";
// BullBoard imports removed - package uninstalled
// import { BullBoardQueueOptions } from "@bull-board/nestjs";
// import { BullAdapter } from "@bull-board/api/bullAdapter";
export * from "./interfaces";

export const quidaxTradingOptions: BullModuleOptions = {
    name: TradingQueue.QUIDAX_ACCOUNT_INIT,
    defaultJobOptions: {
        attempts: 3, //If a job fails, retry once more (total 3 attempts).
        delay: 20000, //each job execution will be delayed by 3min
        removeOnFail: true, //automatically removes failed jobs.
        removeOnComplete: true, //automatically removes successfully completed jobs.
    },
};

export const quidaxSyncBalanceQueue: BullModuleOptions = {
    name: TradingQueue.QUIDAX_SYNC_BALANCE,
    limiter: {
        // Wallet balance sync calls Quidax once per user job.
        // Pace the queue so bulk refreshes do not trigger provider throttling.
        max: 1,
        duration: 1000,
    },
    defaultJobOptions: {
        attempts: 3,
        removeOnFail: true,
        removeOnComplete: true,
    },
};

export const quidaxQueueConfig: BullModuleOptions[] = [
    quidaxTradingOptions,
    quidaxSyncBalanceQueue,
];

// BullBoard queue config removed - package uninstalled
// export const quidaxBoardQueueConfig: BullBoardQueueOptions[] = [
//     {
//         name: TradingQueue.QUIDAX_ACCOUNT_INIT,
//         adapter: BullAdapter,
//     },
//     {
//         name: TradingQueue.QUIDAX_SYNC_BALANCE,
//         adapter: BullAdapter,
//     },
// ];
