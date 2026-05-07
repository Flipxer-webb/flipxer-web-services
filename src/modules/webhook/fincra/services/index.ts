import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { FincraWebhookPayload } from "../interfaces";
import { TransactionStatus } from "@prisma/client";
import { PaymentWebhookAdapterService } from "@/modules/factory/bank/services/payment-webhook-adapter.service";
import {
    SellPayoutReconciliationService,
} from "@/modules/api/trade/services/sell-payout-reconciliation.service";
import { NormalizedPaymentEvent } from "@/modules/api/banks/types/payment-event.interface";
import { BuyOrderService } from "@/modules/api/trade/services/buy-order.service";
import {
    BuyOrderWebhookPayment,
    handleBuyOrderWebhookPayment,
} from "@/modules/api/banks/services/buy-order-webhook-payment.util";

@Injectable()
export class FincraWebhookService {
    private readonly logger = new Logger('FincraWebhookService');

    constructor(
        private readonly prisma: PrismaService,
        private readonly bankService: BankService,
        private readonly slackService: SlackWebhookService,
        private readonly paymentWebhookAdapterService: PaymentWebhookAdapterService,
        private readonly sellPayoutReconciliationService: SellPayoutReconciliationService,
        private readonly buyOrderService: BuyOrderService,
    ) { }

    async processWebhookEvent(payload: FincraWebhookPayload) {
        const event = this.paymentWebhookAdapterService.normalizeFincraWebhook(payload);
        const eventType = event.eventName;
        const reference = event.reference;

        this.logger.log(`Processing Fincra webhook: event=${eventType}, reference=${reference}`);
        this.logger.debug(`Webhook data keys: ${Object.keys(payload?.data || {}).join(', ')}`);

        try {
            if (event.kind === "payout") {
                await this.processPayoutEvent(event);
                this.logger.log(`Successfully processed payout event for reference: ${reference}`);
                return;
            }

            if (event.kind === "incoming_payment") {
                await this.processChargeEvent(event);
                this.logger.log(`Successfully processed charge event for reference: ${reference}`);
                return;
            }

            this.logger.warn(`Ignoring unsupported Fincra webhook event: ${eventType}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const stack = error instanceof Error ? error.stack : undefined;
            this.logger.error(`Failed to process webhook event=${eventType}, reference=${reference}: ${message}`, stack);

            // Send Slack alert for webhook failure
            await this.slackService.sendWebhookFailureAlert(
                'fincra',
                reference || 'unknown',
                message,
                { eventType, payload }
            ).catch(alertErr => {
                this.logger.error(`Failed to send Slack alert: ${alertErr.message}`);
            });

            // Re-throw to return 500 to Fincra so they retry
            throw error;
        }
    }

    private async processChargeEvent(event: NormalizedPaymentEvent) {
        const status = event.status;
        const reference = event.reference;

        if (!reference) return;

        switch (status) {
            case "successful": {
                const payment = await this.prisma.payment.findUnique({
                    where: { reference },
                });

                if (payment?.orderId) {
                    await handleBuyOrderWebhookPayment({
                        payment: payment as BuyOrderWebhookPayment,
                        event,
                        reference,
                        provider: "fincra",
                        buyOrderService: this.buyOrderService,
                    });
                    break;
                }

                await this.bankService.paymentSuccessHandler(reference);
                break;
            }
            case "failed":
                await this.bankService.paymentFailedHandler(reference);
                break;
            case "pending":
            default:
                // leave as pending
                break;
        }
    }

    private async processPayoutEvent(event: NormalizedPaymentEvent) {
        const status = event.status;
        const reference = event.reference;

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
        let transactionStatus: "SUCCESS" | "FAILED" | null = null;

        switch (status) {
            case "successful":
                transactionStatus = TransactionStatus.SUCCESS;
                break;
            case "failed":
                transactionStatus = TransactionStatus.FAILED;
                break;
            case "pending":
            default:
                // Leave as pending, don't update
                this.logger.log(`Payout ${reference} still ${status}, no update needed`);
                return;
        }

        const sellPayoutTransition = await this.prisma.$transaction(async (tx) => {
            await tx.payment.update({
                where: { reference },
                data: {
                    status: transactionStatus,
                    paymentStatus: transactionStatus,
                },
            });

            if (!payment.orderId) {
                return null;
            }

            return this.sellPayoutReconciliationService.reconcileSellPayoutState(tx, {
                orderId: payment.orderId,
                provider: "fincra",
                reference,
                status: transactionStatus,
            });
        });

        if (sellPayoutTransition) {
            await this.sellPayoutReconciliationService.executeSellPayoutSideEffects(
                sellPayoutTransition,
            );
            return;
        }

        // Non-sell payout handling (legacy path)
        if (transactionStatus === TransactionStatus.SUCCESS) {
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: reference,
                transferToBankStatus: TransactionStatus.SUCCESS as any,
            });
        }

        if (transactionStatus === TransactionStatus.FAILED) {
            const userEmail = payment.order?.user?.email || payment.user?.email;
            const orderId = payment.orderId;

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
