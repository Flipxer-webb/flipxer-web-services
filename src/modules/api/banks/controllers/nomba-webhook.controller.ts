import { Controller, Post, Get, Body, Headers, HttpCode, Logger, UnauthorizedException } from "@nestjs/common";
import { NombaWebhookPayload, NombaWebhookEventType } from "../dtos/nomba-webhook.dto";
import { PrismaService } from "@/modules/core/prisma/services";
import { TransactionStatus } from "@prisma/client";
import * as Config from "@/config";
import * as crypto from "crypto";

@Controller("webhooks")
export class NombaWebhookController {
    private readonly logger = new Logger(NombaWebhookController.name);

    constructor(private readonly prisma: PrismaService) { }

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
     * GET endpoint for Nomba webhook URL verification
     * Nomba tests the webhook URL before saving it
     */
    @Get("nomba")
    @HttpCode(200)
    verifyWebhookUrl() {
        return { status: "ok", message: "Nomba webhook endpoint active" };
    }

    @Post("nomba")
    @HttpCode(200)
    async handleWebhook(
        @Body() body: NombaWebhookPayload,
        @Headers("x-nomba-signature") signature: string
    ) {
        this.logger.log(`Received Nomba webhook: ${body.event}`);
        this.logger.debug(`Webhook data: ${JSON.stringify(body.data)}`);

        // Verify signature in production
        if (process.env.NODE_ENV === "production" && signature) {
            const isValid = this.verifySignature(JSON.stringify(body), signature);
            if (!isValid) {
                this.logger.error("Invalid Nomba webhook signature");
                throw new UnauthorizedException("Invalid webhook signature");
            }
        }

        try {
            switch (body.event) {
                case NombaWebhookEventType.VIRTUAL_ACCOUNT_CREDITED:
                case NombaWebhookEventType.TRANSACTION_COMPLETED:
                    await this.handleIncomingPayment(body.data);
                    break;

                case NombaWebhookEventType.TRANSFER_SUCCESSFUL:
                    await this.handleTransferSuccess(body.data);
                    break;

                case NombaWebhookEventType.TRANSFER_FAILED:
                    await this.handleTransferFailed(body.data);
                    break;

                default:
                    this.logger.warn(`Unhandled Nomba webhook event: ${body.event}`);
            }

            return { success: true, message: "Webhook processed" };
        } catch (error) {
            this.logger.error(`Error processing Nomba webhook: ${error}`);
            // Return 200 to prevent retries for processing errors
            return { success: false, message: "Processing error" };
        }
    }

    /**
     * Handle incoming payment to virtual account
     */
    private async handleIncomingPayment(data: NombaWebhookPayload["data"]) {
        const { accountRef, amount, reference, senderAccountName, senderAccountNumber } = data;

        if (!accountRef || !reference) {
            this.logger.warn("Missing accountRef or reference in incoming payment webhook");
            return;
        }

        this.logger.log(`Processing incoming payment: ${amount} to ${accountRef}`);

        // Find the payment by reference
        const payment = await this.prisma.payment.findFirst({
            where: { reference },
        });

        if (payment) {
            // Update existing payment status
            await this.prisma.payment.update({
                where: { id: payment.id },
                data: {
                    status: TransactionStatus.SUCCESS,
                    paymentStatus: TransactionStatus.SUCCESS,
                    // Note: Sender info stored in webhook logs if needed later
                },
            });
            this.logger.log(`Updated payment ${payment.id} to SUCCESS`);
        } else {
            this.logger.warn(`No payment found for reference: ${reference}`);
            // TODO: Handle unexpected payments - possibly create a new record
        }
    }

    /**
     * Handle successful bank transfer (payout)
     */
    private async handleTransferSuccess(data: NombaWebhookPayload["data"]) {
        const { merchantTxRef, reference } = data;
        const ref = merchantTxRef || reference;

        if (!ref) {
            this.logger.warn("Missing reference in transfer success webhook");
            return;
        }

        this.logger.log(`Processing transfer success: ${ref}`);

        await this.prisma.payment.updateMany({
            where: { reference: ref },
            data: {
                status: TransactionStatus.SUCCESS,
                paymentStatus: TransactionStatus.SUCCESS,
            },
        });
    }

    /**
     * Handle failed bank transfer (payout)
     */
    private async handleTransferFailed(data: NombaWebhookPayload["data"]) {
        const { merchantTxRef, reference } = data;
        const ref = merchantTxRef || reference;

        if (!ref) {
            this.logger.warn("Missing reference in transfer failed webhook");
            return;
        }

        this.logger.log(`Processing transfer failure: ${ref}`);

        await this.prisma.payment.updateMany({
            where: { reference: ref },
            data: {
                status: TransactionStatus.FAILED,
                paymentStatus: TransactionStatus.FAILED,
            },
        });

        // TODO: Implement refund logic if needed
    }
}
