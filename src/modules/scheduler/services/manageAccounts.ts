import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex"; // Import Mutex
import { WsGateway } from "@/modules/api/trade/gateway/v1";

@Injectable()
export class AccountSchedulerService {
    private readonly logger = new Logger("AccountManagerScheduler");
    private mutex = new Mutex(); // Create a Mutex instance

    constructor(
        private prisma: PrismaService,
        private readonly wsGateway: WsGateway
    ) {}

    //every Midnight
    @Cron("0 0 * * *", { timeZone: "Africa/Lagos" })
    async removeUnverifiedAccounts() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            this.logger.debug(
                "Acquired lock: Running unverified accounts removal job"
            );

            const threeDaysAgo = new Date();
            threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

            // Fetch unverified users who were created 3 days ago or earlier
            const unverifiedUsers = await this.prisma.user.findMany({
                where: {
                    isEmailVerified: false,
                    createdAt: {
                        lte: threeDaysAgo,
                    },
                },
            });

            this.logger.debug(
                `Found ${unverifiedUsers.length} unverified accounts.`
            );

            await this.prisma.user.deleteMany({
                where: { id: { in: unverifiedUsers.map((u) => u.id) } },
            });
        } catch (error) {
            this.logger.error(
                "Error in running unverified accounts removal cron job:",
                error
            );
        } finally {
            release(); // Ensure lock is released even if an error occurs
            this.logger.debug("Lock released: Job completed");
        }
    }

    //every 10sec
    @Cron("*/10 * * * * *", { timeZone: "Africa/Lagos" })
    async broadcastAssetsUpdate() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            this.logger.debug("Acquired lock: Running asset updates job");
            this.wsGateway.broadcastWalletUpdatesToUser();
        } catch (error) {
            this.logger.error("Error in running asset updates job:", error);
        } finally {
            release(); // Ensure lock is released even if an error occurs
            this.logger.debug("Lock released: Job completed");
        }
    }
}
