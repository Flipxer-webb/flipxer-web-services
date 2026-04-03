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

    // Maximum age for webhook events (5 minutes)
    private readonly MAX_WEBHOOK_AGE_MS = 5 * 60 * 1000;

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
        private readonly prisma: PrismaService,
        private readonly tradingService: TradingService
    ) { }

    /**
     * Validates webhook event timestamp to prevent replay attacks
     * 
     * @param eventData Event data containing created_at timestamp
     * @returns true if valid, false if too old
     */
    private isWebhookTimestampValid(eventData: any): { valid: boolean; ageMs: number } {
        // Prefer updated_at over created_at for staleness checks.
        // For "wallet.updated" events, created_at is when the wallet was
        // originally provisioned (potentially months/years ago), while
        // updated_at reflects the moment the event actually occurred.
        const timestamp =
            eventData?.updated_at || eventData?.data?.updated_at ||
            eventData?.created_at || eventData?.data?.created_at;
        
        if (!timestamp) {
            // If no timestamp, allow for backward compatibility but log warning
            this.logger.warn(`Webhook received without timestamp - allowing for compatibility`);
            return { valid: true, ageMs: 0 };
        }

        const eventTime = new Date(timestamp).getTime();
        const now = Date.now();
        const ageMs = now - eventTime;

        // Allow future timestamps (clock skew) up to 1 minute
        if (ageMs < -60000) {
            this.logger.warn(`Webhook has future timestamp | age: ${ageMs}ms`);
            return { valid: false, ageMs };
        }

        return {
            valid: ageMs <= this.MAX_WEBHOOK_AGE_MS,
            ageMs,
        };
    }

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

        // SECURITY: Validate webhook timestamp to prevent replay attacks
        const timestampCheck = this.isWebhookTimestampValid(eventBody.data);
        if (!timestampCheck.valid) {
            this.logger.error(
                `[WEBHOOK_REJECTED] Stale webhook rejected | ` +
                `Event: ${eventType} | ` +
                `Age: ${Math.round(timestampCheck.ageMs / 1000)}s | ` +
                `Max allowed: ${this.MAX_WEBHOOK_AGE_MS / 1000}s | ` +
                `Data ID: ${(eventBody.data as any)?.id || 'N/A'}`
            );
            throw new Error(`Webhook rejected: event is ${Math.round(timestampCheck.ageMs / 1000)} seconds old (max: ${this.MAX_WEBHOOK_AGE_MS / 1000}s)`);
        }

        try {
            switch (eventBody.event) {
                case Event.WalletAddressGenerated:
                    await this.walletAddressGeneratedHandler(
                        eventBody.data as WalletAddressGeneratedData
                    );
                    break;

                case Event.WalletUpdatedEvent:
                    await this.walletUpdatedHandler(
                        eventBody.data as WalletUpdatedData
                    );
                    break;

                case Event.SwapTransactionCompleted:
                case Event.SwapTransactionRevered:
                case Event.SwapTransactionFailed:
                    await this.swapTransactionHandlerHandler(
                        eventBody.data as SwapTransactionEventData
                    );
                    break;

                case Event.WithdrawSuccessful:
                case Event.WithdrawRejected:
                    await this.withdrawerTransactionHandler(
                        eventBody.data as WithdrawerEventData
                    );
                    break;

                case Event.DepositTransactionConfirmation:
                case Event.DepositTransactionSuccessful:
                case Event.DepositTransactionOnHold:
                case Event.DepositTransactionFailedAml:
                    await this.depositHandler(
                        eventBody.data as DepositTransactionEventData
                    );
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
        await this.processWalletAddress(eventData);
    }

    async walletUpdatedHandler(eventData: WalletUpdatedData) {
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
    }

    async swapTransactionHandlerHandler(eventData: SwapTransactionEventData) {
        const normalizedStatus = eventData.status?.toLowerCase();

        if (["completed", "done", "successful", "success", "accepted"].includes(normalizedStatus)) {
            await this.tradingService.swapTransactionHandler({
                orderId: eventData.id,
                status: OrderStatus.completed,
            });
            return;
        }

        if (["failed", "rejected"].includes(normalizedStatus)) {
            await this.tradingService.swapTransactionHandler({
                orderId: eventData.id,
                status: OrderStatus.failed,
            });
            return;
        }

        if (["reversed"].includes(normalizedStatus)) {
            await this.tradingService.swapTransactionHandler({
                orderId: eventData.id,
                status: OrderStatus.reversed,
            });
            return;
        }

        this.logger.warn(
            `[SWAP] Unhandled swap status: ${eventData.status} for swap transaction ${eventData.id}`
        );
    }

    async withdrawerTransactionHandler(eventData: WithdrawerEventData) {
        const normalizedStatus = eventData.status.toLowerCase();

        // Log the withdrawal event status for debugging
        this.logger.log(`[WITHDRAWAL] Processing withdrawal: ${eventData.reference} | Status: ${eventData.status}`);

        // Route sweep webhooks to SweepService via TradingService facade.
        // Sweep references are prefixed with "sweep-" and should never hit
        // the Order lookup path (which would throw TransactionNotFoundException).
        if (eventData.reference?.startsWith('sweep-')) {
            const sweepStatus =
                normalizedStatus === 'done' ||
                normalizedStatus === 'successful' ||
                normalizedStatus === 'success' ||
                normalizedStatus === 'completed'
                    ? 'completed' as const
                    : 'failed' as const;

            this.logger.log(
                `[WITHDRAWAL] Routing sweep webhook | txId: ${eventData.id} | reference: ${eventData.reference} | status: ${sweepStatus} | reason: ${eventData.reason ?? 'none'}`
            );

            await this.tradingService.handleSweepConfirmation(
                eventData.id,
                sweepStatus,
                eventData.reason ?? undefined
            );
            return;
        }

        switch (true) {
            case normalizedStatus === OrderStatus.done:
            case normalizedStatus === "successful":
            case normalizedStatus === "success":
            case normalizedStatus === "completed":
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
                    status: OrderStatus.done,
                    txid: eventData.txid,
                });
                break;

            case normalizedStatus === OrderStatus.rejected:
            case normalizedStatus === OrderStatus.failed:
                await this.tradingService.withdrawerTransactionHandler({
                    orderReference: eventData.reference,
                    status: OrderStatus.failed, // Map rejected/failed to OrderStatus.failed
                    txid: eventData.txid,
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
            await this.tradingService.walletAddressCreatedSuccessHandler({
                walletAddressId: eventData.id,
                walletAddress: eventData.address,
                totalPayments: eventData.total_payments,
            });
        } catch (error) {
            this.logger.error(`[WALLET_ADDRESS] Error processing wallet address: ${error.message}`, error.stack);
        }
    }
}
