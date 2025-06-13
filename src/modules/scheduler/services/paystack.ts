import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "@/modules/core/prisma/services";
import { Mutex } from "async-mutex";
import { PaymentMethod, TransactionStatus } from "@prisma/client";
import { BankService } from "@/modules/api/banks/services";

@Injectable()
export class PaystackSchedulerService {
    private readonly logger = new Logger("PaystackScheduler");
    private mutex = new Mutex(); // Ensures only one execution at a time

    constructor(
        private prisma: PrismaService,
        private bankService: BankService
    ) {}

    // Runs every 20min
    @Cron("*/20 * * * *", { timeZone: "Africa/Lagos" })
    async verifyTransaction() {
        this.logger.debug("Cron job triggered!");

        // Acquire the mutex lock
        const release = await this.mutex.acquire();
        try {
            this.logger.debug(
                "Acquired lock: Running paystack verification job"
            );

            const cutoffTime = new Date();
            cutoffTime.setHours(cutoffTime.getHours() - 72); //2hr

            // Fetch all pending transactions
            const pendingTransactions = await this.prisma.payment.findMany({
                where: {
                    paymentStatus: TransactionStatus.PENDING,
                    paymentMethod: PaymentMethod.PAYSTACK,
                    createdAt: { gte: cutoffTime },
                },
                select: { id: true, reference: true },
            });

            if (pendingTransactions.length === 0) {
                this.logger.debug("No pending paystack transactions found.");
                return;
            }

            this.logger.debug(
                `Found ${pendingTransactions.length} paystack pending transactions.`
            );

            // Process transactions in parallel
            const results = await Promise.allSettled(
                pendingTransactions.map(async ({ id, reference }) => {
                    try {
                        const response =
                            await this.bankService.verifyPaystackTransactionHandler(
                                reference
                            );

                        switch (response.status) {
                            case "success":
                                await this.bankService.paymentSuccessHandler(
                                    reference
                                );
                                break;
                            case "failed":
                                await this.bankService.paymentFailedHandler(
                                    reference
                                );
                                break;
                            case "abandoned":
                                await this.bankService.paymentAbandonedHandler(
                                    reference
                                );
                                break;
                        }
                    } catch (error) {
                        this.logger.error(
                            `Error verifying transaction reference ${reference}:`,
                            error
                        );
                    }
                })
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
                "Error in Reloadly Giftcard Transaction verification cron job:",
                error
            );
        } finally {
            release(); // Release the lock
            this.logger.debug("Lock released: Job completed");
        }
    }
}
