import { Controller, Post, Get, Body, Headers, HttpCode, Logger, UnauthorizedException } from "@nestjs/common";
import { NombaWebhookPayload, NombaWebhookEventType } from "../dtos/nomba-webhook.dto";
import { NormalizedPaymentEvent } from "../types/payment-event.interface";
import { PrismaService } from "@/modules/core/prisma/services";
import { TransactionStatus } from "@prisma/client";
import * as Config from "@/config";
import * as crypto from "crypto";
import { BuyOrderService } from "../../trade/services/buy-order.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";

@Controller("webhooks")
export class NombaWebhookController {
    private readonly logger = new Logger(NombaWebhookController.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly buyOrderService: BuyOrderService,
        private readonly slackWebhookService: SlackWebhookService,
    ) { }

    /**
     * Verify webhook signature from Nomba.
     *
     * Per Nomba docs, the HMAC payload is NOT the raw body — it's a colon-separated
     * string built from specific fields:
     *   event_type:requestId:merchant.userId:merchant.walletId:transaction.transactionId
     *   :transaction.type:transaction.time:transaction.responseCode:nomba-timestamp
     *
     * The HMAC is SHA-256 with the webhook secret key, base64-encoded.
     */
    private verifySignature(body: any, signature: string, timestamp: string): boolean {
        const webhookSecret = Config.nombaOptions?.webhookSecret;
        if (!webhookSecret) {
            this.logger.warn("Nomba webhook secret not configured - skipping signature verification");
            return true;
        }

        const data = body.data || {};
        const merchant = data.merchant || {};
        const transaction = data.transaction || {};

        // Nomba treats "null" responseCode as empty string
        let responseCode = transaction.responseCode ?? "";
        if (responseCode === "null") responseCode = "";

        // Construct the signing payload exactly as documented by Nomba
        const hashingPayload = [
            body.event_type || body.event || "",
            body.requestId || body.request_id || "",
            merchant.userId || "",
            merchant.walletId || "",
            transaction.transactionId || "",
            transaction.type || "",
            transaction.time || "",
            responseCode,
            timestamp || "",
        ].join(":");

        this.logger.log(`[SIG] Hashing payload: ${hashingPayload}`);

        const expectedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(hashingPayload)
            .digest("base64");

        this.logger.log(`[SIG] Expected: ${expectedSignature.substring(0, 16)}... Received: ${signature.substring(0, 16)}...`);

        // Timing-safe comparison
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSignature);

        if (sigBuf.length !== expectedBuf.length) {
            this.logger.error(`[SIG] Length mismatch: received=${sigBuf.length}, expected=${expectedBuf.length}`);
            return false;
        }

        return crypto.timingSafeEqual(sigBuf, expectedBuf);
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
        //    - order.orderReference              → checkout/order flow
        //    - data.reference                    → generic events
        //    - data.accountRef                   → virtual-account credit events (VA buy flow)
        //    - transaction.accountRef            → payment_success with nested transaction
        //    - transaction.aliasAccountReference → actual Nomba VA payment_success field (prod)
        //    - transaction.reference             → alternative transaction-level ref
        //    - transaction.merchantTxRef         → last-resort fallback (Nomba's own ref)
        const reference = order.orderReference
            || data.reference
            || data.accountRef
            || transaction.accountRef
            || transaction.aliasAccountReference
            || transaction.reference
            || transaction.merchantTxRef;

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
                accountRef: data.accountRef || transaction.accountRef || transaction.aliasAccountReference || order.accountId,
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
        @Headers() headers: any,
    ) {
        this.logger.log(`Raw Webhook Headers: ${JSON.stringify(headers)}`);
        this.logger.log(`Raw Webhook Body: ${JSON.stringify(body)}`);

        const signature = headers["nomba-signature"]
            || headers["nomba-sig-value"]
            || headers["x-nomba-signature"];
        const timestamp = headers["nomba-timestamp"];

        // 1. Basic Validation
        if (!body || (!body.event_type && !body.event)) {
            this.logger.log("Received webhook verification/test request from Nomba");
            return { status: "ok", message: "Webhook received" };
        }

        // 2. Signature Verification (Security First)
        //    Nomba signs a colon-separated string of specific fields (not the raw body).
        //    See: https://developer.nomba.com/docs/api-basics/webhook#webhook-signature-verification
        if (process.env.NODE_ENV === "production" && signature) {
            this.logger.log(`Signature verification — timestamp: ${timestamp || 'NONE'}, sig: ${signature.substring(0, 12)}...`);
            const isValid = this.verifySignature(body, signature, timestamp);
            if (!isValid) {
                this.logger.error("Invalid Nomba webhook signature");
                throw new UnauthorizedException("Invalid webhook signature");
            }
        }

        try {
            // 3. Normalize Payload (The Fix)
            const event = this.normalizePayload(body);
            this.logger.log(
                `Normalized Nomba Event: ${event.type} | Ref: ${event.reference} | Amount: ${event.amount} | Provider Ref: ${event.providerReference}`
            );

            // 3.5 Persist webhook payload to WebhookLog for audit trail & reconciliation
            await this.logWebhook(event);

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
                        eventType: event.type,
                        externalId,
                    },
                },
                create: {
                    provider: 'nomba',
                    eventType: event.type,
                    externalId,
                    payload: event.raw,
                },
                update: {}, // No-op on duplicate — already logged
            });
        } catch (error) {
            // Non-fatal: don't block payment processing if logging fails
            this.logger.error(`Failed to log webhook: ${error.message}`);
        }
    }

    /**
     * Handle incoming payment (Normalized)
     */
    private async handleIncomingPayment(event: NormalizedPaymentEvent) {
        const { reference, amount, metadata } = event;

        if (!reference) {
            this.logger.error(
                `Missing reference in normalized payment event. Raw event_type: ${event.raw?.event_type || event.raw?.event}. ` +
                `Keys in data: ${Object.keys(event.raw?.data || {}).join(', ')}`
            );
            throw new Error(
                'Cannot process payment webhook: no reference could be extracted from the payload'
            );
        }

        this.logger.log(`Processing incoming payment: ${amount} | Ref: ${reference}`);

        // Find the payment by reference
        const payment = await this.prisma.payment.findFirst({
            where: { reference },
        });

        if (payment) {
            // Check if this payment is linked to a Buy Order
            if (payment.orderId) {
                // Validate incoming amount against expected amount (1% tolerance for bank fees/rounding)
                const expectedAmount = Number(payment.totalAmount);
                if (expectedAmount > 0 && amount < expectedAmount * 0.99) {
                    this.logger.error(
                        `Underpayment detected | Ref: ${reference} | Expected: ${expectedAmount} | Received: ${amount}`
                    );
                    await this.slackWebhookService.sendWebhookFailureAlert(
                        'nomba',
                        reference,
                        `Underpayment: received ${amount} but expected ${expectedAmount}. Order NOT auto-fulfilled. Admin review required.`,
                        {
                            orderId: payment.orderId,
                            userId: payment.userId,
                            expectedAmount,
                            receivedAmount: amount,
                            shortfall: expectedAmount - amount,
                        }
                    );
                    // Don't fulfill — payment stays PENDING for admin review
                    return;
                }

                // Store provider reference for reconciliation audit trail
                if (event.providerReference) {
                    await this.prisma.payment.update({
                        where: { id: payment.id },
                        data: { externalReference: event.providerReference },
                    });
                }

                this.logger.log(`Payment identified as Buy Order payment (Order ID: ${payment.orderId}). Triggering fulfillment.`);
                // Let errors propagate so webhook returns 5xx and Nomba retries
                await this.buyOrderService.fulfillBuyOrder(reference);
                this.logger.log(`Buy order fulfillment completed for payment ${payment.id}`);
                return;
            }

            // Update existing payment status (Generic) + store provider ref
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
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                    ...(event.providerReference ? { externalReference: event.providerReference } : {}),
                },
            });
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

        await this.prisma.payment.updateMany({
            where: { reference },
            data: {
                status: TransactionStatus.FAILED,
                paymentStatus: TransactionStatus.FAILED,
            },
        });
    }
}
