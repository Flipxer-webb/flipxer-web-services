import { Injectable } from "@nestjs/common";
import {
    EventBody,
    Event,
    QuidaxWebhook,
    WalletAddressGeneratedData,
    WalletUpdatedData,
    SwapTransactionEventData,
    WithdrawerEventData,
    DepositTransactionEventData,
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

                case Event.WithdrawSuccessful:
                    {
                        await this.withdrawerTransactionHandler(
                            eventBody.data as WithdrawerEventData
                        );
                    }
                    break;
                case Event.WithdrawRejected:
                    {
                        await this.withdrawerTransactionHandler(
                            eventBody.data as WithdrawerEventData
                        );
                    }
                    break;
                case Event.DepositTransactionConfirmation:
                    {
                        await this.depositHandler(
                            eventBody.data as DepositTransactionEventData
                        );
                    }
                    break;
                case Event.DepositTransactionSuccessful:
                    {
                        await this.depositHandler(
                            eventBody.data as DepositTransactionEventData
                        );
                    }
                    break;

                case Event.DepositTransactionOnHold:
                    {
                        await this.depositHandler(
                            eventBody.data as DepositTransactionEventData
                        );
                    }
                    break;
                case Event.DepositTransactionFailedAml:
                    {
                        await this.depositHandler(
                            eventBody.data as DepositTransactionEventData
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

    async depositHandler(eventData: DepositTransactionEventData) {
        switch (true) {
            case eventData.status === OrderStatus.submitted:
                await this.tradingService.depositHandler({
                    referenceId: eventData.id,
                    amount: eventData.amount,
                    currency: eventData.currency,
                    fee: eventData.fee,
                    quidaxUserId: eventData.wallet.user.id,
                    reason: eventData.reason,
                    recipient: eventData.wallet.deposit_address,
                    type: eventData.type,
                    txid: eventData.txid,
                    status: OrderStatus.submitted,
                });
                break;
            case eventData.status === OrderStatus.accepted:
                await this.tradingService.depositHandler({
                    referenceId: eventData.id,
                    amount: eventData.amount,
                    currency: eventData.currency,
                    fee: eventData.fee,
                    quidaxUserId: eventData.wallet.user.id,
                    reason: eventData.reason,
                    recipient: eventData.wallet.deposit_address,
                    type: eventData.type,
                    txid: eventData.txid,
                    status: OrderStatus.accepted,
                });
                break;
            case eventData.status === OrderStatus.on_hold:
                await this.tradingService.depositHandler({
                    referenceId: eventData.id,
                    amount: eventData.amount,
                    currency: eventData.currency,
                    fee: eventData.fee,
                    quidaxUserId: eventData.wallet.user.id,
                    reason: eventData.reason,
                    recipient: eventData.wallet.deposit_address,
                    type: eventData.type,
                    txid: eventData.txid,
                    status: OrderStatus.on_hold,
                });
                break;
            case eventData.status === "failed_aml":
                await this.tradingService.depositHandler({
                    referenceId: eventData.id,
                    amount: eventData.amount,
                    currency: eventData.currency,
                    fee: eventData.fee,
                    quidaxUserId: eventData.wallet.user.id,
                    reason: eventData.reason,
                    recipient: eventData.wallet.deposit_address,
                    type: eventData.type,
                    txid: eventData.txid,
                    status: OrderStatus.failed,
                });
                break;
            default: {
                break;
            }
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
                    convertedBalance: eventData.converted_balance,
                    depositAddress: eventData.deposit_address,
                    destinationTag: eventData.destination_tag,
                    locked: eventData.locked,
                    staked: eventData.staked,
                    updatedAt: eventData.updated_at,
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

    async withdrawerTransactionHandler(eventData: WithdrawerEventData) {
        switch (true) {
            case eventData.status.toLowerCase() === OrderStatus.done:
                await this.tradingService.swapTransactionHandler({
                    orderReference: eventData.id,
                    status: OrderStatus.completed,
                });
                break;
            case eventData.status.toLowerCase() === OrderStatus.rejected:
                await this.tradingService.swapTransactionHandler({
                    orderReference: eventData.id,
                    status: OrderStatus.failed,
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
