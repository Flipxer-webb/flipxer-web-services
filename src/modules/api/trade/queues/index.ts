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
        // Exponential backoff so retries don't immediately re-hit Quidax
        // when it returns a throttling response (HTTP 429/444).
        // Delays: 5s, 10s, 20s.
        backoff: { type: "exponential", delay: 5000 },
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
        // Same throttle-aware backoff as the account-init queue.
        backoff: { type: "exponential", delay: 5000 },
        removeOnFail: true,
        removeOnComplete: true,
    },
};

export const quidaxDepositSyncQueue: BullModuleOptions = {
    name: TradingQueue.QUIDAX_DEPOSIT_SYNC,
    limiter: {
        // Deposit sync may issue multiple Quidax /deposits calls per job
        // (one per currency the user holds). Pace at the queue level so the
        // fallback cron cannot fan-out and trigger provider throttling.
        max: 1,
        duration: 1000,
    },
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnFail: true,
        removeOnComplete: true,
    },
};

export const quidaxQueueConfig: BullModuleOptions[] = [
    quidaxTradingOptions,
    quidaxSyncBalanceQueue,
    quidaxDepositSyncQueue,
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
