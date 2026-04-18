import { Controller, Post, Get, Body, Headers, HttpCode, Logger, UseGuards } from "@nestjs/common";
import { NormalizedPaymentEvent } from "../types/payment-event.interface";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    TransactionStatus,
    PaymentMethod,
    TransactionType,
} from "@prisma/client";
import { BuyOrderService } from "../../trade/services/buy-order.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { PaymentWebhookAdapterService } from "@/modules/factory/bank/services/payment-webhook-adapter.service";
import {
    SellPayoutReconciliationService,
    SellPayoutStateTransition,
} from "../../trade/services/sell-payout-reconciliation.service";
import { NombaWebhookGuard } from "../../auth/guard";

@Controller("webhooks")
export class NombaWebhookController {
    private readonly logger = new Logger(NombaWebhookController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly buyOrderService: BuyOrderService,
        private readonly slackWebhookService: SlackWebhookService,
        private readonly paymentWebhookAdapterService: PaymentWebhookAdapterService,
        private readonly sellPayoutReconciliationService: SellPayoutReconciliationService,
    ) { }

    /**
     * GET endpoint for Nomba webhook URL verification
     */
    @Get("nomba")
    @HttpCode(200)
    verifyWebhookUrl() {
        return { status: "ok", message: "Nomba webhook endpoint active" };
    }

    @UseGuards(NombaWebhookGuard)
    @Post("nomba")
    @HttpCode(200)
    async handleWebhook(
        @Body() body: any,
        @Headers() headers: any,
    ) {
        this.logger.debug(`Raw Webhook Headers: ${JSON.stringify(headers)}`);
        this.logger.debug(`Raw Webhook Body: ${JSON.stringify(body)}`);

        try {
            const event = this.paymentWebhookAdapterService.normalizeNombaWebhook(body);
            this.logger.log(
                `Normalized Nomba Event: ${event.kind}.${event.status} | Ref: ${event.reference} | Amount: ${event.amount} | Provider Ref: ${event.providerReference}`
            );

            // 3.5 Persist webhook payload to WebhookLog for audit trail & reconciliation
            await this.logWebhook(event);

            // 4. Route based on Normalized Event
            switch (`${event.kind}.${event.status}`) {
                case 'incoming_payment.successful':
                    await this.handleIncomingPayment(event);
                    break;
                case 'payout.successful':
                    await this.handleTransferSuccess(event);
                    break;
                case 'incoming_payment.failed':
                case 'payout.failed':
                    await this.handleTransferFailed(event);
                    break;
                default:
                    this.logger.warn(`Unhandled Nomba webhook event type: ${event.eventName}`);
            }

            return { success: true, message: "Webhook processed" };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Error processing Nomba webhook: ${message}`);
            // Re-throw so NestJS returns 500 and Nomba retries the webhook
            throw error;
        }
    }

    /**
     * Persist raw webhook payload to WebhookLog for audit trail.
     * Uses upsert with unique constraint (provider, eventType, externalId)
     * to handle Nomba webhook retries idempotently.
     */
    private async logWebhook(event: NormalizedPaymentEvent): Promise<void> {
        try {
            const externalId = event.providerReference || event.reference || 'unknown';
            await this.prisma.webhookLog.upsert({
                where: {
                    provider_eventType_externalId: {
                        provider: 'nomba',
                        eventType: event.eventName,
                        externalId,
                    },
                },
                create: {
                    provider: 'nomba',
                    eventType: event.eventName,
                    externalId,
                    payload: event.raw,
                },
                update: {}, // No-op on duplicate — already logged
            });
        } catch (error) {
            // Non-fatal: don't block payment processing if logging fails
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to log webhook: ${message}`);
        }
    }

    private async findIncomingPayment(event: NormalizedPaymentEvent) {
        const payment = await this.prisma.payment.findFirst({
            where: { reference: event.reference },
        });

        if (payment || !event.metadata?.accountRef) {
            return payment;
        }

        const fallbackWhere: Record<string, any> = {
            providerAccountReference: event.metadata.accountRef,
            paymentMethod: PaymentMethod.NOMBA,
            type: TransactionType.P2P_PAYMENT,
            orderId: { not: null },
            status: { in: [TransactionStatus.PENDING, TransactionStatus.APPROVED] },
        };

        if (
            typeof event.amount === "number"
            && Number.isFinite(event.amount)
            && event.amount > 0
        ) {
            fallbackWhere.totalAmount = event.amount;
        }

        return this.prisma.payment.findFirst({
            where: fallbackWhere,
            orderBy: { createdAt: "desc" },
        });
    }

    /**
     * Handle buy-order payment: validate amount and trigger fulfillment.
     */
    private async handleBuyOrderPayment(
        payment: { id: number; orderId: number; userId: number; totalAmount: unknown; reference: string },
        event: NormalizedPaymentEvent,
        resolvedReference: string,
    ) {
        const { amount } = event;
        const expectedAmount = Number(payment.totalAmount);

        if (expectedAmount > 0 && amount < expectedAmount * 0.99) {
            this.logger.error(
                `Underpayment detected | Ref: ${resolvedReference} | Expected: ${expectedAmount} | Received: ${amount}`
            );

            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    receivedAmount: amount,
                    senderAccountNumber: event.senderAccountNumber || null,
                    senderAccountName: event.senderAccountName || null,
                    senderBankName: event.senderBankName || null,
                    narration: `Underpayment: received ₦${amount} of expected ₦${expectedAmount}`,
                },
            });

            await this.slackWebhookService.sendWebhookFailureAlert(
                'nomba',
                resolvedReference,
                `Underpayment: received ${amount} but expected ${expectedAmount}. Order NOT auto-fulfilled. ` +
                `Sender: ${event.senderAccountName || 'N/A'} (${event.senderAccountNumber || 'N/A'}) @ ${event.senderBankName || 'N/A'}. ` +
                `Auto-cancel will run after 2 hours. Ops must process refund.`,
                {
                    orderId: payment.orderId,
                    userId: payment.userId,
                    expectedAmount,
                    receivedAmount: amount,
                    shortfall: expectedAmount - amount,
                    senderAccountNumber: event.senderAccountNumber,
                    senderAccountName: event.senderAccountName,
                    senderBankName: event.senderBankName,
                }
            );
            return;
        }

        if (event.providerReference) {
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: { externalReference: event.providerReference },
            });
        }

        this.logger.log(`Payment identified as Buy Order payment (Order ID: ${payment.orderId}). Triggering fulfillment.`);
        await this.buyOrderService.fulfillBuyOrder(resolvedReference);
        this.logger.log(`Buy order fulfillment completed for payment ${payment.id}`);
    }

    /**
     * Handle incoming payment (Normalized)
     */
    private async handleIncomingPayment(event: NormalizedPaymentEvent) {
        const { reference, amount } = event;

        if (!reference) {
            this.logger.warn(
                `Ignoring payment webhook with no extractable reference. ` +
                `Raw event_type: ${event.raw?.event_type || event.raw?.event}. ` +
                `Transaction type: ${event.raw?.data?.transaction?.type || 'unknown'}. ` +
                `Keys in data: ${Object.keys(event.raw?.data || {}).join(', ')}. ` +
                `Provider ref: ${event.providerReference || 'none'}`
            );
            return;
        }

        const payment = await this.findIncomingPayment(event);

        if (payment && payment.reference !== reference) {
            this.logger.log(
                `Resolved provider accountRef ${reference} to internal payment reference ${payment.reference}`
            );
        }

        const resolvedReference = payment?.reference || reference;

        this.logger.log(`Processing incoming payment: ${amount} | Ref: ${resolvedReference}`);

        if (payment) {
            if (payment.orderId) {
                await this.handleBuyOrderPayment(payment as any, event, resolvedReference);
                return;
            }

            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                    ...(event.providerReference ? { externalReference: event.providerReference } : {}),
                },
            });
            this.logger.log(`Updated payment ${payment.id} to SUCCESS`);
        } else {
            this.logger.warn(`No payment found for reference: ${reference}`);
        }
    }

    /**
     * Handle successful payout (Normalized)
     */
    private async handleTransferSuccess(event: NormalizedPaymentEvent) {
        const { reference } = event;

        if (!reference) {
            this.logger.warn("Missing reference in transfer success event");
            return;
        }

        this.logger.log(`Processing transfer success: ${reference}`);

        // updateMany doesn't support externalReference (no unique filter), use findFirst + update
        const payment = await this.prisma.payment.findFirst({ where: { reference } });
        if (payment) {
            const sellPayoutTransition = await this.prisma.$transaction(async (tx) => {
                await tx.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: TransactionStatus.SUCCESS,
                        paymentStatus: TransactionStatus.SUCCESS,
                        ...(event.providerReference ? { externalReference: event.providerReference } : {}),
                    },
                });

                if (!payment.orderId) {
                    return null;
                }

                return this.sellPayoutReconciliationService.reconcileSellPayoutState(tx, {
                    orderId: payment.orderId,
                    provider: "nomba",
                    reference,
                    status: TransactionStatus.SUCCESS,
                });
            });

            if (sellPayoutTransition) {
                await this.sellPayoutReconciliationService.executeSellPayoutSideEffects(
                    sellPayoutTransition,
                );
            }
        }
    }

    /**
     * Handle failed payout/payment (Normalized)
     */
    private async handleTransferFailed(event: NormalizedPaymentEvent) {
        const { reference } = event;

        if (!reference) {
            this.logger.warn("Missing reference in transfer failed event");
            return;
        }

        this.logger.log(`Processing transfer failure: ${reference}`);

        // Find payments matching this reference before updating
        const payments = await this.prisma.payment.findMany({
            where: { reference },
            select: { id: true, orderId: true, userId: true, totalAmount: true },
        });

        const sellPayoutTransitions = await this.prisma.$transaction(async (tx) => {
            const transitions: SellPayoutStateTransition[] = [];

            await tx.payment.updateMany({
                where: { reference },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });

            for (const payment of payments) {
                if (!payment.orderId) {
                    continue;
                }

                const transition = await this.sellPayoutReconciliationService.reconcileSellPayoutState(tx, {
                    orderId: payment.orderId,
                    provider: "nomba",
                    reference,
                    status: TransactionStatus.FAILED,
                });

                if (transition) {
                    transitions.push(transition);
                }
            }

            return transitions;
        });

        for (const transition of sellPayoutTransitions) {
            await this.sellPayoutReconciliationService.executeSellPayoutSideEffects(
                transition,
            );
        }
    }
}
