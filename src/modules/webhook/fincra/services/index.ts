import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { FincraWebhookPayload, FincraChargeData, FincraPayoutData } from "../interfaces";
import { OrderStreamlinedStatus, TransactionStatus } from "@prisma/client";

@Injectable()
export class FincraWebhookService {
    private readonly logger = new Logger('FincraWebhookService');

    constructor(
        private readonly prisma: PrismaService,
        private readonly bankService: BankService,
        private readonly slackService: SlackWebhookService
    ) { }

    async processWebhookEvent(payload: FincraWebhookPayload) {
        const eventType = payload.event?.toLowerCase();
        const reference = (payload.data as any)?.customerReference || (payload.data as any)?.merchantReference || (payload.data as any)?.reference;

        this.logger.log(`Processing Fincra webhook: event=${eventType}, reference=${reference}`);
        this.logger.debug(`Webhook data keys: ${Object.keys(payload?.data || {}).join(', ')}`);

        try {
            // Handle payout/transfer events
            if (eventType?.includes("payout") || eventType?.includes("disbursement")) {
                await this.processPayoutEvent(payload.data as FincraPayoutData);
                this.logger.log(`Successfully processed payout event for reference: ${reference}`);
                return;
            }

            // Handle charge/collection events
            await this.processChargeEvent(payload.data as FincraChargeData);
            this.logger.log(`Successfully processed charge event for reference: ${reference}`);
        } catch (error) {
            this.logger.error(`Failed to process webhook event=${eventType}, reference=${reference}: ${error.message}`, error.stack);

            // Send Slack alert for webhook failure
            await this.slackService.sendWebhookFailureAlert(
                'fincra',
                reference || 'unknown',
                error.message,
                { eventType, payload }
            ).catch(alertErr => {
                this.logger.error(`Failed to send Slack alert: ${alertErr.message}`);
            });

            // Re-throw to return 500 to Fincra so they retry
            throw error;
        }
    }

    private async processChargeEvent(data: FincraChargeData) {
        const status = data.status?.toLowerCase();
        const reference = data.merchantReference || data.reference;

        if (!reference) return;

        switch (status) {
            case "success":
            case "successful":
                await this.bankService.paymentSuccessHandler(reference);
                break;
            case "failed":
            case "cancelled":
                await this.bankService.paymentFailedHandler(reference);
                break;
            case "pending":
            default:
                // leave as pending
                break;
        }
    }

    private async processPayoutEvent(data: FincraPayoutData) {
        const status = data.status?.toLowerCase();
        const reference = data.customerReference || data.reference;

        if (!reference) {
            this.logger.warn('Received payout event without reference, skipping');
            return;
        }

        this.logger.log(`Processing payout event: reference=${reference}, status=${status}`);

        // Find the payment record with its linked order and user
        const payment = await this.prisma.payment.findUnique({
            where: { reference },
            include: {
                order: { include: { user: { select: { id: true, email: true } } } },
                user: { select: { id: true, email: true } }
            },
        });

        if (!payment) {
            this.logger.warn(`Payment not found for payout reference: ${reference}`);
            return;
        }

        // Determine the new transaction status
        let transactionStatus: TransactionStatus | null = null;
        let orderStreamlinedStatus: OrderStreamlinedStatus | null = null;

        switch (status) {
            case "successful":
                transactionStatus = TransactionStatus.SUCCESS;
                orderStreamlinedStatus = OrderStreamlinedStatus.completed;
                break;
            case "failed":
                transactionStatus = TransactionStatus.FAILED;
                orderStreamlinedStatus = OrderStreamlinedStatus.failed;
                break;
            case "processing":
            case "pending":
            default:
                // Leave as pending, don't update
                this.logger.log(`Payout ${reference} still ${status}, no update needed`);
                return;
        }

        // Update both Payment and Order in a transaction
        await this.prisma.$transaction(async (tx) => {
            // Update payment status
            await tx.payment.update({
                where: { reference },
                data: {
                    status: transactionStatus,
                    paymentStatus: transactionStatus,
                },
            });

            // Update order if linked
            if (payment.orderId) {
                await tx.order.update({
                    where: { id: payment.orderId },
                    data: {
                        paymentStatus: transactionStatus,
                        streamlinedStatus: orderStreamlinedStatus,
                    },
                });
                this.logger.log(`Updated order ${payment.orderId} paymentStatus to ${transactionStatus}`);
            }
        });

        this.logger.log(`Updated payout status for ${reference} to ${transactionStatus}`);

        // Handle success notification
        if (transactionStatus === TransactionStatus.SUCCESS) {
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: reference,
                transferToBankStatus: TransactionStatus.SUCCESS as any, // Type cast needed due to legacy enum mismatch
            });
        }

        // Handle failure - send alerts
        if (transactionStatus === TransactionStatus.FAILED) {
            const userEmail = payment.order?.user?.email || payment.user?.email;
            const orderId = payment.orderId;

            // Send Slack alert for failed payout
            await this.slackService.sendWebhookFailureAlert(
                'fincra',
                reference,
                `PAYOUT FAILED - Order: ${orderId}, User: ${userEmail}, Amount: ${payment.amount} NGN`,
                { reference, orderId, userEmail, amount: payment.amount }
            ).catch(err => {
                this.logger.error(`Failed to send payout failure Slack alert: ${err.message}`);
            });

            this.logger.error(`Payout FAILED for reference ${reference}, order ${orderId}, user ${userEmail}`);
        }
    }
}
