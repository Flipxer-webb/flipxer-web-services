import { Injectable, Logger } from "@nestjs/common";
import { SellPayoutProvider } from "@/config";
import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { PrismaService } from "@/modules/core/prisma/services";
import {
    OrderCategory,
    OrderStatus,
    OrderStreamlinedStatus,
    Prisma,
    TransactionStatus,
} from "@prisma/client";
import { WsGateway } from "../gateway/v1";
import { WithdrawalWebhookHandler } from "./webhook-handlers/withdrawal-webhook.handler";

type SellPayoutOutcome = "SUCCESS" | "FAILED";
type PrismaOrderClient = Prisma.TransactionClient | PrismaService;

const sellPayoutOrderSelection = {
    id: true,
    orderCategory: true,
    status: true,
    streamlinedStatus: true,
    paymentStatus: true,
    transactionId: true,
    amount: true,
    currency: true,
    totalToReceiveInFiat: true,
    destinationBankName: true,
    destinationBankAccountNumber: true,
    createdAt: true,
    updatedAt: true,
    user: { select: { id: true, email: true } },
} satisfies Prisma.OrderSelect;

type SellPayoutOrderRecord = Prisma.OrderGetPayload<{
    select: typeof sellPayoutOrderSelection;
}>;

export type SellPayoutStateTransition = {
    provider: SellPayoutProvider;
    reference: string;
    status: SellPayoutOutcome;
    order: SellPayoutOrderRecord;
};

@Injectable()
export class SellPayoutReconciliationService {
    private readonly logger = new Logger("SellPayoutReconciliationService");

    constructor(
        private readonly prisma: PrismaService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly wsGateway: WsGateway,
        private readonly withdrawalWebhookHandler: WithdrawalWebhookHandler,
        private readonly slackWebhookService: SlackWebhookService,
    ) { }

    async reconcileSellPayout(options: {
        orderId: number;
        provider: SellPayoutProvider;
        reference: string;
        status: SellPayoutOutcome;
    }): Promise<boolean> {
        const transition = await this.prisma.$transaction(async (tx) => {
            return this.reconcileSellPayoutState(tx, options);
        });

        if (!transition) {
            return false;
        }

        await this.executeSellPayoutSideEffects(transition);
        return true;
    }

    async reconcileSellPayoutState(
        client: PrismaOrderClient,
        options: {
            orderId: number;
            provider: SellPayoutProvider;
            reference: string;
            status: SellPayoutOutcome;
        },
    ): Promise<SellPayoutStateTransition | null> {
        const order = await client.order.findUnique({
            where: { id: options.orderId },
            select: sellPayoutOrderSelection,
        });

        if (!order) {
            this.logger.warn(
                `Skipping ${options.provider} payout reconciliation for missing order ${options.orderId}`
            );
            return null;
        }

        if (order.orderCategory !== OrderCategory.SELL) {
            return null;
        }

        if (order.status !== OrderStatus.processing) {
            this.logger.warn(
                `Ignoring ${options.provider} payout ${options.status.toLowerCase()} for SELL order ${order.id} with status ${order.status}`
            );
            return null;
        }

        if (options.status === TransactionStatus.SUCCESS) {
            const updatedOrder = await client.order.update({
                where: { id: order.id },
                data: {
                    status: OrderStatus.done,
                    streamlinedStatus: OrderStreamlinedStatus.completed,
                    paymentStatus: TransactionStatus.SUCCESS,
                    fulfilled: true,
                    reason: null,
                },
                select: sellPayoutOrderSelection,
            });

            return {
                provider: options.provider,
                reference: options.reference,
                status: options.status,
                order: updatedOrder,
            };
        }

        const updatedOrder = await client.order.update({
            where: { id: order.id },
            data: {
                status: OrderStatus.failed,
                streamlinedStatus: OrderStreamlinedStatus.failed,
                paymentStatus: TransactionStatus.FAILED,
                fulfilled: false,
                reason: `${this.getProviderLabel(options.provider)} payout failed for reference: ${options.reference}`,
            },
            select: sellPayoutOrderSelection,
        });

        return {
            provider: options.provider,
            reference: options.reference,
            status: options.status,
            order: updatedOrder,
        };
    }

    async executeSellPayoutSideEffects(
        transition: SellPayoutStateTransition,
    ): Promise<void> {
        if (transition.status === TransactionStatus.SUCCESS) {
            await this.handleSuccessfulSellPayout(transition.order, transition.provider);
            return;
        }

        await this.handleFailedSellPayout(
            transition.order,
            transition.provider,
            transition.reference,
        );
    }

    private async handleSuccessfulSellPayout(
        order: SellPayoutOrderRecord,
        provider: SellPayoutProvider,
    ) {
        this.emitTransactionUpdate(order.user.id, order);
        this.wsGateway.notifyWalletUpdate(order.user.id);

        const bankLabel = order.destinationBankName || "your bank";
        const accountSuffix = order.destinationBankAccountNumber
            ? ` (${order.destinationBankAccountNumber})`
            : "";

        await this.notificationDispatcher.notify({
            userId: order.user.id,
            title: "Sell order completed",
            body:
                `Your sell order of ${order.amount} ${order.currency.toUpperCase()} has been completed. ` +
                `₦${order.totalToReceiveInFiat} was sent to ${bankLabel}${accountSuffix}. ` +
                `Transaction ID: ${order.transactionId}.`,
            category: "transaction",
            currency: order.currency,
            transactionType: OrderCategory.SELL,
            enableEmail: true,
            emailPayload: {
                email: order.user.email,
                transactionType: "sell",
                transactionId: order.transactionId,
                amount: String(order.amount),
                currency: order.currency.toUpperCase(),
                status: "completed",
                date: new Date().toISOString(),
                fiatAmount: String(order.totalToReceiveInFiat || ""),
                bankName: order.destinationBankName || "",
                accountNumber: order.destinationBankAccountNumber || "",
            },
            enablePush: true,
        });

        this.logger.log(
            `SELL order ${order.id} marked done after ${this.getProviderLabel(provider)} payout success`
        );
    }

    private async handleFailedSellPayout(
        order: SellPayoutOrderRecord,
        provider: SellPayoutProvider,
        reference: string,
    ) {
        const providerLabel = this.getProviderLabel(provider);

        this.emitTransactionUpdate(order.user.id, order);
        await this.withdrawalWebhookHandler.refundSellOrderByOrderId(order.id);

        await this.notificationDispatcher.notify({
            userId: order.user.id,
            title: "Sell order failed",
            body:
                `Your sell order of ${order.amount} ${order.currency.toUpperCase()} could not be completed. ` +
                `A refund has been initiated. Transaction ID: ${order.transactionId}.`,
            category: "transaction",
            currency: order.currency,
            transactionType: OrderCategory.SELL,
            enableEmail: true,
            emailPayload: {
                email: order.user.email,
                transactionType: "sell",
                transactionId: order.transactionId,
                amount: String(order.amount),
                currency: order.currency.toUpperCase(),
                status: "failed",
                date: new Date().toISOString(),
            },
            enablePush: true,
        });

        this.logger.error(
            `SELL order ${order.id} marked failed after ${providerLabel} payout failure. Refund initiated.`
        );

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            `SELL order #${order.transactionId} payout FAILED. ` +
            `Order marked failed and refund initiated. ` +
            `User owed ₦${order.totalToReceiveInFiat}. ` +
            `Bank: ${order.destinationBankName} / ${order.destinationBankAccountNumber}.`,
            {
                orderId: order.id,
                userId: order.user.id,
                email: order.user.email,
                amount: order.totalToReceiveInFiat,
            },
        ).catch((error: Error) => {
            this.logger.error(
                `Failed to send ${providerLabel} payout failure Slack alert for order ${order.id}: ${error.message}`
            );
        });
    }

    private emitTransactionUpdate(
        userId: number,
        order: SellPayoutOrderRecord,
    ) {
        this.wsGateway.notifyTransactionUpdate(userId, {
            type: "transaction_update",
            transaction: {
                id: order.id,
                transactionId: order.transactionId,
                status: order.status,
                streamlinedStatus: order.streamlinedStatus,
                orderCategory: order.orderCategory,
                amount: order.amount,
                currency: order.currency,
                createdAt: order.createdAt,
                updatedAt: order.updatedAt,
            },
        });
    }

    private getProviderLabel(provider: SellPayoutProvider) {
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
}