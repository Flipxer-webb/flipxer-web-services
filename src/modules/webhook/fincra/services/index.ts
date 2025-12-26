import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";
import { FincraWebhookPayload, FincraChargeData, FincraPayoutData } from "../interfaces";
import { TransactionStatus } from "@prisma/client";

@Injectable()
export class FincraWebhookService {
    private readonly logger = new Logger('FincraWebhookService');

    constructor(
        private prisma: PrismaService,
        private bankService: BankService
    ) { }

    async processWebhookEvent(payload: FincraWebhookPayload) {
        const eventType = payload.event?.toLowerCase();
        const reference = (payload.data as any)?.merchantReference || (payload.data as any)?.reference;

        this.logger.log(`Processing Fincra webhook: event=${eventType}, reference=${reference}`);
        this.logger.debug(`Full payload: ${JSON.stringify(payload)}`);

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

        if (!reference) return;

        // Update the payment record based on payout status
        switch (status) {
            case "successful":
                await this.updatePayoutStatus(reference, TransactionStatus.SUCCESS);
                break;
            case "failed":
                await this.updatePayoutStatus(reference, TransactionStatus.FAILED);
                break;
            case "processing":
            case "pending":
            default:
                // leave as pending
                break;
        }
    }

    private async updatePayoutStatus(reference: string, status: TransactionStatus) {
        try {
            await this.prisma.payment.updateMany({
                where: { reference },
                data: { status },
            });
            this.logger.log(`Updated payout status for ${reference} to ${status}`);
        } catch (error) {
            this.logger.error(`Failed to update payout status for ${reference}: ${error.message}`);
        }
    }
}
