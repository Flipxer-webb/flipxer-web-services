import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex"; // Import Mutex
import { OrderCategory, OrderStatus } from "@prisma/client";
import { TradingService } from "@/modules/api/trade/services";

@Injectable()
export class ManageOrdersSchedulerService {
    private readonly logger = new Logger("ManageOrdersScheduler");
    private mutex = new Mutex(); // Create a Mutex instance

    constructor(
        private prisma: PrismaService,
        private tradingService: TradingService
    ) {}

    //every 1hr
    @Cron("0 */1 * * *", { timeZone: "Africa/Lagos" })
    async verifySwapTransaction() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - 2); //2hrs

            // Fetch all pending swap transactions
            const pendingSwapTransactions = await this.prisma.order.findMany({
                where: {
                    orderCategory: OrderCategory.SWAP,
                    status: OrderStatus.initiated,
                    createdAt: { gte: cutoffTime },
                },
                select: {
                    id: true,
                    providerOrderId: true,
                    user: { select: { cryptoSubAccountId: true } },
                },
            });

            if (pendingSwapTransactions.length === 0) {
                this.logger.debug("No pending swap transactions found.");
                return;
            }

            this.logger.debug(
                `Found ${pendingSwapTransactions.length} swap pending transactions.`
            );

            // Process transactions in parallel
            const results = await Promise.allSettled(
                pendingSwapTransactions.map(
                    async ({ id, providerOrderId, user }) => {
                        try {
                            if (user.cryptoSubAccountId) {
                                const response =
                                    await this.tradingService.verifySwapQuoteTransaction(
                                        providerOrderId,
                                        user.cryptoSubAccountId
                                    );

                                switch (response.data.status) {
                                    case OrderStatus.completed:
                                        await this.tradingService.swapTransactionHandler(
                                            {
                                                orderReference: providerOrderId,
                                                status: OrderStatus.completed,
                                            }
                                        );
                                        break;
                                    case OrderStatus.failed:
                                        await this.tradingService.swapTransactionHandler(
                                            {
                                                orderReference: providerOrderId,
                                                status: OrderStatus.failed,
                                            }
                                        );
                                        break;
                                    case OrderStatus.reversed:
                                        await this.tradingService.swapTransactionHandler(
                                            {
                                                orderReference: providerOrderId,
                                                status: OrderStatus.reversed,
                                            }
                                        );
                                        break;
                                }
                            }
                        } catch (error) {
                            this.logger.error(
                                `Error verifying transaction reference ${providerOrderId}:`,
                                error
                            );
                        }
                    }
                )
            );

            // Log batch processing results
            const successCount = results.filter(
                (r) => r.status === "fulfilled"
            ).length;
            this.logger.log(
                `Processed ${successCount} transactions successfully.`
            );
        } catch (error) {
            this.logger.error(
                "Error in running quidax swap transaction verification cron job:",
                error
            );
        } finally {
            release(); // Ensure lock is released even if an error occurs
            this.logger.debug("Lock released: Job completed");
        }
    }
}
