import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex"; // Import Mutex
import { CryptoAccountQueueProducer } from "@/modules/api/trade/queues/producers/producer.service";

@Injectable()
export class AssetBalanceSchedulerService {
    private readonly logger = new Logger("ManageBalanceScheduler");
    private mutex = new Mutex(); // Create a Mutex instance

    constructor(
        private prisma: PrismaService,
        private cryptoAccountProducer: CryptoAccountQueueProducer
    ) {}

    //every 15 minute
    @Cron("*/2 * * * *", { timeZone: "Africa/Lagos" })
    async syncAllQuidaxAssetBalance() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            this.logger.debug(
                "Acquired lock: Running quidax asset balance sync job"
            );

            const users = await this.getAllUserIdsWithSubAccounts();

            const batchSize = 100;

            for (let i = 0; i < users.length; i += batchSize) {
                const batch = users.slice(i, i + batchSize);
                await Promise.all(
                    batch.map(async (userId) => {
                        await this.cryptoAccountProducer.enqueueSyncBalance(
                            userId
                        );
                    })
                );
            }
        } catch (error) {
            this.logger.error(
                "Error in running quidax asset balance sync cron job:",
                error
            );
        } finally {
            release(); // Ensure lock is released even if an error occurs
            this.logger.debug("Lock released: Job completed");
        }
    }

    async getAllUserIdsWithSubAccounts(): Promise<number[]> {
        const batchSize = 1000;
        let hasMore = true;
        let lastId: number | null = null;
        const allUserIds: number[] = [];

        while (hasMore) {
            const users = await this.prisma.user.findMany({
                where: {
                    cryptoSubAccountId: { not: null },
                    ...(lastId && { id: { gt: lastId } }), // for cursor-like pagination
                },
                orderBy: { id: "asc" },
                take: batchSize,
                select: { id: true },
            });

            if (users.length === 0) break;

            allUserIds.push(...users.map((u) => u.id));
            lastId = users[users.length - 1].id;

            hasMore = users.length === batchSize;
        }

        return allUserIds;
    }
}
