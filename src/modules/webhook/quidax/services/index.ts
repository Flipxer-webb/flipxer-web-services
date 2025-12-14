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
        // Normalize status - Quidax sends 'successful' or 'done' for completed deposits
        const normalizedStatus = this.normalizeDepositStatus(eventData.status);
        
        const depositPayload = {
            referenceId: eventData.id,
            amount: eventData.amount,
            currency: eventData.currency,
            fee: eventData.fee,
            quidaxUserId: eventData.wallet.user.id,
            reason: eventData.reason,
            recipient: eventData.wallet.deposit_address,
            payment_address: eventData.payment_address.address,
            payment_address_id: eventData.payment_address.id,
            network: eventData.payment_address.network,
            type: eventData.type,
            txid: eventData.txid,
            status: normalizedStatus,
        };

        switch (normalizedStatus) {
            case OrderStatus.submitted:
            case OrderStatus.pending:
            case OrderStatus.processing:
            case OrderStatus.accepted:
            case OrderStatus.completed:
            case OrderStatus.done:
            case OrderStatus.on_hold:
            case OrderStatus.failed:
                await this.tradingService.depositHandler(depositPayload);
                break;
            default: {
                logger.warn(
                    `Unhandled deposit status: ${eventData.status} (normalized: ${normalizedStatus}) for deposit ${eventData.id}`
                );
                // Still process the deposit to ensure it's tracked
                await this.tradingService.depositHandler(depositPayload);
                break;
            }
        }
    }

    /**
     * Normalize Quidax deposit status to OrderStatus enum values
     * Quidax sends statuses like 'successful', 'done', 'confirming' which need to be mapped
     */
    private normalizeDepositStatus(status: string): OrderStatus {
        const statusLower = status?.toLowerCase();
        switch (statusLower) {
            case "successful":
            case "success":
            case "done":
            case "completed":
                return OrderStatus.accepted; // accepted triggers balance update and notifications
            case "submitted":
            case "pending":
            case "confirming":
            case "processing":
                return OrderStatus.submitted;
            case "accepted":
                return OrderStatus.accepted;
            case "on_hold":
                return OrderStatus.on_hold;
            case "failed":
            case "failed_aml":
            case "rejected":
                return OrderStatus.failed;
            default:
                // Log unknown status and default to submitted for tracking
                logger.warn(`Unknown deposit status from Quidax: ${status}`);
                return OrderStatus.submitted;
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
                    orderId: eventData.id,
                    status: OrderStatus.completed,
                });
                break;
            case eventData.status === OrderStatus.failed:
                await this.tradingService.swapTransactionHandler({
                    orderId: eventData.id,
                    status: OrderStatus.failed,
                });
                break;
            case eventData.status === OrderStatus.reversed:
                await this.tradingService.swapTransactionHandler({
                    orderId: eventData.id,
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
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
                    status: OrderStatus.done,
                });
                break;
            case eventData.status.toLowerCase() === OrderStatus.rejected:
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
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
