import { Injectable, Logger } from "@nestjs/common";
import {
    DepositTransaction,
    SwapTransactionHandlerOptions,
    WithdrawerTransactionHandlerOptions,
} from "../interfaces/trade";
import { DepositWebhookHandler } from "./webhook-handlers/deposit-webhook.handler";
import { SwapWebhookHandler } from "./webhook-handlers/swap-webhook.handler";
import { WithdrawalWebhookHandler } from "./webhook-handlers/withdrawal-webhook.handler";

/**
 * WebhookHandlerService
 * 
 * Facade service that coordinates webhook processing.
 * Delegates to specialized handlers for each transaction type:
 * - DepositWebhookHandler: Incoming crypto deposits
 * - SwapWebhookHandler: Crypto-to-crypto swaps
 * - WithdrawalWebhookHandler: Outgoing crypto withdrawals
 * 
 * Each handler uses distributed locks to prevent race conditions
 * from duplicate webhook deliveries.
 */
@Injectable()
export class WebhookHandlerService {
    private readonly logger = new Logger("WebhookHandlerService");

    constructor(
        private readonly depositWebhookHandler: DepositWebhookHandler,
        private readonly swapWebhookHandler: SwapWebhookHandler,
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler
    ) {}

    /**
     * Handle incoming deposit webhook from Quidax
     * Delegates to DepositWebhookHandler
     */
    async depositHandler(options: DepositTransaction) {
        this.logger.debug(`Delegating deposit webhook | referenceId: ${options.referenceId}`);
        return this.depositWebhookHandler.handle(options);
    }

    /**
     * Handle swap transaction webhook from Quidax
     * Delegates to SwapWebhookHandler
     */
    async swapTransactionHandler(options: SwapTransactionHandlerOptions) {
        this.logger.debug(`Delegating swap webhook | orderId: ${options.orderId}`);
        return this.swapWebhookHandler.handle(options);
    }

    /**
     * Handle withdrawal transaction webhook from Quidax
     * Delegates to WithdrawalWebhookHandler
     */
    async withdrawerTransactionHandler(options: WithdrawerTransactionHandlerOptions) {
        this.logger.debug(`Delegating withdrawal webhook | orderReference: ${options.orderReference}`);
        return this.withdrawalWebhookHandler.handle(options);
    }
}
