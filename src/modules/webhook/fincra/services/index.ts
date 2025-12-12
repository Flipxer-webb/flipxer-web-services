import { Injectable } from "@nestjs/common";
import logger from "moment-logger";
import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";
import { FincraWebhookPayload, FincraChargeData, FincraPayoutData } from "../interfaces";
import { TransactionStatus } from "@prisma/client";

@Injectable()
export class FincraWebhookService {
    constructor(
        private prisma: PrismaService,
        private bankService: BankService
    ) {}

    async processWebhookEvent(payload: FincraWebhookPayload) {
        try {
            const eventType = payload.event?.toLowerCase();

            // Handle payout/transfer events
            if (eventType?.includes("payout") || eventType?.includes("disbursement")) {
                await this.processPayoutEvent(payload.data as FincraPayoutData);
                return;
            }

            // Handle charge/collection events
            await this.processChargeEvent(payload.data as FincraChargeData);
        } catch (error) {
            logger.error(error);
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
        } catch (error) {
            logger.error(error, `Failed to update payout status for ${reference}`);
        }
    }
}
