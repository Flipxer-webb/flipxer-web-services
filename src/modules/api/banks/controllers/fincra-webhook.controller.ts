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
import { FincraWebhookPayloadDto } from '../dtos/fincra-webhook.dto';

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
    ) { }

    @Post('fincra')
    @HttpCode(HttpStatus.OK)
    @UseGuards(FincraWebhookGuard)
    @ApiOperation({
        summary: 'Handle Fincra webhook events',
        description: 'Receives webhook notifications from Fincra for payment collection events',
    })
    async handleFincraWebhook(@Body() payload: FincraWebhookPayloadDto) {
        const { event, data } = payload;

        this.logger.log(`Received Fincra webhook: ${event}`);
        this.logger.log(`Reference: ${data.reference || data.merchantReference}`);
        this.logger.log(`Status: ${data.status}`);

        // Use merchantReference as that's what we set as our reference during initializePayment
        const reference = data.merchantReference || data.reference;

        if (!reference) {
            this.logger.warn('No reference found in webhook payload');
            return { success: false, message: 'No reference provided' };
        }

        // Persist raw webhook payload to WebhookLog for audit trail
        const providerReference = data.reference || reference;
        try {
            await this.prisma.webhookLog.upsert({
                where: {
                    provider_eventType_externalId: {
                        provider: 'fincra',
                        eventType: event,
                        externalId: providerReference,
                    },
                },
                create: {
                    provider: 'fincra',
                    eventType: event,
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
            switch (event) {
                case 'collection.successful':
                    this.logger.log(`Processing successful payment for reference: ${reference}`);
                    await this.bankService.paymentSuccessHandler(reference);
                    this.logger.log(`Successfully processed payment for reference: ${reference}`);
                    break;

                case 'collection.failed':
                    this.logger.log(`Processing failed payment for reference: ${reference}`);
                    await this.bankService.paymentFailedHandler(reference);
                    this.logger.log(`Processed failed payment for reference: ${reference}`);
                    break;

                case 'collection.pending':
                    this.logger.log(`Payment pending for reference: ${reference}`);
                    // No action needed for pending payments
                    break;

                case 'payout.successful':
                    this.logger.log(`Payout successful for reference: ${reference}`);
                    await this.bankService.processAssetValueTransferToBankHandler({
                        paymentReference: reference,
                        transferToBankStatus: 'SUCCESS' as any,
                    });
                    break;

                case 'payout.failed':
                    this.logger.log(`Payout failed for reference: ${reference}`);
                    await this.bankService.processAssetValueTransferToBankHandler({
                        paymentReference: reference,
                        transferToBankStatus: 'FAILED' as any,
                    });
                    break;

                default:
                    this.logger.warn(`Unknown Fincra event: ${event}`);
            }

            return { success: true, message: `Webhook processed for event: ${event}` };
        } catch (error) {
            this.logger.error(`Error processing Fincra webhook: ${error.message}`, error.stack);
            // Still return 200 to prevent Fincra from retrying
            return { success: false, message: error.message };
        }
    }
}
