import { BullModuleOptions } from "@nestjs/bull";
import { TradingQueue } from "./interfaces";
import { BullBoardQueueOptions } from "@bull-board/nestjs";
import { BullAdapter } from "@bull-board/api/bullAdapter";
export * from "./interfaces";

export const quidaxTradingOptions: BullModuleOptions = {
    name: TradingQueue.QUIDAX_TRADING,
    defaultJobOptions: {
        attempts: 3, //If a job fails, retry once more (total 3 attempts).
        delay: 60 * 3 * 1000, //each job execution will be delayed by 3min
        removeOnFail: true, //automatically removes failed jobs.
        removeOnComplete: true, //automatically removes successfully completed jobs.
    },
};

export const quidaxQueueConfig: BullModuleOptions[] = [quidaxTradingOptions];
export const quidaxBoardQueueConfig: BullBoardQueueOptions[] = [
    {
        name: TradingQueue.QUIDAX_TRADING,
        adapter: BullAdapter,
    },
];
