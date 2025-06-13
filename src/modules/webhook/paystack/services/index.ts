import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    PaystackWebhook,
    ChargeSuccessData,
    TransferData,
} from "../interfaces";
import logger from "moment-logger";

import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";
import { AssetValueToBankTransferStatus } from "@/modules/api/banks/interfaces";

@Injectable()
export class PaystackWebhookService implements PaystackWebhook {
    constructor(
        private prisma: PrismaService,
        private bankService: BankService
    ) {}

    async processWebhookEvent(eventBody: EventBody) {
        try {
            switch (eventBody.event) {
                case Event.ChargeSuccessEvent: {
                    await this.chargeSuccessHandler(
                        eventBody.data as ChargeSuccessData
                    );
                    break;
                }

                case Event.TransferSuccessEvent: {
                    await this.transferSuccessHandler(
                        eventBody.data as TransferData
                    );
                    break;
                }
                case Event.TransferFailedEvent: {
                    await this.transferFailedHandler(
                        eventBody.data as TransferData
                    );
                    break;
                }
                case Event.TransferReversedEvent: {
                    await this.transferFailedHandler(
                        eventBody.data as TransferData
                    );
                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            logger.error(error);
        }
    }

    async chargeSuccessHandler(eventData: ChargeSuccessData) {
        switch (true) {
            default: {
                //other successful payment
                await this.processPayment(eventData);
                break;
            }
        }
    }

    async processPayment(eventData: ChargeSuccessData) {
        await this.bankService.paymentSuccessHandler(eventData.reference);
    }

    async transferSuccessHandler(eventData: TransferData) {
        try {
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: eventData.reference,
                transferToBankStatus: AssetValueToBankTransferStatus.SUCCESS,
            });
        } catch (error) {
            logger.error(error);
        }
    }
    async transferFailedHandler(eventData: TransferData) {
        try {
            await this.bankService.processAssetValueTransferToBankHandler({
                paymentReference: eventData.reference,
                transferToBankStatus: AssetValueToBankTransferStatus.FAILED,
            });
        } catch (error) {
            logger.error(error);
        }
    }
}
