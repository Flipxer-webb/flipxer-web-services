import { Injectable, Logger } from "@nestjs/common";
import {
    OrderCategory,
    PaymentMethod,
    Prisma,
    TransactionStatus,
} from "@prisma/client";

import { NotificationDispatcher } from "@/modules/api/notification/services/notification-dispatcher.service";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { PrismaService } from "@/modules/core/prisma/services";
import { InboundFiatRefundService } from "@/modules/factory/bank/services/inbound-fiat-refund.service";
import {
    InboundPaymentProvider,
    getBankProviderForPaymentMethod,
} from "@/modules/factory/bank/types";

import { WsGateway } from "../gateway/v1";
import {
    BUY_REFUND_REASON,
} from "./buy-refund-orchestrator.service";

type PrismaClientLike = Prisma.TransactionClient | PrismaService;

const refundAttemptSelection = {
    id: true,
    reasonCode: true,
    reference: true,
    externalReference: true,
    providerReference: true,
    metadata: true,
    status: true,
    amount: true,
    destinationBankAccountNumber: true,
    destinationBankName: true,
    destinationBankAccountName: true,
    failureReason: true,
    payoutPaymentId: true,
    provider: true,
    initiatedAt: true,
    verifiedAt: true,
    createdAt: true,
    updatedAt: true,
    settledAt: true,
    order: {
        select: {
            id: true,
            userId: true,
            orderCategory: true,
            status: true,
            streamlinedStatus: true,
            paymentStatus: true,
            transactionId: true,
            amount: true,
            currency: true,
            createdAt: true,
            updatedAt: true,
            user: { select: { id: true, email: true } },
        },
    },
} satisfies Prisma.RefundAttemptSelect;

type RefundAttemptRecord = Prisma.RefundAttemptGetPayload<{
    select: typeof refundAttemptSelection;
}>;

type RefundTerminalStatus = "SUCCESS" | "FAILED";

export type RefundAttemptTransition = {
    provider: InboundPaymentProvider;
    status: RefundTerminalStatus;
    attempt: RefundAttemptRecord;
};

@Injectable()
export class BuyRefundReconciliationService {
    private readonly logger = new Logger("BuyRefundReconciliationService");
    private readonly VERIFY_AGE_MS = 5 * 60 * 1000;
    private readonly MAX_VERIFY_PER_RUN = 20;
    private readonly NOMBA_LOOKUP_NOT_FOUND_GRACE_MS = 60 * 60 * 1000;
    private readonly NOMBA_PROVIDER_REFERENCE_BACKFILL_BATCH = 100;

    constructor(
        private readonly prisma: PrismaService,
        private readonly inboundFiatRefundService: InboundFiatRefundService,
        private readonly notificationDispatcher: NotificationDispatcher,
        private readonly wsGateway: WsGateway,
        private readonly slackWebhookService: SlackWebhookService,
    ) {}

    async reconcileRefundPayout(options: {
        provider: InboundPaymentProvider;
        reference: string;
        status: RefundTerminalStatus;
        externalReference?: string | null;
        providerReference?: string | null;
        failureReason?: string | null;
    }): Promise<boolean> {
        const transition = await this.prisma.$transaction(async (tx) => {
            return this.reconcileRefundPayoutState(tx, options);
        });

        if (!transition) {
            return false;
        }

        await this.executeRefundSideEffects(transition);
        return true;
    }

    async reconcileRefundPayoutState(
        client: PrismaClientLike,
        options: {
            provider: InboundPaymentProvider;
            reference: string;
            status: RefundTerminalStatus;
            externalReference?: string | null;
            providerReference?: string | null;
            failureReason?: string | null;
        },
    ): Promise<RefundAttemptTransition | null> {
        const attempt = await client.refundAttempt.findUnique({
            where: { reference: options.reference },
            select: refundAttemptSelection,
        });

        if (!attempt || attempt.status === TransactionStatus.SUCCESS) {
            return null;
        }

        if (attempt.payoutPaymentId) {
            await client.payment.update({
                where: { id: attempt.payoutPaymentId },
                data: {
                    status: options.status,
                    paymentStatus: options.status,
                    ...(options.externalReference
                        ? { externalReference: options.externalReference }
                        : {}),
                    ...(options.providerReference
                        ? {
                              providerAccountReference:
                                  options.providerReference,
                          }
                        : {}),
                },
            });
        }

        const resolvedProviderReference =
            options.providerReference
            || attempt.providerReference
            || this.getStoredProviderReference(attempt.metadata);

        const updatedAttempt = await client.refundAttempt.update({
            where: { id: attempt.id },
            data: {
                status: options.status,
                externalReference:
                    options.externalReference ?? attempt.externalReference,
                providerReference: resolvedProviderReference,
                verifiedAt: new Date(),
                settledAt:
                    options.status === TransactionStatus.SUCCESS
                        ? new Date()
                        : null,
                failureReason:
                    options.status === TransactionStatus.FAILED
                        ? options.failureReason ||
                          attempt.failureReason ||
                          `${this.getProviderLabel(options.provider)} refund payout failed`
                        : null,
            },
            select: refundAttemptSelection,
        });

        return {
            provider: options.provider,
            status: options.status,
            attempt: updatedAttempt,
        };
    }

    async executeRefundSideEffects(
        transition: RefundAttemptTransition,
    ): Promise<void> {
        const { attempt, provider, status } = transition;
        const shouldNotifyUser =
            attempt.reasonCode !== BUY_REFUND_REASON.CANCELLED_ORDER_PAYMENT;

        this.wsGateway.notifyTransactionUpdate(attempt.order.user.id, {
            type: "transaction_update",
            transaction: {
                id: attempt.order.id,
                transactionId: attempt.order.transactionId,
                status: attempt.order.status,
                streamlinedStatus:
                    status === TransactionStatus.SUCCESS
                        ? "refunded"
                        : attempt.order.streamlinedStatus,
                orderCategory: attempt.order.orderCategory,
                amount: attempt.order.amount,
                currency: attempt.order.currency,
                createdAt: attempt.order.createdAt,
                updatedAt: new Date(),
            },
        });

        if (status === TransactionStatus.SUCCESS) {
            if (!shouldNotifyUser) {
                return;
            }

            const successMessage = this.getSuccessMessage(attempt);

            await this.notificationDispatcher.notify({
                userId: attempt.order.user.id,
                title: this.getSuccessTitle(attempt.reasonCode),
                body: successMessage,
                category: "transaction",
                currency: attempt.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: attempt.order.user.email,
                    transactionType: "buy",
                    transactionId: attempt.order.transactionId,
                    amount: String(attempt.order.amount),
                    currency: attempt.order.currency?.toUpperCase() || "",
                    status: "refunded",
                    date: new Date().toISOString(),
                    notice: successMessage,
                },
                enablePush: true,
            });
            return;
        }

        if (shouldNotifyUser) {
            await this.notificationDispatcher.notify({
                userId: attempt.order.user.id,
                title: "Refund requires review",
                body:
                    `We could not complete the automatic refund for buy order ${attempt.order.transactionId} yet. ` +
                    `Our team has been alerted and will review it manually.`,
                category: "transaction",
                currency: attempt.order.currency,
                transactionType: OrderCategory.BUY,
                enableEmail: true,
                emailPayload: {
                    email: attempt.order.user.email,
                    transactionType: "buy",
                    transactionId: attempt.order.transactionId,
                    amount: String(attempt.order.amount),
                    currency: attempt.order.currency?.toUpperCase() || "",
                    status: "processing",
                    date: new Date().toISOString(),
                    notice:
                        `Automatic refund processing failed for ${attempt.order.transactionId}. Manual review has been triggered.`,
                },
                enablePush: true,
            });
        }

        await this.slackWebhookService.sendWebhookFailureAlert(
            provider,
            attempt.reference,
            `BUY refund payout failed after initiation. Manual review required.`,
            {
                orderId: attempt.order.id,
                userId: attempt.order.user.id,
                amount: Number(attempt.amount),
                destinationBankName: attempt.destinationBankName,
                destinationBankAccountNumber:
                    attempt.destinationBankAccountNumber,
                reasonCode: attempt.reasonCode,
                failureReason: attempt.failureReason,
            },
        ).catch(() => undefined);
    }

    async verifyPendingRefundAttempts(): Promise<{
        checked: number;
        succeeded: number;
        failed: number;
    }> {
        const backfilledAttempts =
            await this.backfillLegacyNombaProviderReferences();

        if (backfilledAttempts > 0) {
            this.logger.log(
                `Backfilled merchant references for ${backfilledAttempts} legacy Nomba refund attempts before verification`,
            );
        }

        const cutoff = new Date(Date.now() - this.VERIFY_AGE_MS);
        const attempts = await this.prisma.refundAttempt.findMany({
            where: {
                status: TransactionStatus.PENDING,
                initiatedAt: { not: null },
                OR: [{ verifiedAt: null }, { verifiedAt: { lt: cutoff } }],
            },
            orderBy: { createdAt: "asc" },
            take: this.MAX_VERIFY_PER_RUN,
        });

        let succeeded = 0;
        let failed = 0;

        for (const attempt of attempts) {
            const outcome = await this.verifyPendingRefundAttempt(attempt);

            if (outcome === "success") {
                succeeded++;
            } else if (outcome === "failed") {
                failed++;
            }
        }

        return {
            checked: attempts.length,
            succeeded,
            failed,
        };
    }

    private async verifyPendingRefundAttempt(attempt: {
        id: number;
        provider: PaymentMethod;
        reference: string;
        externalReference: string | null;
        providerReference: string | null;
        metadata: Prisma.JsonValue | null;
        payoutPaymentId: number | null;
        initiatedAt: Date | null;
        createdAt: Date;
    }): Promise<"success" | "failed" | "pending" | "skipped"> {
        const provider = getBankProviderForPaymentMethod(attempt.provider);
        if (!provider) {
            return "skipped";
        }

        const resolvedProviderReference =
            attempt.providerReference
            || this.getStoredProviderReference(attempt.metadata)
            || this.resolveLegacyNombaProviderReference(attempt);

        try {
            const result = await this.inboundFiatRefundService.verifyRefundTransfer(
                {
                    provider,
                    reference: attempt.reference,
                    externalReference: attempt.externalReference,
                    providerReference: resolvedProviderReference,
                },
            );

            const identifiers = this.extractProviderIdentifiers(
                provider,
                result.data,
            );
            const resolvedIdentifiersProviderReference =
                identifiers.providerReference
                || resolvedProviderReference;

            if (result.status === "pending") {
                await this.prisma.refundAttempt.update({
                    where: { id: attempt.id },
                    data: {
                        verifiedAt: new Date(),
                        ...(identifiers.externalReference
                            ? {
                                  externalReference:
                                      identifiers.externalReference,
                              }
                            : {}),
                                                ...(resolvedIdentifiersProviderReference
                            ? {
                                  providerReference:
                                                                            resolvedIdentifiersProviderReference,
                              }
                            : {}),
                    },
                });
                return "pending";
            }

            const reconciled = await this.reconcileRefundPayout({
                provider,
                reference: attempt.reference,
                status:
                    result.status === "success"
                        ? TransactionStatus.SUCCESS
                        : TransactionStatus.FAILED,
                externalReference: identifiers.externalReference,
                providerReference: resolvedIdentifiersProviderReference,
                failureReason:
                    result.status === "failed"
                        ? "Provider refund verification returned failed"
                        : null,
            });

            if (!reconciled) {
                return "skipped";
            }

            return result.status === "success" ? "success" : "failed";
        } catch (error) {
            const handledOutcome = await this.handlePendingRefundVerificationError(
                attempt,
                provider,
                resolvedProviderReference,
                error,
            );

            if (handledOutcome) {
                return handledOutcome;
            }

            this.logger.error(
                `BUY refund verification failed for ${attempt.reference}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return "skipped";
        }
    }

    private getSuccessTitle(reasonCode: string) {
        return reasonCode === BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT
            || reasonCode === BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH
            || reasonCode === BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT
            ? "Invalid payment refunded"
            : "Late payment refunded";
    }

    private getSuccessMessage(attempt: RefundAttemptRecord) {
        if (attempt.reasonCode === BUY_REFUND_REASON.CLOSED_INVALID_PAYMENT) {
            return (
                `We have refunded ₦${attempt.amount} for buy order ${attempt.order.transactionId}. ` +
                `The order remains closed because it had already been closed after repeated invalid payments.`
            );
        }

        if (
            attempt.reasonCode === BUY_REFUND_REASON.ACTIVE_WRONG_AMOUNT
            || attempt.reasonCode === BUY_REFUND_REASON.ACCOUNT_NAME_MISMATCH
        ) {
            return (
                `We have refunded ₦${attempt.amount} for buy order ${attempt.order.transactionId}. ` +
                `Your order remains open, so you can still resend the exact amount from a bank account that matches your registered name before the payment window expires.`
            );
        }

        return (
            `We have refunded ₦${attempt.amount} for buy order ${attempt.order.transactionId}. ` +
            `The order remains closed because the payment arrived after expiry.`
        );
    }

    private getProviderLabel(provider: InboundPaymentProvider) {
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }

    private extractProviderIdentifiers(
        provider: InboundPaymentProvider,
        data: any,
    ): { externalReference: string | null; providerReference: string | null } {
        if (provider === "nomba") {
            let providerReference: string | null = null;

            if (typeof data?.reference === "string") {
                providerReference = data.reference;
            } else if (typeof data?.merchantTxRef === "string") {
                providerReference = data.merchantTxRef;
            } else if (typeof data?.meta?.merchantTxRef === "string") {
                providerReference = data.meta.merchantTxRef;
            }

            return {
                externalReference:
                    typeof data?.id === "string" ? data.id : null,
                providerReference,
            };
        }

        let externalReference: string | null = null;
        if (typeof data?.reference === "string") {
            externalReference = data.reference;
        } else if (typeof data?.id === "string") {
            externalReference = data.id;
        }

        return {
            externalReference,
            providerReference: null,
        };
    }

    private async backfillLegacyNombaProviderReferences(): Promise<number> {
        const attempts = await this.prisma.refundAttempt.findMany({
            where: {
                provider: PaymentMethod.NOMBA,
                providerReference: null,
                reference: { not: "" },
                OR: [
                    { externalReference: { not: null } },
                    { payoutPaymentId: { not: null } },
                ],
            },
            select: {
                id: true,
                reference: true,
                externalReference: true,
                providerReference: true,
                metadata: true,
                payoutPaymentId: true,
                initiatedAt: true,
                createdAt: true,
            },
            orderBy: { id: "asc" },
            take: this.NOMBA_PROVIDER_REFERENCE_BACKFILL_BATCH,
        });

        let backfilled = 0;

        for (const attempt of attempts) {
            const providerReference =
                this.resolveLegacyNombaProviderReference(attempt);

            if (!providerReference) {
                continue;
            }

            const metadata = this.mergeMetadata(attempt.metadata, {
                providerReference,
                providerLinkState:
                    this.getStoredMetadataString(
                        attempt.metadata,
                        "providerLinkState",
                    ) || "accepted_on_init",
                providerLinkSource:
                    this.getStoredMetadataString(
                        attempt.metadata,
                        "providerLinkSource",
                    ) || "legacy_reference_backfill",
                providerLinkedAt:
                    this.getStoredMetadataString(
                        attempt.metadata,
                        "providerLinkedAt",
                    )
                    || attempt.initiatedAt?.toISOString()
                    || attempt.createdAt.toISOString(),
                providerLinkExternalReference: attempt.externalReference,
                providerLinkProviderReference: providerReference,
                providerLinkMerchantReference: attempt.reference,
                providerTerminalStatus: "pending",
                providerReferenceBackfilledAt: new Date().toISOString(),
                providerReferenceBackfillSource: "refund_attempt_reference",
            });

            await this.prisma.refundAttempt.update({
                where: { id: attempt.id },
                data: {
                    providerReference,
                    ...(metadata ? { metadata } : {}),
                },
            });

            if (attempt.payoutPaymentId) {
                await this.prisma.payment.update({
                    where: { id: attempt.payoutPaymentId },
                    data: {
                        providerAccountReference: providerReference,
                        ...(attempt.externalReference
                            ? {
                                  externalReference:
                                      attempt.externalReference,
                              }
                            : {}),
                    },
                });
            }

            backfilled++;
        }

        return backfilled;
    }

    private resolveLegacyNombaProviderReference(attempt: {
        reference: string;
        externalReference: string | null;
        providerReference?: string | null;
        payoutPaymentId?: number | null;
        metadata?: Prisma.JsonValue | null;
    }): string | null {
        if (attempt.providerReference?.trim()) {
            return attempt.providerReference;
        }

        const storedProviderReference = this.getStoredProviderReference(
            attempt.metadata ?? null,
        );
        if (storedProviderReference) {
            return storedProviderReference;
        }

        return attempt.reference?.trim()
            && (
                attempt.externalReference
                || attempt.payoutPaymentId
                || this.getStoredMetadataString(
                    attempt.metadata ?? null,
                    "providerLinkState",
                )
            )
            ? attempt.reference
            : null;
    }

    private hasNombaProviderLinkState(
        attempt: {
            externalReference: string | null;
            payoutPaymentId: number | null;
            metadata: Prisma.JsonValue | null;
        },
        providerReference: string | null,
    ): boolean {
        return Boolean(
            attempt.externalReference
            || providerReference
            || attempt.payoutPaymentId
            || this.getStoredMetadataString(
                attempt.metadata,
                "providerLinkState",
            ),
        );
    }

    private isProviderLookupNotFound(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error);
        return /\b404\b|not found/i.test(message);
    }

    private async handlePendingRefundVerificationError(
        attempt: {
            id: number;
            reference: string;
            externalReference: string | null;
            providerReference: string | null;
            metadata: Prisma.JsonValue | null;
            payoutPaymentId: number | null;
            initiatedAt: Date | null;
            createdAt: Date;
        },
        provider: InboundPaymentProvider,
        providerReference: string | null,
        error: unknown,
    ): Promise<"pending" | null> {
        if (
            provider !== "nomba"
            || !this.isProviderLookupNotFound(error)
            || !this.hasNombaProviderLinkState(attempt, providerReference)
        ) {
            return null;
        }

        await this.recordNombaLookupNotFound(attempt, {
            providerReference,
            error,
        });

        return "pending";
    }

    private async recordNombaLookupNotFound(
        attempt: {
            id: number;
            reference: string;
            externalReference: string | null;
            providerReference: string | null;
            metadata: Prisma.JsonValue | null;
            payoutPaymentId: number | null;
            initiatedAt: Date | null;
            createdAt: Date;
        },
        options: {
            providerReference: string | null;
            error: unknown;
        },
    ): Promise<void> {
        const now = new Date();
        const initiatedAt = attempt.initiatedAt || attempt.createdAt;
        const ageMs = Math.max(0, now.getTime() - initiatedAt.getTime());
        const withinGraceWindow = ageMs <= this.NOMBA_LOOKUP_NOT_FOUND_GRACE_MS;
        const existingDiagnostics = this.toJsonObject(
            this.toJsonObject(attempt.metadata)?.nombaLookupDiagnostics,
        );
        const previousCount =
            typeof existingDiagnostics?.notFoundCount === "number"
                ? existingDiagnostics.notFoundCount
                : 0;
        const firstNotFoundAt =
            typeof existingDiagnostics?.firstNotFoundAt === "string"
                ? existingDiagnostics.firstNotFoundAt
                : now.toISOString();
        const message =
            options.error instanceof Error
                ? options.error.message
                : String(options.error);
        const providerReference =
            options.providerReference
            || attempt.providerReference
            || this.resolveLegacyNombaProviderReference(attempt);
        const metadata = this.mergeMetadata(attempt.metadata, {
            providerReference,
            providerLinkState:
                this.getStoredMetadataString(
                    attempt.metadata,
                    "providerLinkState",
                ) || "accepted_on_init",
            providerLinkSource:
                this.getStoredMetadataString(
                    attempt.metadata,
                    "providerLinkSource",
                ) || "reconciliation_lookup_not_found",
            providerLinkedAt:
                this.getStoredMetadataString(
                    attempt.metadata,
                    "providerLinkedAt",
                ) || initiatedAt.toISOString(),
            providerLinkExternalReference: attempt.externalReference,
            providerLinkProviderReference: providerReference,
            providerLinkMerchantReference: attempt.reference,
            providerTerminalStatus: "pending",
            nombaLookupDiagnostics: {
                firstNotFoundAt,
                lastNotFoundAt: now.toISOString(),
                notFoundCount: previousCount + 1,
                visibilityState: withinGraceWindow
                    ? "eventual_consistency_window"
                    : "persistent_not_found",
                withinGraceWindow,
                initiatedAt: initiatedAt.toISOString(),
                lookupAgeMs: ageMs,
                lastError: message,
                lastAttemptedCandidates: this.buildNombaLookupCandidates({
                    externalReference: attempt.externalReference,
                    providerReference,
                    merchantReference: attempt.reference,
                }),
                nextRetryNotBefore: new Date(
                    now.getTime() + this.VERIFY_AGE_MS,
                ).toISOString(),
            },
        });

        await this.prisma.refundAttempt.update({
            where: { id: attempt.id },
            data: {
                verifiedAt: now,
                ...(providerReference ? { providerReference } : {}),
                ...(metadata ? { metadata } : {}),
            },
        });

        if (attempt.payoutPaymentId && providerReference) {
            await this.prisma.payment.update({
                where: { id: attempt.payoutPaymentId },
                data: {
                    providerAccountReference: providerReference,
                    ...(attempt.externalReference
                        ? { externalReference: attempt.externalReference }
                        : {}),
                },
            });
        }

        const logMessage =
            `Nomba refund lookup returned 404 for ${attempt.reference}; ` +
            `ageMs=${ageMs}; count=${previousCount + 1}; ` +
            `externalReference=${attempt.externalReference || "n/a"}; ` +
            `providerReference=${providerReference || "n/a"}`;

        if (withinGraceWindow) {
            this.logger.warn(logMessage);
            return;
        }

        this.logger.error(logMessage);
    }

    private buildNombaLookupCandidates(options: {
        externalReference: string | null;
        providerReference: string | null;
        merchantReference: string;
    }): string[] {
        const candidates: string[] = [];

        if (options.externalReference?.trim()) {
            candidates.push(`transfer-id:${options.externalReference}`);
        }

        if (options.providerReference?.trim()) {
            candidates.push(`merchant-ref:${options.providerReference}`);
        }

        if (
            options.merchantReference.trim()
            && options.providerReference?.trim() !== options.merchantReference.trim()
        ) {
            candidates.push(`merchant-ref:${options.merchantReference}`);
        }

        return candidates;
    }

    private mergeMetadata(
        existingMetadata: Prisma.JsonValue | null,
        extraMetadata?: Record<string, unknown>,
    ): Prisma.InputJsonValue | undefined {
        const merged: Record<string, unknown> = {};
        const existingMetadataObject = this.toJsonObject(existingMetadata);

        if (existingMetadataObject) {
            Object.assign(merged, existingMetadataObject);
        }

        if (extraMetadata) {
            Object.assign(merged, extraMetadata);
        }

        return Object.keys(merged).length > 0
            ? (merged as Prisma.InputJsonObject)
            : undefined;
    }

    private getStoredProviderReference(metadata: Prisma.JsonValue | null) {
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

    private getStoredMetadataString(
        metadata: Prisma.JsonValue | null,
        key: string,
    ): string | null {
        const value = this.toJsonObject(metadata)?.[key];
        return typeof value === "string" && value.trim() ? value : null;
    }

    private toJsonObject(
        value: unknown,
    ): Record<string, unknown> | null {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return null;
        }

        return { ...(value as Record<string, unknown>) };
    }
}