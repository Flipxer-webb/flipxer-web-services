import "dotenv/config";

import { EntryStatus, OrderCategory, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function inferRefundState(status: EntryStatus, holdAmount: string | null): string {
    if (status === EntryStatus.CANCELLED && holdAmount === "0") {
        return "REFUNDED";
    }

    if (status === EntryStatus.HOLD) {
        return "NOT_REFUNDED (still held)";
    }

    if (status === EntryStatus.SETTLED) {
        return "NOT_REFUNDED (settled debit)";
    }

    if (status === EntryStatus.FAILED) {
        return "UNCLEAR (FAILED entry status)";
    }

    return "UNKNOWN";
}

async function main() {
    try {
        const orders = await prisma.order.findMany({
            where: {
                userId: 7,
                orderCategory: OrderCategory.SEND,
                currency: "USDC",
            },
            select: {
                id: true,
                transactionId: true,
                orderReference: true,
                status: true,
                streamlinedStatus: true,
                reason: true,
                narration: true,
                transaction_note: true,
                recipient: true,
                destinationTag: true,
                amount: true,
                fee: true,
                total: true,
                providerOrderId: true,
                ledgerEntryId: true,
                createdAt: true,
                updatedAt: true,
            },
            orderBy: { createdAt: "asc" },
        });

        if (!orders.length) {
            console.log("No USDC SEND orders found for user 7.");
            return;
        }

        const ledgerIds = orders
            .map((order) => order.ledgerEntryId)
            .filter((id): id is string => Boolean(id));

        const [ledgerEntries, queueRows] = await Promise.all([
            ledgerIds.length
                ? prisma.ledgerEntry.findMany({
                      where: { id: { in: ledgerIds } },
                      select: {
                          id: true,
                          status: true,
                          holdAmount: true,
                          reference: true,
                          description: true,
                          createdAt: true,
                          updatedAt: true,
                          metadata: true,
                      },
                  })
                : Promise.resolve([]),
            ledgerIds.length
                ? prisma.withdrawalQueue.findMany({
                      where: { holdEntryId: { in: ledgerIds } },
                      select: {
                          id: true,
                          holdEntryId: true,
                          queuedAt: true,
                          processedAt: true,
                          releasedAt: true,
                          position: true,
                      },
                  })
                : Promise.resolve([]),
        ]);

        const ledgerById = new Map(ledgerEntries.map((entry) => [entry.id, entry]));
        const queueByHoldId = new Map(queueRows.map((queue) => [queue.holdEntryId, queue]));

        const rows = orders.map((order) => {
            const ledger = order.ledgerEntryId ? ledgerById.get(order.ledgerEntryId) : null;
            const queue = order.ledgerEntryId ? queueByHoldId.get(order.ledgerEntryId) : null;
            const holdAmount = ledger?.holdAmount?.toString() ?? null;

            return {
                orderId: order.id,
                orderReference: order.orderReference,
                transactionId: order.transactionId,
                status: order.status,
                streamlinedStatus: order.streamlinedStatus,
                reason: order.reason,
                amount: order.amount,
                fee: order.fee,
                total: order.total,
                recipient: order.recipient,
                destinationTag: order.destinationTag,
                providerOrderId: order.providerOrderId,
                orderCreatedAt: order.createdAt,
                orderUpdatedAt: order.updatedAt,
                ledgerEntryId: order.ledgerEntryId,
                holdReference: ledger?.reference ?? null,
                holdStatus: ledger?.status ?? null,
                holdAmount,
                holdCreatedAt: ledger?.createdAt ?? null,
                holdUpdatedAt: ledger?.updatedAt ?? null,
                refundState: ledger
                    ? inferRefundState(ledger.status, holdAmount)
                    : "NO_LEDGER_LINK",
                queueId: queue?.id ?? null,
                queuePosition: queue?.position ?? null,
                queueQueuedAt: queue?.queuedAt ?? null,
                queueProcessedAt: queue?.processedAt ?? null,
                queueReleasedAt: queue?.releasedAt ?? null,
            };
        });

        const summary = {
            totalUsdcSendOrders: rows.length,
            statusBreakdown: rows.reduce<Record<string, number>>((acc, row) => {
                acc[row.status] = (acc[row.status] ?? 0) + 1;
                return acc;
            }, {}),
            refundBreakdown: rows.reduce<Record<string, number>>((acc, row) => {
                acc[row.refundState] = (acc[row.refundState] ?? 0) + 1;
                return acc;
            }, {}),
        };

        console.log(JSON.stringify({ summary, rows }, null, 2));
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
