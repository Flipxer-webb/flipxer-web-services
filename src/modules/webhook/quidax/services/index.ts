import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    QuidaxWebhook,
    ChargeSuccessData,
} from "../interfaces";
import logger from "moment-logger";

import { PrismaService } from "@/modules/core/prisma/services";

@Injectable()
export class QuidaxWebhookService implements QuidaxWebhook {
    constructor(private prisma: PrismaService) {}

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
        try {
        } catch (error) {
            logger.error(error);
        }
    }
}
