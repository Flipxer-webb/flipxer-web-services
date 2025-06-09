import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    PaystackWebhook,
    ChargeSuccessData,
} from "../interfaces";
import logger from "moment-logger";

import { PrismaService } from "@/modules/core/prisma/services";
import { BankService } from "@/modules/api/banks/services";

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
}
