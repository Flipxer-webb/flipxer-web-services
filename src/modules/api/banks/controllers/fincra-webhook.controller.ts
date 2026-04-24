import {
    Controller,
    Post,
    Body,
    UseGuards,
    HttpCode,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { FincraWebhookGuard } from '../../auth/guard';
import { BankService } from '../services';
import { PrismaService } from '@/modules/core/prisma/services';
import { PaymentGatewayWebhookPayloadDto } from '../dtos/payment-webhook.dto';
import { PaymentWebhookAdapterService } from '@/modules/factory/bank/services/payment-webhook-adapter.service';
import { BuyOrderService } from '../../trade/services/buy-order.service';
import { SlackWebhookService } from '@/modules/api/operations/services/slack-webhook.service';
import {
    BuyOrderWebhookPayment,
    handleBuyOrderWebhookPayment,
} from '../services/buy-order-webhook-payment.util';

/**
 * Fincra Webhook Controller
 * 
 * Handles incoming webhooks from Fincra for payment collection events.
 * 
 * Fincra Events:
 * - collection.successful: Payment was successful
 * - collection.failed: Payment failed
 * - collection.pending: Payment is pending (rarely used)
 * 
 * Webhook URL to configure in Fincra Dashboard:
 * https://your-api-domain.com/api/webhooks/fincra
 */
@ApiTags('Webhooks')
@Controller('webhooks')
export class FincraWebhookController {
    private readonly logger = new Logger('FincraWebhookController');

    constructor(
        private readonly bankService: BankService,
        private readonly prisma: PrismaService,
        private readonly paymentWebhookAdapterService: PaymentWebhookAdapterService,
        private readonly buyOrderService: BuyOrderService,
        private readonly slackWebhookService: SlackWebhookService,
    ) { }

    @Post('fincra')
    @HttpCode(HttpStatus.OK)
    @UseGuards(FincraWebhookGuard)
    @ApiOperation({
        summary: 'Handle Fincra webhook events',
        description: 'Receives webhook notifications from Fincra for payment collection events',
    })
    async handleFincraWebhook(@Body() payload: PaymentGatewayWebhookPayloadDto) {
        const event = this.paymentWebhookAdapterService.normalizeFincraWebhook(payload as any);

        this.logger.log(`Received Fincra webhook: ${event.eventName}`);
        this.logger.log(`Reference: ${event.reference}`);
        this.logger.log(`Status: ${event.status}`);

        const reference = event.reference;

        if (!reference) {
            this.logger.warn('No reference found in webhook payload');
            return { success: false, message: 'No reference provided' };
        }

        // Persist raw webhook payload to WebhookLog for audit trail
        const providerReference = event.providerReference || reference;
        try {
            await this.prisma.webhookLog.upsert({
                where: {
                    provider_eventType_externalId: {
                        provider: 'fincra',
                        eventType: event.eventName,
                        externalId: providerReference,
                    },
                },
                create: {
                    provider: 'fincra',
                    eventType: event.eventName,
                    externalId: providerReference,
                    payload: payload as any,
                },
                update: {},
            });
        } catch (error) {
            this.logger.error(`Failed to log Fincra webhook: ${error.message}`);
        }

        // Store provider reference on the payment record for reconciliation
        try {
            if (providerReference !== reference) {
                await this.prisma.payment.updateMany({
                    where: { reference },
                    data: { externalReference: providerReference },
                });
            }
        } catch (error) {
            this.logger.error(`Failed to store Fincra externalReference: ${error.message}`);
        }

        try {
            await this.processNormalizedEvent(reference, event);

            return { success: true, message: `Webhook processed for event: ${event.eventName}` };
        } catch (error) {
            this.logger.error(`Error processing Fincra webhook: ${error.message}`, error.stack);
            throw error;
        }
    }

    private async processNormalizedEvent(reference: string, event: ReturnType<PaymentWebhookAdapterService["normalizeFincraWebhook"]>) {
        if (event.kind === 'incoming_payment') {
            await this.processIncomingPayment(reference, event);
            return;
        }

        if (event.kind === 'payout') {
            await this.processPayout(reference, event.status);
            return;
        }

        this.logger.warn(`Unknown Fincra event: ${event.eventName}`);
    }

    private async processIncomingPayment(reference: string, event: ReturnType<PaymentWebhookAdapterService["normalizeFincraWebhook"]>) {
        const status = event.status;
        if (status === 'successful') {
            this.logger.log(`Processing successful payment for reference: ${reference}`);

            const payment = await this.prisma.payment.findUnique({
                where: { reference },
            });

            if (payment?.orderId) {
                await handleBuyOrderWebhookPayment({
                    payment: payment as BuyOrderWebhookPayment,
                    event,
                    reference,
                    provider: 'fincra',
                    prisma: this.prisma,
                    buyOrderService: this.buyOrderService,
                    slackWebhookService: this.slackWebhookService,
                    logger: this.logger,
                });
                this.logger.log(`Successfully processed buy-order payment for reference: ${reference}`);
                return;
            }

            await this.bankService.paymentSuccessHandler(reference);
            this.logger.log(`Successfully processed payment for reference: ${reference}`);
            return;
        }

        if (status === 'failed') {
            this.logger.log(`Processing failed payment for reference: ${reference}`);
            await this.bankService.paymentFailedHandler(reference);
            this.logger.log(`Processed failed payment for reference: ${reference}`);
            return;
        }

        if (status === 'pending') {
            this.logger.log(`Payment pending for reference: ${reference}`);
        }
    }

    private async processPayout(reference: string, status: ReturnType<PaymentWebhookAdapterService["normalizeFincraWebhook"]>["status"]) {
        if (status === 'successful') {
            this.logger.log(`Payout successful for reference: ${reference}`);
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: reference,
                transferToBankStatus: 'SUCCESS' as any,
            });
            return;
        }

        if (status === 'failed') {
            this.logger.log(`Payout failed for reference: ${reference}`);
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: reference,
                transferToBankStatus: 'FAILED' as any,
            });
            return;
        }

        if (status === 'pending') {
            this.logger.log(`Payout pending for reference: ${reference}`);
        }
    }
}
