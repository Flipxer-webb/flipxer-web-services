import { Controller, Post, Get, Body, Headers, HttpCode, Logger, UnauthorizedException } from "@nestjs/common";
import { NombaWebhookPayload, NombaWebhookEventType } from "../dtos/nomba-webhook.dto";
import { NormalizedPaymentEvent } from "../types/payment-event.interface";
import { PrismaService } from "@/modules/core/prisma/services";
import { TransactionStatus } from "@prisma/client";
import * as Config from "@/config";
import * as crypto from "crypto";
import { BuyOrderService } from "../../trade/services/buy-order.service";

@Controller("webhooks")
export class NombaWebhookController {
    private readonly logger = new Logger(NombaWebhookController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly buyOrderService: BuyOrderService
    ) { }

    /**
     * Verify webhook signature from Nomba
     */
    private verifySignature(payload: string, signature: string): boolean {
        const webhookSecret = Config.nombaOptions?.webhookSecret;
        if (!webhookSecret) {
            this.logger.warn("Nomba webhook secret not configured - skipping signature verification");
            return true; // Allow in development
        }

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(payload)
            .digest("hex");

        return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSignature)
        );
    }

    /**
     * Normalizes Nomba payload to standard internal event
     * ACTS AS ADAPTER LAYER
     */
    private normalizePayload(body: any): NormalizedPaymentEvent {
        // Nomba sends event type in 'event_type' (new) or 'event' (old)
        const eventTypeRaw = body.event_type || body.event;
        const data = body.data || {};

        // Handle nested structures strictly here
        const transaction = data.transaction || {};
        const order = data.order || {};

        // Extract Standard Fields
        // 1. Reference: Must match what we stored in Payment.reference
        const reference = order.orderReference
            || data.reference
            || transaction.merchantTxRef; // Fallback only (Nomba's ref)

        // 2. Amount
        const amount = Number(data.amount || transaction.transactionAmount || order.amount || 0);

        // 3. Map Event Type
        let type: NormalizedPaymentEvent['type'] = 'other';

        switch (eventTypeRaw) {
            case 'payment_success':
            case 'order_success':
            case NombaWebhookEventType.TRANSACTION_COMPLETED:
            case NombaWebhookEventType.VIRTUAL_ACCOUNT_CREDITED:
                type = 'payment_success';
                break;
            case 'payout_success':
            case NombaWebhookEventType.TRANSFER_SUCCESSFUL:
                type = 'payout_success';
                break;
            case 'payment_failed':
            case 'payout_failed':
            case NombaWebhookEventType.TRANSFER_FAILED:
                type = 'payment_failed'; // Grouping failed events for now
                break;
        }

        return {
            provider: 'nomba',
            type,
            reference,
            providerReference: transaction.transactionId || data.id,
            amount,
            currency: 'NGN', // Nomba is NGN only for now
            raw: body, // Keep raw for debugging
            metadata: {
                accountRef: data.accountRef || order.accountId,
                customerEmail: data.customerEmail || order.customerEmail
            }
        };
    }

    /**
     * GET endpoint for Nomba webhook URL verification
     */
    @Get("nomba")
    @HttpCode(200)
    verifyWebhookUrl() {
        return { status: "ok", message: "Nomba webhook endpoint active" };
    }

    @Post("nomba")
    @HttpCode(200)
    async handleWebhook(
        @Body() body: any,
        @Headers() headers: any
    ) {
        this.logger.log(`Raw Webhook Headers: ${JSON.stringify(headers)}`);

        const signature = headers["x-nomba-signature"];

        // 1. Basic Validation
        if (!body || (!body.event_type && !body.event)) {
            this.logger.log("Received webhook verification/test request from Nomba");
            return { status: "ok", message: "Webhook received" };
        }

        // 2. Signature Verification (Security First)
        if (process.env.NODE_ENV === "production" && signature) {
            const isValid = this.verifySignature(JSON.stringify(body), signature);
            if (!isValid) {
                this.logger.error("Invalid Nomba webhook signature");
                throw new UnauthorizedException("Invalid webhook signature");
            }
        }

        try {
            // 3. Normalize Payload (The Fix)
            const event = this.normalizePayload(body);
            this.logger.log(`Normalized Nomba Event: ${event.type} | Ref: ${event.reference}`);

            // 4. Route based on Normalized Event
            switch (event.type) {
                case 'payment_success':
                    await this.handleIncomingPayment(event);
                    break;
                case 'payout_success':
                    await this.handleTransferSuccess(event);
                    break;
                case 'payment_failed':
                case 'payout_failed':
                    await this.handleTransferFailed(event);
                    break;
                default:
                    this.logger.warn(`Unhandled Nomba webhook event type: ${event.type}`);
            }

            return { success: true, message: "Webhook processed" };
        } catch (error) {
            this.logger.error(`Error processing Nomba webhook: ${error.message}`);
            return { success: false, message: "Processing error" };
        }
    }

    /**
     * Handle incoming payment (Normalized)
     */
    private async handleIncomingPayment(event: NormalizedPaymentEvent) {
        const { reference, amount, metadata } = event;

        if (!reference) {
            this.logger.warn("Missing reference in normalized payment event");
            return;
        }

        this.logger.log(`Processing incoming payment: ${amount} | Ref: ${reference}`);

        // Find the payment by reference
        const payment = await this.prisma.payment.findFirst({
            where: { reference },
        });

        if (payment) {
            // Check if this payment is linked to a Buy Order
            if (payment.orderId) {
                this.logger.log(`Payment identified as Buy Order payment (Order ID: ${payment.orderId}). Triggering fulfillment.`);
                try {
                    await this.buyOrderService.fulfillBuyOrder(reference);
                    this.logger.log(`Buy order fulfillment triggered for payment ${payment.id}`);
                    return;
                } catch (error) {
                    this.logger.error(`Failed to fulfill buy order for payment ${payment.id}: ${error.message}`);
                    return;
                }
            }

            // Update existing payment status (Generic)
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
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

        await this.prisma.payment.updateMany({
            where: { reference },
            data: {
                status: TransactionStatus.SUCCESS,
                paymentStatus: TransactionStatus.SUCCESS,
            },
        });
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

        await this.prisma.payment.updateMany({
            where: { reference },
            data: {
                status: TransactionStatus.FAILED,
                paymentStatus: TransactionStatus.FAILED,
            },
        });
    }
}
