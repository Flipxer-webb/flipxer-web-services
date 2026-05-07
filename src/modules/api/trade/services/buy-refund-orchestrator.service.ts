import { Injectable, Logger } from "@nestjs/common";
import { Prisma, RefundAttempt, TransactionStatus } from "@prisma/client";

import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { InboundFiatRefundService } from "@/modules/factory/bank/services/inbound-fiat-refund.service";
import {
    InboundPaymentProvider,
    getPaymentMethodForBankProvider,
} from "@/modules/factory/bank/types";
import { generateId } from "@/utils";

export const BUY_REFUND_REASON = {
    ACTIVE_WRONG_AMOUNT: "ACTIVE_WRONG_AMOUNT",
    ACCOUNT_NAME_MISMATCH: "ACCOUNT_NAME_MISMATCH",
    CLOSED_INVALID_PAYMENT: "CLOSED_INVALID_PAYMENT",
    CANCELLED_ORDER_PAYMENT: "CANCELLED_ORDER_PAYMENT",
    EXPIRED_LATE_PAYMENT: "EXPIRED_LATE_PAYMENT",
} as const;

export type BuyRefundReasonCode =
    (typeof BUY_REFUND_REASON)[keyof typeof BUY_REFUND_REASON];

type RefundPaymentContext = {
    id: number;
    orderId: number | null;
    userId: number;
    reference: string;
    senderAccountName: string | null;
    senderAccountNumber: string | null;
    senderBankName: string | null;
    senderBankCode: string | null;
    order: {
        id: number;
        userId: number;
        transactionId: string | null;
    };
};

@Injectable()
export class BuyRefundOrchestratorService {
    private readonly logger = new Logger("BuyRefundOrchestratorService");

    constructor(
        private readonly prisma: PrismaService,
        private readonly inboundFiatRefundService: InboundFiatRefundService,
        private readonly slackWebhookService: SlackWebhookService,
    ) {}

    private shouldReuseLatestRefundAttempt(
        reasonCode: BuyRefundReasonCode,
    ): boolean {
        return (
            reasonCode === BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT
            || reasonCode === BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH
        );
    }

    async ensureRefundPayoutForPayment(options: {
        paymentId: number;
        provider: InboundPaymentProvider;
        reasonCode: BuyRefundReasonCode;
        refundAmount: number;
        metadata?: Prisma.InputJsonValue;
    }): Promise<RefundAttempt | null> {
        const payment = await this.prisma.payment.findUnique({
            where: { id: options.paymentId },
            include: {
                order: {
                    select: {
                        id: true,
                        userId: true,
                        transactionId: true,
                    },
                },
                refundAttempts: {
                    where: { reasonCode: options.reasonCode },
                    orderBy: { createdAt: "desc" },
                    take: 1,
                },
            },
        });

        if (!payment?.order) {
            this.logger.warn(
                `Skipping BUY refund payout orchestration for missing payment/order ${options.paymentId}`,
            );
            return null;
        }

        const existingAttempt = this.shouldReuseLatestRefundAttempt(
            options.reasonCode,
        )
            ? payment.refundAttempts[0]
            : null;
        if (existingAttempt) {
            return this.refreshExistingRefundAttempt({
                attempt: existingAttempt,
                payment,
                provider: options.provider,
                reasonCode: options.reasonCode,
                refundAmount: options.refundAmount,
                metadata: options.metadata,
            });
        }

        const senderBankCode = await this.resolveSenderBankCode({
            payment,
            provider: options.provider,
        });

        const failureReason = this.buildDestinationFailureReason({
            accountNumber: payment.senderAccountNumber,
            bankName: payment.senderBankName,
            bankCode: senderBankCode,
        });

        const attempt = await this.prisma.refundAttempt.create({
            data: {
                orderId: payment.orderId,
                originalPaymentId: payment.id,
                provider: getPaymentMethodForBankProvider(options.provider),
                reasonCode: options.reasonCode,
                reference: generateId({ type: "reference" }),
                amount: new Prisma.Decimal(options.refundAmount),
                status: failureReason
                    ? TransactionStatus.FAILED
                    : TransactionStatus.PENDING,
                destinationBankAccountName: payment.senderAccountName || null,
                destinationBankAccountNumber: payment.senderAccountNumber || null,
                destinationBankCode: senderBankCode,
                destinationBankName: payment.senderBankName || null,
                failureReason,
                metadata: options.metadata,
                initiatedAt: failureReason ? null : new Date(),
            },
        });

        if (failureReason) {
            await this.alertManualReview(options.provider, attempt.reference, {
                orderId: payment.order.id,
                userId: payment.userId,
                paymentReference: payment.reference,
                amount: options.refundAmount,
                reasonCode: options.reasonCode,
                failureReason,
            });
            return attempt;
        }

        try {
            const execution = await this.inboundFiatRefundService.initializeRefundTransfer(
                {
                    provider: options.provider,
                    amount: options.refundAmount,
                    accountName: payment.senderAccountName,
                    accountNumber: payment.senderAccountNumber,
                    bankCode: senderBankCode,
                    bankName: payment.senderBankName,
                    userId: payment.userId,
                    orderId: payment.order.id,
                    refundAttemptId: attempt.id,
                    reference: attempt.reference,
                    senderName: "Flipxer",
                    narration: this.buildRefundNarration(
                        payment.order.transactionId || payment.reference,
                        options.reasonCode,
                    ),
                },
            );

            const initiatedAt = new Date();
            const resolvedProviderReference =
                execution.providerReference
                || (options.provider === "nomba" ? attempt.reference : null);
            const metadata = this.mergeRefundMetadata(
                attempt.metadata,
                undefined,
                {
                    providerReference: resolvedProviderReference,
                    providerLinkState: "accepted_on_init",
                    providerLinkSource: "refund_init_response",
                    providerLinkedAt: initiatedAt.toISOString(),
                    providerLinkExternalReference:
                        execution.externalReference || null,
                    providerLinkProviderReference: resolvedProviderReference,
                    providerLinkMerchantReference:
                        options.provider === "nomba" ? attempt.reference : null,
                    providerTerminalStatus: "pending",
                },
            );

            return this.prisma.refundAttempt.update({
                where: { id: attempt.id },
                data: {
                    payoutPaymentId: execution.paymentId,
                    externalReference: execution.externalReference,
                    providerReference: resolvedProviderReference,
                    initiatedAt,
                    ...(metadata ? { metadata } : {}),
                },
            });
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : "Failed to initialize refund payout";

            await this.alertManualReview(options.provider, attempt.reference, {
                orderId: payment.order.id,
                userId: payment.userId,
                paymentReference: payment.reference,
                amount: options.refundAmount,
                reasonCode: options.reasonCode,
                failureReason: message,
            });

            return this.prisma.refundAttempt.update({
                where: { id: attempt.id },
                data: {
                    status: TransactionStatus.FAILED,
                    failureReason: message,
                },
            });
        }
    }

    private async refreshExistingRefundAttempt(options: {
        attempt: RefundAttempt;
        payment: RefundPaymentContext;
        provider: InboundPaymentProvider;
        reasonCode: BuyRefundReasonCode;
        refundAmount: number;
        metadata?: Prisma.InputJsonValue;
    }): Promise<RefundAttempt> {
        const { attempt, payment, provider, reasonCode, refundAmount, metadata } =
            options;

        const currentAmount = Number(attempt.amount);
        if (attempt.status === TransactionStatus.SUCCESS) {
            if (currentAmount !== refundAmount) {
                this.logger.warn(
                    `Skipping BUY refund refresh for settled attempt ${attempt.reference}; ` +
                        `existing amount ${currentAmount}, latest wrong amount ${refundAmount}`,
                );
            }

            return attempt;
        }

        const senderBankCode = await this.resolveSenderBankCode({
            payment,
            provider,
            fallbackBankCode: attempt.destinationBankCode || null,
        });
        const destinationBankAccountName =
            payment.senderAccountName || attempt.destinationBankAccountName || null;
        const destinationBankAccountNumber =
            payment.senderAccountNumber || attempt.destinationBankAccountNumber || null;
        const destinationBankName =
            payment.senderBankName || attempt.destinationBankName || null;
        const amountChanged =
            currentAmount < refundAmount || currentAmount > refundAmount;

        if (amountChanged && this.hasProviderLinkedPayout(attempt)) {
            return this.escalateChangedInitializedPayout({
                attempt,
                payment,
                provider,
                refundAmount,
                currentAmount,
                metadata,
                latestDestinationBankAccountName: destinationBankAccountName,
                latestDestinationBankAccountNumber: destinationBankAccountNumber,
                latestDestinationBankCode: senderBankCode,
                latestDestinationBankName: destinationBankName,
            });
        }

        const mergedMetadata = this.mergeRefundMetadata(
            attempt.metadata,
            metadata,
            amountChanged
                ? {
                      previousRefundAmount: currentAmount,
                      refundAmountUpdatedAt: new Date().toISOString(),
                  }
                : undefined,
        );

        if (amountChanged) {
            this.logger.warn(
                `Refreshing BUY refund attempt ${attempt.reference} from ${currentAmount} to ${refundAmount}`,
            );
        }

        const storedProviderIdentifier =
            attempt.providerReference
            || this.getStoredProviderReference(attempt.metadata)
            || attempt.externalReference;

        if (storedProviderIdentifier && amountChanged) {
            this.logger.warn(
                `BUY refund attempt ${attempt.reference} already has provider reference ${storedProviderIdentifier}; ` +
                    `local refund amount was refreshed and should be verified during reconciliation`,
            );
        }

        if (attempt.payoutPaymentId) {
            const payoutAmount = new Prisma.Decimal(refundAmount);

            await this.prisma.payment.update({
                where: { id: attempt.payoutPaymentId },
                data: {
                    amount: payoutAmount,
                    totalAmount: payoutAmount,
                    destinationBankAccountName,
                    destinationBankAccountNumber,
                    destinationBankName,
                    narration: this.buildRefundNarration(
                        payment.order.transactionId || payment.reference,
                        reasonCode,
                    ),
                },
            });
        }

        const updateData: Prisma.RefundAttemptUpdateInput = {
            amount: new Prisma.Decimal(refundAmount),
            destinationBankAccountName,
            destinationBankAccountNumber,
            destinationBankCode: senderBankCode,
            destinationBankName,
        };

        if (mergedMetadata !== undefined) {
            updateData.metadata = mergedMetadata;
        }

        return this.prisma.refundAttempt.update({
            where: { id: attempt.id },
            data: updateData,
        });
    }

    private hasProviderLinkedPayout(attempt: RefundAttempt): boolean {
        return Boolean(
            attempt.payoutPaymentId
            || attempt.providerReference
            || attempt.externalReference
            || this.getStoredProviderReference(attempt.metadata),
        );
    }

    private async escalateChangedInitializedPayout(options: {
        attempt: RefundAttempt;
        payment: RefundPaymentContext;
        provider: InboundPaymentProvider;
        refundAmount: number;
        currentAmount: number;
        metadata?: Prisma.InputJsonValue;
        latestDestinationBankAccountName: string | null;
        latestDestinationBankAccountNumber: string | null;
        latestDestinationBankCode: string | null;
        latestDestinationBankName: string | null;
    }): Promise<RefundAttempt> {
        const {
            attempt,
            payment,
            provider,
            refundAmount,
            currentAmount,
            metadata,
            latestDestinationBankAccountName,
            latestDestinationBankAccountNumber,
            latestDestinationBankCode,
            latestDestinationBankName,
        } = options;
        const failureReason =
            `Refund amount changed from ₦${currentAmount} to ₦${refundAmount} after payout initialization. ` +
            `Automatic provider reissue is not supported; manual review required.`;

        this.logger.warn(
            `Escalating BUY refund attempt ${attempt.reference} for manual review; ` +
                `provider-linked payout already exists for ${currentAmount} and latest wrong amount is ${refundAmount}`,
        );

        if (attempt.payoutPaymentId) {
            await this.prisma.payment.update({
                where: { id: attempt.payoutPaymentId },
                data: {
                    status: TransactionStatus.FAILED,
                    paymentStatus: TransactionStatus.FAILED,
                },
            });
        }

        const mergedMetadata = this.mergeRefundMetadata(
            attempt.metadata,
            metadata,
            {
                previousRefundAmount: currentAmount,
                latestRequestedRefundAmount: refundAmount,
                providerInitializedAmount: currentAmount,
                providerPayoutEscalated: true,
                providerPayoutEscalatedAt: new Date().toISOString(),
                latestRequestedDestinationBankAccountName:
                    latestDestinationBankAccountName,
                latestRequestedDestinationBankAccountNumber:
                    latestDestinationBankAccountNumber,
                latestRequestedDestinationBankCode:
                    latestDestinationBankCode,
                latestRequestedDestinationBankName:
                    latestDestinationBankName,
            },
        );

        await this.alertManualReview(provider, attempt.reference, {
            orderId: payment.order.id,
            userId: payment.userId,
            paymentReference: payment.reference,
            amount: refundAmount,
            reasonCode: attempt.reasonCode as BuyRefundReasonCode,
            failureReason,
        });

        const updateData: Prisma.RefundAttemptUpdateInput = {
            status: TransactionStatus.FAILED,
            failureReason,
        };

        if (mergedMetadata) {
            updateData.metadata = mergedMetadata;
        }

        return this.prisma.refundAttempt.update({
            where: { id: attempt.id },
            data: updateData,
        });
    }

    private async resolveSenderBankCode(options: {
        payment: RefundPaymentContext;
        provider: InboundPaymentProvider;
        fallbackBankCode?: string | null;
    }): Promise<string | null> {
        let senderBankCode =
            options.payment.senderBankCode || options.fallbackBankCode || null;

        if (!senderBankCode) {
            senderBankCode = await this.inboundFiatRefundService.resolveBankCodeByName(
                {
                    provider: options.provider,
                    bankName: options.payment.senderBankName,
                },
            );

            if (senderBankCode) {
                await this.prisma.payment.update({
                    where: { id: options.payment.id },
                    data: { senderBankCode },
                });
            }
        }

        return senderBankCode;
    }

    private mergeRefundMetadata(
        existingMetadata: unknown,
        nextMetadata?: Prisma.InputJsonValue,
        extraMetadata?: Record<string, unknown>,
    ): Prisma.InputJsonValue | undefined {
        const merged: Record<string, unknown> = {};
        const existingMetadataObject = this.toJsonObject(existingMetadata);
        const nextMetadataObject = this.toJsonObject(nextMetadata);

        if (existingMetadataObject) {
            Object.assign(merged, existingMetadataObject);
        }

        if (nextMetadataObject) {
            Object.assign(merged, nextMetadataObject);
        }

        if (extraMetadata) {
            Object.assign(merged, extraMetadata);
        }

        return Object.keys(merged).length > 0
            ? (merged as Prisma.InputJsonObject)
            : undefined;
    }

    private getStoredProviderReference(metadata: unknown): string | null {
        const metadataObject = this.toJsonObject(metadata);
        const candidates = [
            metadataObject?.providerReference,
            metadataObject?.providerLinkProviderReference,
            metadataObject?.providerLinkMerchantReference,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === "string" && candidate.trim()) {
                return candidate;
            }
        }

        return null;
    }

    private toJsonObject(
        value: unknown,
    ): Record<string, unknown> | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }

        return { ...(value as Record<string, unknown>) };
    }

    private buildDestinationFailureReason(options: {
        accountNumber?: string | null;
        bankName?: string | null;
        bankCode?: string | null;
    }): string | null {
        if (!options.accountNumber) {
            return "Sender account number missing from provider webhook payload";
        }

        if (!options.bankCode) {
            return options.bankName
                ? `Unable to resolve bank code for sender bank ${options.bankName}`
                : "Sender bank code missing from provider webhook payload";
        }

        return null;
    }

    private buildRefundNarration(
        transactionId: string,
        reasonCode: BuyRefundReasonCode,
    ): string {
        if (reasonCode === BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT) {
            return `Incorrect fiat amount refund for buy order ${transactionId}`;
        }

        if (reasonCode === BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH) {
            return `Account-name mismatch refund for buy order ${transactionId}`;
        }

        if (reasonCode === BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT) {
            return `Closed invalid-payment refund for buy order ${transactionId}`;
        }

        if (reasonCode === BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT) {
            return `Cancelled-order payment refund for buy order ${transactionId}`;
        }

        return `Late payment refund for buy order ${transactionId}`;
    }

    private async alertManualReview(
        provider: InboundPaymentProvider,
        reference: string,
        details: {
            orderId: number;
            userId: number;
            paymentReference: string;
            amount: number;
            reasonCode: BuyRefundReasonCode;
            failureReason: string;
        },
    ) {
        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            reference,
            `BUY refund payout requires manual review: ${details.failureReason}`,
            {
                orderId: details.orderId,
                userId: details.userId,
                paymentReference: details.paymentReference,
                amount: details.amount,
                reasonCode: details.reasonCode,
            },
        ).catch(() => undefined);
    }
}