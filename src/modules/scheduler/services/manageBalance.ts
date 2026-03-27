import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex"; // Import Mutex
import { CryptoAccountQueueProducer } from "@/modules/api/trade/queues/producers/producer.service";
import { CryptoWalletStatus } from "@prisma/client";
import { TradingService } from "@/modules/api/trade/services";

@Injectable()
export class AssetBalanceSchedulerService {
    private readonly logger = new Logger("ManageBalanceScheduler");
    private readonly mutex = new Mutex(); // Create a Mutex instance
    private readonly depositSyncMutex = new Mutex(); // Separate mutex for deposit sync

    constructor(
        private readonly prisma: PrismaService,
        private readonly cryptoAccountProducer: CryptoAccountQueueProducer,
        private readonly tradingService: TradingService
    ) {}

    //every 15 minute
    @Cron("*/15 * * * *", { timeZone: "Africa/Lagos" })
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

    //every 1hr "0 */1 * * *"
    @Cron("*/15 * * * *", { timeZone: "Africa/Lagos" })
    async syncWalletAddress() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - 2); //2hrs

            // Fetch all pending address
            const pendingAddresses =
                await this.prisma.cryptoWalletAddress.findMany({
                    where: {
                        status: CryptoWalletStatus.PENDING,
                        createdAt: { gte: cutoffTime },
                    },
                    select: {
                        id: true,
                        walletAddressId: true,
                        assetSymbol: true,
                        user: { select: { cryptoSubAccountId: true } },
                    },
                });

            if (pendingAddresses.length === 0) {
                this.logger.debug("No pending wallet address found.");
                return;
            }

            this.logger.debug(
                `Found ${pendingAddresses.length} wallet address.`
            );

            // Process transactions in parallel
            await Promise.allSettled(
                pendingAddresses.map(
                    async ({ id, walletAddressId, assetSymbol, user }) => {
                        try {
                            if (user.cryptoSubAccountId) {
                                const response =
                                    await this.tradingService.getGeneratedWalletAddress(
                                        {
                                            address_id: walletAddressId,
                                            user_id: user.cryptoSubAccountId,
                                            currency: assetSymbol.toLowerCase(),
                                        }
                                    );

                                if (response.data.address) {
                                    await this.tradingService.walletAddressCreatedSuccessHandler(
                                        {
                                            walletAddressId: walletAddressId,
                                            walletAddress:
                                                response.data.address,
                                            totalPayments:
                                                response.data.total_payments,
                                            destination_tag:
                                                response.data.destination_tag,
                                        }
                                    );
                                }
                            }
                        } catch (error) {
                            this.logger.error(
                                `Error syncing generated wallet address ${walletAddressId}:`,
                                error
                            );
                        }
                    }
                )
            );
        } catch (error) {
            this.logger.error(
                "Error in syncing generated wallet address cron job:",
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
            const lastUser = users.at(-1);
            if (!lastUser) {
                break;
            }
            lastId = lastUser.id;

            hasMore = users.length === batchSize;
        }

        return allUserIds;
    }

    /**
     * Fallback deposit sync - runs every 5 minutes to catch any deposits
     * that may have been missed due to webhook failures
     * 
     * This is a safety net to ensure all deposits are eventually recorded
     * even if webhooks fail or are delayed
     */
    @Cron("*/5 * * * *", { timeZone: "Africa/Lagos" })
    async syncMissedDeposits() {
        this.logger.debug("[DEPOSIT SYNC] Fallback deposit sync triggered");

        const release = await this.depositSyncMutex.acquire();
        try {
            this.logger.debug("[DEPOSIT SYNC] Acquired lock: Running fallback deposit sync");

            // Get users who have had recent activity (logged in within last 7 days)
            // to avoid syncing deposits for inactive accounts
            const recentlyActiveUsers = await this.getRecentlyActiveUsersWithSubAccounts();
            
            if (recentlyActiveUsers.length === 0) {
                this.logger.debug("[DEPOSIT SYNC] No recently active users found");
                return;
            }

            this.logger.log(`[DEPOSIT SYNC] Checking deposits for ${recentlyActiveUsers.length} active users`);

            const batchSize = 10; // Process 10 users at a time to avoid rate limits
            let totalSynced = 0;
            let totalErrors = 0;

            for (let i = 0; i < recentlyActiveUsers.length; i += batchSize) {
                const batch = recentlyActiveUsers.slice(i, i + batchSize);
                
                const results = await Promise.allSettled(
                    batch.map(async (userId) => {
                        try {
                            const result = await this.tradingService.syncUserDeposits(userId);
                            if (result.data?.synced > 0) {
                                this.logger.log(
                                    `[DEPOSIT SYNC] User ${userId}: Synced ${result.data.synced} deposits`
                                );
                                return result.data.synced;
                            }
                            return 0;
                        } catch (error) {
                            this.logger.error(
                                `[DEPOSIT SYNC] Error syncing deposits for user ${userId}: ${error.message}`
                            );
                            throw error;
                        }
                    })
                );

                // Count results
                for (const result of results) {
                    if (result.status === "fulfilled") {
                        totalSynced += result.value;
                    } else {
                        totalErrors++;
                    }
                }

                // Add a small delay between batches to avoid overwhelming the API
                if (i + batchSize < recentlyActiveUsers.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }

            this.logger.log(
                `[DEPOSIT SYNC] Completed - Synced: ${totalSynced} deposits, Errors: ${totalErrors}`
            );
        } catch (error) {
            this.logger.error("[DEPOSIT SYNC] Error in fallback deposit sync:", error);
        } finally {
            release();
            this.logger.debug("[DEPOSIT SYNC] Lock released: Job completed");
        }
    }

    /**
     * Get users who have logged in within the last 7 days and have crypto sub-accounts
     */
    async getRecentlyActiveUsersWithSubAccounts(): Promise<number[]> {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const users = await this.prisma.user.findMany({
            where: {
                cryptoSubAccountId: { not: null },
                lastLogin: { gte: sevenDaysAgo },
            },
            orderBy: { lastLogin: "desc" },
            select: { id: true },
            take: 500, // Limit to 500 most recently active users
        });

        return users.map((u) => u.id);
    }
}
