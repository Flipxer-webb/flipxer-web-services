import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@/modules/core/prisma/services";
import { SlackWebhookService } from "@/modules/api/operations/services/slack-webhook.service";
import { BuyOrderService } from "./buy-order.service";
import {
    TransactionStatus,
    OrderCategory,
    OrderStatus,
} from "@prisma/client";

/**
 * Result of a single reconciliation run
 */
export interface StuckOrderReconciliationResult {
    timestamp: Date;
    stuckBuyOrders: {
        detected: number;
        autoRetried: number;
        retryFailed: number;
        skippedNoWebhook: number;
        details: Array<{
            orderId: number;
            paymentId: number;
            reference: string;
            amount: number;
            currency: string;
            action: "retried" | "retry_failed" | "skipped_no_webhook";
            error?: string;
        }>;
    };
    brokenLedgerOrders: {
        detected: number;
        alerted: boolean;
        details: Array<{
            orderId: number;
            transactionId: string;
            category: string;
            ledgerEntryId: string | null;
            ledgerStatus: string | null;
        }>;
    };
    preLedgerBackfill: {
        detected: number;
        fixed: number;
    };
    errors: string[];
}

/**
 * StuckOrderReconciliationService
 *
 * Detects and auto-fixes orders where funds were received but fulfillment failed.
 *
 * Categories handled:
 *
 * 1. **Stuck BUY orders** (payment SUCCESS/APPROVED, order still pending, not fulfilled)
 *    - Root cause: fulfillBuyOrder failed after webhook, but payment already marked SUCCESS
 *    - Fix: Reset payment to PENDING, re-call fulfillBuyOrder (idempotent via atomic claim)
 *    - Guard: Only processes orders >5 min old (avoids racing with active webhook processing)
 *
 * 2. **Broken ledger links** (order completed but ledger entry FAILED/missing)
 *    - Root cause: Ledger transaction failed but order was already updated
 *    - Fix: Slack alert for manual investigation (auto-fix too risky for money movement)
 *
 * 3. **Pre-ledger backfill** (completed BUY orders with no ledgerEntryId)
 *    - Root cause: Orders completed before ledger system was deployed
 *    - Fix: Set fulfilled=true (crypto was delivered via old Quidax transfer system)
 *
 * Runs via cron (every 10 minutes) and can also be triggered manually via admin endpoint.
 */
@Injectable()
export class StuckOrderReconciliationService {
    private readonly logger = new Logger(StuckOrderReconciliationService.name);

    /**
     * Only process orders older than this threshold to avoid racing with
     * active webhook processing or in-flight fulfillment attempts.
     */
    private readonly STUCK_AGE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

    /**
     * Maximum number of orders to auto-retry per run to avoid overwhelming
     * the system if there's a large backlog.
     */
    private readonly MAX_AUTO_RETRY_PER_RUN = 10;

    constructor(
        private readonly prisma: PrismaService,
        private readonly buyOrderService: BuyOrderService,
        private readonly slackWebhookService: SlackWebhookService,
    ) { }

    /**
     * Run full stuck-order reconciliation.
     * Safe to call multiple times — all operations are idempotent.
     */
    async reconcile(): Promise<StuckOrderReconciliationResult> {
        const result: StuckOrderReconciliationResult = {
            timestamp: new Date(),
            stuckBuyOrders: { detected: 0, autoRetried: 0, retryFailed: 0, skippedNoWebhook: 0, details: [] },
            brokenLedgerOrders: { detected: 0, alerted: false, details: [] },
            preLedgerBackfill: { detected: 0, fixed: 0 },
            errors: [],
        };

        // Run each category independently so one failure doesn't block others
        try {
            await this.detectAndRetryStuckBuyOrders(result);
        } catch (error) {
            const msg = `Stuck BUY detection failed: ${error.message}`;
            this.logger.error(msg, error.stack);
            result.errors.push(msg);
        }

        try {
            await this.detectBrokenLedgerLinks(result);
        } catch (error) {
            const msg = `Broken ledger detection failed: ${error.message}`;
            this.logger.error(msg, error.stack);
            result.errors.push(msg);
        }

        try {
            await this.backfillPreLedgerOrders(result);
        } catch (error) {
            const msg = `Pre-ledger backfill failed: ${error.message}`;
            this.logger.error(msg, error.stack);
            result.errors.push(msg);
        }

        // Send summary alert if anything was found
        if (
            result.stuckBuyOrders.detected > 0 ||
            result.brokenLedgerOrders.detected > 0 ||
            result.errors.length > 0
        ) {
            await this.sendReconciliationSummary(result);
        }

        return result;
    }

    // ─── Category 1: Stuck BUY orders ───────────────────────────────────────────

    /**
     * Detect BUY orders where payment succeeded but order was never fulfilled.
     * Auto-retries by resetting payment → PENDING and calling fulfillBuyOrder.
     */
    private async detectAndRetryStuckBuyOrders(
        result: StuckOrderReconciliationResult,
    ): Promise<void> {
        const cutoff = new Date(Date.now() - this.STUCK_AGE_THRESHOLD_MS);

        // Find payments that are SUCCESS or APPROVED but linked to unfulfilled BUY orders
        const stuckPayments = await this.prisma.payment.findMany({
            where: {
                status: {
                    in: [TransactionStatus.SUCCESS, TransactionStatus.APPROVED],
                },
                order: {
                    orderCategory: OrderCategory.BUY,
                    fulfilled: false,
                    // Order should still be in a non-terminal state
                    status: {
                        in: [
                            OrderStatus.pending,
                            OrderStatus.initiated,
                            OrderStatus.processing,
                            OrderStatus.confirmed,
                        ],
                    },
                },
                // Only process orders old enough to not be in-flight
                createdAt: { lt: cutoff },
            },
            include: {
                order: {
                    select: {
                        id: true,
                        amount: true,
                        currency: true,
                        transactionId: true,
                        userId: true,
                    },
                },
            },
            take: this.MAX_AUTO_RETRY_PER_RUN,
            orderBy: { createdAt: "asc" }, // Oldest first
        });

        result.stuckBuyOrders.detected = stuckPayments.length;

        if (stuckPayments.length === 0) {
            this.logger.debug("No stuck BUY orders detected");
            return;
        }

        this.logger.warn(
            `Detected ${stuckPayments.length} stuck BUY order(s) — attempting auto-retry`,
        );

        for (const payment of stuckPayments) {
            const detail: StuckOrderReconciliationResult["stuckBuyOrders"]["details"][number] = {
                orderId: payment.order!.id,
                paymentId: payment.id,
                reference: payment.reference,
                amount: Number(payment.order!.amount),
                currency: payment.order!.currency,
                action: "retried",
                error: undefined,
            };

            try {
                // SECURITY: Only auto-retry if a matching WebhookLog entry exists proving
                // the provider actually sent a payment_success event for this reference.
                // This prevents crediting crypto from orphaned or bogus SUCCESS statuses.


                // Search for this payment's reference within stored webhook payloads
                // WebhookLog.externalId is typically the provider reference, but we also
                // need to check if the Payment.reference or Payment.externalReference
                // appears in any logged webhook for this provider
                const webhookByRef = await this.prisma.webhookLog.findFirst({
                    where: {
                        provider: { in: ["nomba", "fincra"] },
                        eventType: { in: ["payment_success", "collection.successful"] },
                        OR: [
                            { externalId: payment.reference },
                            { externalId: payment.externalReference ?? "__none__" },
                        ],
                    },
                });

                if (!webhookByRef) {
                    detail.action = "skipped_no_webhook";
                    detail.error = "No matching WebhookLog entry found — cannot verify payment was genuine";
                    result.stuckBuyOrders.skippedNoWebhook++;

                    this.logger.warn(
                        `SKIPPED Order #${payment.order!.id} — no WebhookLog proof for reference ${payment.reference}. Alerting for manual review.`,
                    );

                    result.stuckBuyOrders.details.push(detail);
                    continue;
                }

                this.logger.log(
                    `WebhookLog verified for Order #${payment.order!.id} | webhookId: ${webhookByRef.id}`,
                );

                // Reset payment to PENDING so fulfillBuyOrder's atomic claim can succeed
                await this.prisma.payment.update({
                    where: { id: payment.id },
                    data: {
                        status: TransactionStatus.PENDING,
                        paymentStatus: TransactionStatus.PENDING,
                    },
                });

                this.logger.log(
                    `Retrying fulfillment for Order #${payment.order!.id} | payment: ${payment.reference}`,
                );

                await this.buyOrderService.fulfillBuyOrder(payment.reference);

                result.stuckBuyOrders.autoRetried++;
                this.logger.log(
                    `Successfully retried Order #${payment.order!.id}`,
                );
            } catch (error) {
                detail.action = "retry_failed";
                detail.error = error.message;
                result.stuckBuyOrders.retryFailed++;

                this.logger.error(
                    `Failed to retry Order #${payment.order!.id}: ${error.message}`,
                    error.stack,
                );
            }

            result.stuckBuyOrders.details.push(detail);
        }
    }

    // ─── Category 2: Broken ledger links ────────────────────────────────────────

    /**
     * Detect orders that are marked as done/completed but have a FAILED or missing ledger entry.
     * These require manual investigation — we only alert.
     */
    private async detectBrokenLedgerLinks(
        result: StuckOrderReconciliationResult,
    ): Promise<void> {
        // Order model has ledgerEntryId as a plain String? (no Prisma relation),
        // so we query orders first, then check ledger entries separately.
        const candidateOrders = await this.prisma.order.findMany({
            where: {
                ledgerEntryId: { not: null },
                status: {
                    in: [OrderStatus.done, OrderStatus.completed],
                },
            },
            select: {
                id: true,
                transactionId: true,
                orderCategory: true,
                ledgerEntryId: true,
            },
            take: 100,
            orderBy: { updatedAt: "desc" },
        });

        if (candidateOrders.length === 0) {
            this.logger.debug("No broken ledger links detected");
            return;
        }

        // Batch-fetch linked ledger entries to check for FAILED status
        const ledgerEntryIds = candidateOrders
            .map((o) => o.ledgerEntryId)
            .filter((id): id is string => id !== null);

        const failedEntries = await this.prisma.ledgerEntry.findMany({
            where: {
                id: { in: ledgerEntryIds },
                status: "FAILED",
            },
            select: { id: true, status: true },
        });

        const failedEntryMap = new Map<string, string>(
            failedEntries.map((e) => [e.id, e.status as string]),
        );

        // Filter to only orders whose ledger entry is FAILED
        const brokenOrders = candidateOrders.filter(
            (o) => o.ledgerEntryId && failedEntryMap.has(o.ledgerEntryId),
        );

        result.brokenLedgerOrders.detected = brokenOrders.length;

        if (brokenOrders.length === 0) {
            this.logger.debug("No broken ledger links detected");
            return;
        }

        this.logger.warn(
            `Detected ${brokenOrders.length} order(s) with broken ledger links`,
        );

        for (const order of brokenOrders) {
            result.brokenLedgerOrders.details.push({
                orderId: order.id,
                transactionId: order.transactionId,
                category: order.orderCategory,
                ledgerEntryId: order.ledgerEntryId,
                ledgerStatus: failedEntryMap.get(order.ledgerEntryId!) ?? null,
            });
        }

        result.brokenLedgerOrders.alerted = true;
    }

    // ─── Category 3: Pre-ledger backfill ────────────────────────────────────────

    /**
     * Find completed BUY orders that have no ledgerEntryId (pre-ledger era)
     * and mark them as fulfilled. These orders were completed via the old
     * direct Quidax transfer system before the double-entry ledger was deployed.
     */
    private async backfillPreLedgerOrders(
        result: StuckOrderReconciliationResult,
    ): Promise<void> {
        const preLedgerOrders = await this.prisma.order.findMany({
            where: {
                orderCategory: OrderCategory.BUY,
                fulfilled: false,
                ledgerEntryId: null,
                status: {
                    in: [OrderStatus.done, OrderStatus.completed],
                },
            },
            select: { id: true },
            take: 100,
        });

        result.preLedgerBackfill.detected = preLedgerOrders.length;

        if (preLedgerOrders.length === 0) {
            this.logger.debug("No pre-ledger orders to backfill");
            return;
        }

        this.logger.log(
            `Backfilling ${preLedgerOrders.length} pre-ledger BUY order(s) as fulfilled`,
        );

        const ids = preLedgerOrders.map((o) => o.id);

        const updated = await this.prisma.order.updateMany({
            where: { id: { in: ids } },
            data: { fulfilled: true },
        });

        result.preLedgerBackfill.fixed = updated.count;

        this.logger.log(`Backfilled ${updated.count} pre-ledger order(s)`);
    }

    // ─── Slack alerts ───────────────────────────────────────────────────────────

    /**
     * Send a summary Slack alert after reconciliation run
     */
    private async sendReconciliationSummary(
        result: StuckOrderReconciliationResult,
    ): Promise<void> {
        try {
            const sections = this.buildReconciliationSections(result);
            const text = `🔄 *Stuck Order Reconciliation Report*\n${sections.join("\n\n")}`;

            await this.slackWebhookService.sendWebhookFailureAlert(
                "nomba",
                "reconciliation",
                text,
                {
                    stuckBuyOrders: result.stuckBuyOrders.detected,
                    autoRetried: result.stuckBuyOrders.autoRetried,
                    skippedNoWebhook: result.stuckBuyOrders.skippedNoWebhook,
                    brokenLedger: result.brokenLedgerOrders.detected,
                    preLedgerBackfill: result.preLedgerBackfill.fixed,
                    errors: result.errors.length,
                },
            );
        } catch (error) {
            this.logger.error(
                `Failed to send reconciliation Slack alert: ${error.message}`,
            );
        }
    }

    private buildReconciliationSections(result: StuckOrderReconciliationResult): string[] {
        const sections: string[] = [];

        if (result.stuckBuyOrders.detected > 0) {
            sections.push(this.buildStuckBuySection(result.stuckBuyOrders));
        }

        if (result.brokenLedgerOrders.detected > 0) {
            sections.push(this.buildBrokenLedgerSection(result.brokenLedgerOrders));
        }

        if (result.preLedgerBackfill.fixed > 0) {
            sections.push(
                `*Pre-Ledger Backfill:* ${result.preLedgerBackfill.fixed} orders marked fulfilled`,
            );
        }

        if (result.errors.length > 0) {
            sections.push(
                `*Errors:*\n${result.errors.map((e) => `  ❌ ${e}`).join("\n")}`,
            );
        }

        return sections;
    }

    private buildStuckBuySection(data: StuckOrderReconciliationResult["stuckBuyOrders"]): string {
        const lines = [
            `*Stuck BUY Orders:* ${data.detected} detected`,
            `  - Auto-retried: ${data.autoRetried}`,
            `  - Retry failed: ${data.retryFailed}`,
            `  - Skipped (no webhook proof): ${data.skippedNoWebhook}`,
        ];
        for (const d of data.details) {
            const status = d.action === "retried" ? "\u2705" : d.action === "skipped_no_webhook" ? "\u26A0\uFE0F" : "\u274C";
            lines.push(
                `  ${status} Order #${d.orderId} — ${d.amount} ${d.currency} (${d.reference})${d.error ? ` — ${d.error}` : ""}`,
            );
        }
        return lines.join("\n");
    }

    private buildBrokenLedgerSection(data: StuckOrderReconciliationResult["brokenLedgerOrders"]): string {
        const lines = [
            `*Broken Ledger Links:* ${data.detected} detected (manual fix required)`,
        ];
        for (const d of data.details) {
            lines.push(
                `  ⚠️ Order #${d.orderId} (${d.category}) — ledger ${d.ledgerEntryId} status: ${d.ledgerStatus}`,
            );
        }
        return lines.join("\n");
    }
}
