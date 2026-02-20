import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex"; // Import Mutex
import { OrderCategory, OrderStatus } from "@prisma/client";
import { TradingService } from "@/modules/api/trade/services";
import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";

@Injectable()
export class ManageOrdersSchedulerService {
    private readonly logger = new Logger("ManageOrdersScheduler");
    private mutex = new Mutex(); // Create a Mutex instance

    constructor(
        private prisma: PrismaService,
        private tradingService: TradingService,
        private buyOrderService: BuyOrderService
    ) {}

    //every 1hr "0 */1 * * *"
    // Reduced from 5 min to 2 min for faster swap transaction verification
    @Cron("*/2 * * * *", { timeZone: "Africa/Lagos" })
    async verifySwapTransaction() {
        this.logger.debug("Cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - 24); //2hrs

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
                                                orderId: providerOrderId,
                                                status: OrderStatus.completed,
                                            }
                                        );
                                        break;
                                    case OrderStatus.failed:
                                        await this.tradingService.swapTransactionHandler(
                                            {
                                                orderId: providerOrderId,
                                                status: OrderStatus.failed,
                                            }
                                        );
                                        break;
                                    case OrderStatus.reversed:
                                        await this.tradingService.swapTransactionHandler(
                                            {
                                                orderId: providerOrderId,
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

    // Reduced from 5 min to 1 min for faster withdrawal status updates
    // This provides a fallback when webhooks are delayed or missed
    @Cron("*/1 * * * *", { timeZone: "Africa/Lagos" })
    async verifyWithdrawerTransaction() {
        this.logger.debug("Withdrawal sync cron job triggered!");

        // Use the mutex to ensure only one execution at a time
        const release = await this.mutex.acquire();
        try {
            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - 24); //2hrs

            // Fetch all pending withdrawer transactions
            const pendingWithdrawerTransactions =
                await this.prisma.order.findMany({
                    where: {
                        orderCategory: {
                            in: [OrderCategory.SEND, OrderCategory.SELL],
                        },
                        status: OrderStatus.processing,
                        createdAt: { gte: cutoffTime },
                    },
                    select: {
                        id: true,
                        providerOrderId: true,
                        orderReference: true,
                        user: { select: { cryptoSubAccountId: true } },
                    },
                });

            if (pendingWithdrawerTransactions.length === 0) {
                this.logger.debug("No pending withdrawer transactions found.");
                return;
            }

            this.logger.debug(
                `Found ${pendingWithdrawerTransactions.length} withdrawer pending transactions.`
            );

            // Process transactions in parallel
            const results = await Promise.allSettled(
                pendingWithdrawerTransactions.map(
                    async ({ orderReference, providerOrderId, user }) => {
                        try {
                            // Skip orders that never reached Quidax (e.g., queued orders)
                            if (!providerOrderId) {
                                this.logger.debug(
                                    `Skipping order ${orderReference} — no providerOrderId (likely queued/not yet submitted to Quidax)`
                                );
                                return;
                            }

                            // Withdrawals are now executed from the main wallet ("me"),
                            // not from user sub-accounts. Use "me" as the lookup user_id.
                            // Fall back to sub-account ID for legacy orders.
                            const lookupUserId = "me";

                            const response =
                                await this.tradingService.getWithdrawerTransactionByReference(
                                    orderReference,
                                    lookupUserId
                                );

                            switch (response.data.status.toLowerCase()) {
                                case OrderStatus.done:
                                    await this.tradingService.withdrawerTransactionHandler(
                                        {
                                            orderReference: orderReference,
                                            status: OrderStatus.done,
                                        }
                                    );
                                    break;
                                case OrderStatus.rejected:
                                    await this.tradingService.withdrawerTransactionHandler(
                                        {
                                            orderReference: orderReference,
                                            status: OrderStatus.rejected,
                                        }
                                    );
                                    break;
                            }
                        } catch (error) {
                            this.logger.error(
                                `Error processing withdrawer transaction reference ${orderReference}:`,
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

    /**
     * Cancel expired buy orders whose virtual account payment window has passed.
     * Runs every 5 minutes.
     */
    @Cron("*/5 * * * *", { timeZone: "Africa/Lagos" })
    async cancelExpiredBuyOrders() {
        this.logger.debug("Expired buy order cleanup cron triggered");
        try {
            const count =
                await this.buyOrderService.cancelExpiredBuyOrders();
            if (count > 0) {
                this.logger.log(
                    `Cancelled ${count} expired buy orders`
                );
            }
        } catch (error) {
            this.logger.error(
                "Error cancelling expired buy orders:",
                error
            );
        }
    }
}
