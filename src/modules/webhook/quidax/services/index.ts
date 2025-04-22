import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    QuidaxWebhook,
    WalletAddressGeneratedData,
    WalletUpdatedData,
} from "../interfaces";
import logger from "moment-logger";

import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "@/modules/api/trade/services";

@Injectable()
export class QuidaxWebhookService implements QuidaxWebhook {
    constructor(
        private prisma: PrismaService,
        private tradingService: TradingService
    ) {}

    async processWebhookEvent(eventBody: EventBody) {
        try {
            switch (eventBody.event) {
                case Event.WalletAddressGenerated: {
                    await this.walletAddressGeneratedHandler(
                        eventBody.data as WalletAddressGeneratedData
                    );
                    break;
                }

                case Event.WalletUpdatedEvent:
                    {
                        await this.walletUpdatedHandler(
                            eventBody.data as WalletUpdatedData
                        );
                    }
                    break;

                default:
                    break;
            }
        } catch (error) {
            logger.error(error);
        }
    }

    async walletAddressGeneratedHandler(eventData: WalletAddressGeneratedData) {
        switch (true) {
            default: {
                await this.processWalletAddress(eventData);
                break;
            }
        }
    }

    async walletUpdatedHandler(eventData: WalletUpdatedData) {
        switch (true) {
            default: {
                await this.tradingService.walletUpdatedHandler({
                    walletId: eventData.id,
                    balance: eventData.balance,
                    converted_balance: eventData.converted_balance,
                });
                break;
            }
        }
    }

    async processWalletAddress(eventData: WalletAddressGeneratedData) {
        try {
            this.tradingService.walletAddressCreatedSuccessHandler({
                walletId: eventData.id,
                walletAddress: eventData.address,
                balance: eventData.total_payments,
            });
        } catch (error) {
            logger.error(error);
        }
    }
}
