import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    QuidaxWebhook,
    WalletAddressGeneratedData,
    WalletUpdatedData,
    SwapTransactionEventData,
} from "../interfaces";
import logger from "moment-logger";

import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "@/modules/api/trade/services";
import { OrderStatus } from "@prisma/client";

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

                case Event.SwapTransactionCompleted:
                    {
                        await this.swapTransactionHandlerHandler(
                            eventBody.data as SwapTransactionEventData
                        );
                    }
                    break;
                case Event.SwapTransactionRevered:
                    {
                        await this.swapTransactionHandlerHandler(
                            eventBody.data as SwapTransactionEventData
                        );
                    }
                    break;

                case Event.SwapTransactionFailed:
                    {
                        await this.swapTransactionHandlerHandler(
                            eventBody.data as SwapTransactionEventData
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

    async swapTransactionHandlerHandler(eventData: SwapTransactionEventData) {
        switch (true) {
            case eventData.status === OrderStatus.completed:
                await this.tradingService.swapTransactionHandler({
                    orderReference: eventData.id,
                    status: OrderStatus.completed,
                });
                break;
            case eventData.status === OrderStatus.failed:
                await this.tradingService.swapTransactionHandler({
                    orderReference: eventData.id,
                    status: OrderStatus.failed,
                });
                break;
            case eventData.status === OrderStatus.reversed:
                await this.tradingService.swapTransactionHandler({
                    orderReference: eventData.id,
                    status: OrderStatus.reversed,
                });
                break;
            default: {
                break;
            }
        }
    }

    async processWalletAddress(eventData: WalletAddressGeneratedData) {
        try {
            this.tradingService.walletAddressCreatedSuccessHandler({
                walletAddressId: eventData.id,
                walletAddress: eventData.address,
                totalPayments: eventData.total_payments,
            });
        } catch (error) {
            logger.error(error);
        }
    }
}
