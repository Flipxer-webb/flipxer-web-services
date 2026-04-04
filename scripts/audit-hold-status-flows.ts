import "dotenv/config";

import {
    EntryStatus,
    LedgerType,
    OrderCategory,
    OrderStatus,
    PrismaClient,
} from "@prisma/client";

type HoldWithMeta = {
    id: string;
    userId: number;
    currency: string;
    type: LedgerType;
    status: EntryStatus;
    reference: string;
    holdAmount: unknown;
    createdAt: Date;
    updatedAt: Date;
};

function hoursAgo(date: Date): number {
    return (Date.now() - date.getTime()) / (1000 * 60 * 60);
}

async function main() {
    const prisma = new PrismaClient();

    try {
        const activeHolds = (await prisma.ledgerEntry.findMany({
            where: { status: EntryStatus.HOLD },
            select: {
                id: true,
                userId: true,
                currency: true,
                type: true,
                status: true,
                reference: true,
                holdAmount: true,
                createdAt: true,
                updatedAt: true,
            },
            orderBy: { createdAt: "asc" },
        })) as HoldWithMeta[];

        console.log(`Total active HOLD entries: ${activeHolds.length}`);

        const byType = new Map<string, number>();
        for (const hold of activeHolds) {
            byType.set(hold.type, (byType.get(hold.type) ?? 0) + 1);
        }
        console.log("Active HOLD by ledger type:");
        for (const [type, count] of byType.entries()) {
            console.log(`  - ${type}: ${count}`);
        }

        const sendHolds = activeHolds.filter((hold) => hold.reference.startsWith("withdrawal:"));
        const sellHolds = activeHolds.filter((hold) => hold.reference.startsWith("sell-hold:"));
        const swapSellHolds = activeHolds.filter((hold) => hold.reference.startsWith("swap-sell-hold:"));

        console.log(`\nFlow buckets -> SEND: ${sendHolds.length}, SELL: ${sellHolds.length}, SWAP_SELL: ${swapSellHolds.length}`);

        const sendRefs = sendHolds.map((hold) => hold.reference.replace(/^withdrawal:/, ""));
        const sellRefs = sellHolds.map((hold) => hold.reference.replace(/^sell-hold:/, ""));
        const swapRefs = swapSellHolds.map((hold) => hold.reference.replace(/^swap-sell-hold:/, ""));

        const [sendOrders, sellOrders, swapOrders, queueRows] = await Promise.all([
            sendRefs.length
                ? prisma.order.findMany({
                      where: {
                          orderCategory: OrderCategory.SEND,
                          orderReference: { in: sendRefs },
                      },
                      select: {
                          id: true,
                          userId: true,
                          orderReference: true,
                          status: true,
                          streamlinedStatus: true,
                          updatedAt: true,
                          ledgerEntryId: true,
                      },
                  })
                : Promise.resolve([]),
            sellRefs.length
                ? prisma.order.findMany({
                      where: {
                          orderCategory: OrderCategory.SELL,
                          orderReference: { in: sellRefs },
                      },
                      select: {
                          id: true,
                          userId: true,
                          orderReference: true,
                          status: true,
                          updatedAt: true,
                          ledgerEntryId: true,
                      },
                  })
                : Promise.resolve([]),
            swapRefs.length
                ? prisma.order.findMany({
                      where: {
                          orderCategory: OrderCategory.SWAP,
                          orderReference: { in: swapRefs },
                      },
                      select: {
                          id: true,
                          userId: true,
                          orderReference: true,
                          status: true,
                          updatedAt: true,
                      },
                  })
                : Promise.resolve([]),
            sendHolds.length
                ? prisma.withdrawalQueue.findMany({
                      where: {
                          holdEntryId: { in: sendHolds.map((h) => h.id) },
                      },
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

        const sendOrderByRef = new Map(sendOrders.map((order) => [order.orderReference ?? "", order]));
        const sellOrderByRef = new Map(sellOrders.map((order) => [order.orderReference ?? "", order]));
        const swapOrderByRef = new Map(swapOrders.map((order) => [order.orderReference ?? "", order]));
        const queueByHoldId = new Map(queueRows.map((q) => [q.holdEntryId, q]));

        const problematicSendStatuses = new Set<OrderStatus>([
            OrderStatus.failed,
            OrderStatus.cancelled,
            OrderStatus.done,
            OrderStatus.completed,
            OrderStatus.reversed,
        ]);

        const sendAnomalies: Array<Record<string, unknown>> = [];
        const sendHealthyInFlight: Array<Record<string, unknown>> = [];

        for (const hold of sendHolds) {
            const ref = hold.reference.replace(/^withdrawal:/, "");
            const order = sendOrderByRef.get(ref);
            const queue = queueByHoldId.get(hold.id);
            const ageHours = Number(hoursAgo(hold.createdAt).toFixed(2));

            if (!order) {
                sendAnomalies.push({
                    reason: "Missing SEND order for withdrawal hold reference",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    userId: hold.userId,
                    currency: hold.currency,
                    ageHours,
                });
                continue;
            }

            if (problematicSendStatuses.has(order.status)) {
                sendAnomalies.push({
                    reason: "SEND order already terminal but hold still HOLD",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    orderId: order.id,
                    orderStatus: order.status,
                    userId: hold.userId,
                    currency: hold.currency,
                    ageHours,
                });
                continue;
            }

            if (queue?.processedAt || queue?.releasedAt) {
                sendAnomalies.push({
                    reason: "Queue terminal state reached but hold still HOLD",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    orderId: order.id,
                    orderStatus: order.status,
                    queueId: queue.id,
                    processedAt: queue.processedAt,
                    releasedAt: queue.releasedAt,
                    ageHours,
                });
                continue;
            }

            if (ageHours > 72) {
                sendAnomalies.push({
                    reason: "SEND hold stale for >72h",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    orderId: order.id,
                    orderStatus: order.status,
                    queueId: queue?.id ?? null,
                    ageHours,
                });
                continue;
            }

            sendHealthyInFlight.push({
                holdId: hold.id,
                orderId: order.id,
                orderStatus: order.status,
                queueId: queue?.id ?? null,
                ageHours,
            });
        }

        const sellAnomalies: Array<Record<string, unknown>> = [];
        for (const hold of sellHolds) {
            const ref = hold.reference.replace(/^sell-hold:/, "");
            const order = sellOrderByRef.get(ref);
            const ageHours = Number(hoursAgo(hold.createdAt).toFixed(2));

            if (ageHours <= 1) {
                continue;
            }

            if (!order) {
                sellAnomalies.push({
                    reason: "SELL hold older than 1h without matching SELL order",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    userId: hold.userId,
                    currency: hold.currency,
                    ageHours,
                });
                continue;
            }

            sellAnomalies.push({
                reason: "SELL hold older than 1h",
                holdId: hold.id,
                holdReference: hold.reference,
                orderId: order.id,
                orderStatus: order.status,
                ageHours,
            });
        }

        const swapAnomalies: Array<Record<string, unknown>> = [];
        for (const hold of swapSellHolds) {
            const ref = hold.reference.replace(/^swap-sell-hold:/, "");
            const order = swapOrderByRef.get(ref);
            const ageHours = Number(hoursAgo(hold.createdAt).toFixed(2));

            if (ageHours <= 1) {
                continue;
            }

            if (!order) {
                swapAnomalies.push({
                    reason: "SWAP sell-leg hold older than 1h without SWAP order",
                    holdId: hold.id,
                    holdReference: hold.reference,
                    userId: hold.userId,
                    currency: hold.currency,
                    ageHours,
                });
                continue;
            }

            swapAnomalies.push({
                reason: "SWAP sell-leg hold older than 1h",
                holdId: hold.id,
                holdReference: hold.reference,
                orderId: order.id,
                orderStatus: order.status,
                ageHours,
            });
        }

        console.log("\n=== HOLD FLOW AUDIT SUMMARY ===");
        console.log(`SEND in-flight healthy: ${sendHealthyInFlight.length}`);
        console.log(`SEND anomalies: ${sendAnomalies.length}`);
        console.log(`SELL anomalies (>1h HOLD): ${sellAnomalies.length}`);
        console.log(`SWAP anomalies (>1h HOLD): ${swapAnomalies.length}`);

        if (sendAnomalies.length) {
            console.log("\nSEND anomalies (first 50):");
            for (const row of sendAnomalies.slice(0, 50)) {
                console.log(JSON.stringify(row));
            }
        }

        if (sellAnomalies.length) {
            console.log("\nSELL anomalies (first 50):");
            for (const row of sellAnomalies.slice(0, 50)) {
                console.log(JSON.stringify(row));
            }
        }

        if (swapAnomalies.length) {
            console.log("\nSWAP anomalies (first 50):");
            for (const row of swapAnomalies.slice(0, 50)) {
                console.log(JSON.stringify(row));
            }
        }
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
