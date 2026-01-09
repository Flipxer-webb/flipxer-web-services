import { Injectable, Logger } from "@nestjs/common";
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

import { PrismaService } from "@/modules/core/prisma/services";
import { TradingService } from "@/modules/api/trade/services";
import { OrderStatus } from "@prisma/client";

export interface WebhookMetrics {
    totalReceived: number;
    successfullyProcessed: number;
    failed: number;
    byEventType: Record<string, { received: number; processed: number; failed: number; avgProcessingMs: number }>;
    lastEventAt: Date | null;
    lastErrorAt: Date | null;
    lastError: string | null;
}

@Injectable()
export class QuidaxWebhookService implements QuidaxWebhook {
    private readonly logger = new Logger("QuidaxWebhookService");

    // Webhook metrics for monitoring
    private metrics: WebhookMetrics = {
        totalReceived: 0,
        successfullyProcessed: 0,
        failed: 0,
        byEventType: {},
        lastEventAt: null,
        lastErrorAt: null,
        lastError: null,
    };

    constructor(
        private prisma: PrismaService,
        private tradingService: TradingService
    ) { }

    /**
     * Get webhook processing metrics for monitoring
     */
    getMetrics(): WebhookMetrics {
        return { ...this.metrics };
    }

    /**
     * Reset metrics (useful for testing or periodic resets)
     */
    resetMetrics(): void {
        this.metrics = {
            totalReceived: 0,
            successfullyProcessed: 0,
            failed: 0,
            byEventType: {},
            lastEventAt: null,
            lastErrorAt: null,
            lastError: null,
        };
    }

    private trackMetric(eventType: string, processingTimeMs: number, success: boolean, error?: string): void {
        this.metrics.totalReceived++;
        this.metrics.lastEventAt = new Date();

        if (success) {
            this.metrics.successfullyProcessed++;
        } else {
            this.metrics.failed++;
            this.metrics.lastErrorAt = new Date();
            this.metrics.lastError = error || "Unknown error";
        }

        if (!this.metrics.byEventType[eventType]) {
            this.metrics.byEventType[eventType] = {
                received: 0,
                processed: 0,
                failed: 0,
                avgProcessingMs: 0,
            };
        }

        const eventMetric = this.metrics.byEventType[eventType];
        eventMetric.received++;

        if (success) {
            eventMetric.processed++;
            // Rolling average for processing time
            eventMetric.avgProcessingMs =
                (eventMetric.avgProcessingMs * (eventMetric.processed - 1) + processingTimeMs) / eventMetric.processed;
        } else {
            eventMetric.failed++;
        }
    }

    async processWebhookEvent(eventBody: EventBody) {
        const startTime = Date.now();
        const eventType = eventBody.event;

        // Log webhook receipt with full context for debugging
        this.logger.log(
            `[WEBHOOK_RECEIVED] Event: ${eventType} | ` +
            `Timestamp: ${new Date().toISOString()} | ` +
            `Data ID: ${(eventBody.data as any)?.id || 'N/A'}`
        );

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
                    this.logger.warn(`[WEBHOOK_UNHANDLED] Unhandled event type: ${eventType}`);
                    break;
            }

            // Track successful processing
            const processingTime = Date.now() - startTime;
            this.trackMetric(eventType, processingTime, true);

            this.logger.log(
                `[WEBHOOK_PROCESSED] Event: ${eventType} | ` +
                `Processing time: ${processingTime}ms | ` +
                `Total processed: ${this.metrics.successfullyProcessed}`
            );
        } catch (error) {
            const processingTime = Date.now() - startTime;
            this.trackMetric(eventType, processingTime, false, error.message);

            this.logger.error(
                `[WEBHOOK_ERROR] Event: ${eventType} | ` +
                `Error: ${error.message} | ` +
                `Processing time: ${processingTime}ms | ` +
                `Total failed: ${this.metrics.failed}`,
                error.stack
            );

            // Re-throw if you want the webhook endpoint to return an error status
            // For now, we swallow the error to acknowledge receipt to Quidax
        }
    }

    async depositHandler(eventData: DepositTransactionEventData) {
        // Normalize status - Quidax sends 'successful' or 'done' for completed deposits
        const normalizedStatus = this.normalizeDepositStatus(eventData.status);

        this.logger.log(
            `[DEPOSIT] Processing deposit: ${eventData.id} | Amount: ${eventData.amount} ${eventData.currency} | Status: ${eventData.status} -> ${normalizedStatus}`
        );

        const depositPayload = {
            referenceId: eventData.id,
            amount: eventData.amount,
            currency: eventData.currency,
            fee: eventData.fee,
            quidaxUserId: eventData.wallet.user.id,
            reason: eventData.reason,
            recipient: eventData.wallet.deposit_address,
            payment_address: eventData.payment_address?.address,
            payment_address_id: eventData.payment_address?.id,
            network: eventData.payment_address?.network,
            type: eventData.type,
            txid: eventData.txid,
            status: normalizedStatus,
            created_at: eventData.created_at,
            done_at: eventData.done_at,
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
                this.logger.log(`[DEPOSIT] Deposit ${eventData.id} processed successfully`);
                break;
            default: {
                this.logger.warn(
                    `[DEPOSIT] Unhandled deposit status: ${eventData.status} (normalized: ${normalizedStatus}) for deposit ${eventData.id}`
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
                this.logger.warn(`[STATUS] Unknown deposit status from Quidax: ${status}`);
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
                    referenceCurrency: eventData.reference_currency,
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
        const normalizedStatus = eventData.status.toLowerCase();

        // Log the withdrawal event status for debugging
        this.logger.log(`[WITHDRAWAL] Processing withdrawal: ${eventData.reference} | Status: ${eventData.status}`);

        switch (true) {
            case normalizedStatus === OrderStatus.done:
            case normalizedStatus === "successful":
            case normalizedStatus === "success":
            case normalizedStatus === "completed":
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
                    status: OrderStatus.done,
                });
                break;

            case normalizedStatus === OrderStatus.rejected:
            case normalizedStatus === OrderStatus.failed:
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
                    status: OrderStatus.failed, // Map rejected/failed to OrderStatus.failed
                });
                break;

            default: {
                this.logger.warn(
                    `[WITHDRAWAL] Unhandled withdrawal status: ${eventData.status} for reference ${eventData.reference}`
                );
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
            this.logger.error(`[WALLET_ADDRESS] Error processing wallet address: ${error.message}`, error.stack);
        }
    }
}
