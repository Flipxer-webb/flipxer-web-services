import "dotenv/config";

import { Decimal } from "@prisma/client/runtime/library";
import {
    EntryStatus,
    OrderCategory,
    OrderStatus,
    PrismaClient,
} from "@prisma/client";

interface CliOptions {
    execute: boolean;
    limit?: number;
}

function parseCliOptions(): CliOptions {
    const options: CliOptions = { execute: false };

    for (const arg of process.argv.slice(2)) {
        if (!arg.startsWith("--")) {
            continue;
        }

        const [rawKey, rawValue] = arg.slice(2).split("=");
        const key = rawKey.trim();
        const value = rawValue?.trim();

        switch (key) {
            case "execute": {
                options.execute = value ? value === "true" : true;
                break;
            }
            case "limit": {
                const parsed = Number(value);
                if (!Number.isNaN(parsed) && parsed > 0) {
                    options.limit = parsed;
                }
                break;
            }
            default:
                break;
        }
    }

    return options;
}

async function main() {
    const options = parseCliOptions();
    const prisma = new PrismaClient();

    try {
        const failedSendOrders = await prisma.order.findMany({
            where: {
                orderCategory: OrderCategory.SEND,
                status: OrderStatus.failed,
                ledgerEntryId: { not: null },
            },
            select: {
                id: true,
                userId: true,
                orderReference: true,
                transactionId: true,
                currency: true,
                amount: true,
                total: true,
                updatedAt: true,
                ledgerEntryId: true,
            },
            orderBy: {
                updatedAt: "asc",
            },
            ...(options.limit ? { take: options.limit } : {}),
        });

        const ledgerEntryIds = failedSendOrders
            .map((order) => order.ledgerEntryId)
            .filter((id): id is string => Boolean(id));

        const holdEntries = ledgerEntryIds.length
            ? await prisma.ledgerEntry.findMany({
                  where: {
                      id: { in: ledgerEntryIds },
                      status: EntryStatus.HOLD,
                  },
                  select: {
                      id: true,
                      reference: true,
                      status: true,
                      holdAmount: true,
                      balanceAfter: true,
                  },
              })
            : [];

        const holdById = new Map(holdEntries.map((entry) => [entry.id, entry]));

        const candidates = failedSendOrders
            .map((order) => ({
                ...order,
                holdEntry: order.ledgerEntryId
                    ? holdById.get(order.ledgerEntryId) ?? null
                    : null,
            }))
            .filter((order) => Boolean(order.holdEntry));

        if (candidates.length === 0) {
            console.log("No failed SEND orders with active HOLD entries found.");
            return;
        }

        console.log(
            `Found ${candidates.length} failed SEND order(s) with HOLD entries` +
                (options.execute ? " [EXECUTE]" : " [DRY-RUN]")
        );

        for (const order of candidates) {
            console.log(
                JSON.stringify({
                    orderId: order.id,
                    userId: order.userId,
                    orderReference: order.orderReference,
                    transactionId: order.transactionId,
                    currency: order.currency,
                    amount: order.amount,
                    total: order.total,
                    ledgerEntryId: order.ledgerEntryId,
                    holdReference: order.holdEntry?.reference,
                    holdAmount: order.holdEntry?.holdAmount?.toString() ?? null,
                    holdStatus: order.holdEntry?.status,
                    orderUpdatedAt: order.updatedAt,
                })
            );
        }

        if (!options.execute) {
            console.log(
                "Dry-run complete. Re-run with --execute=true to release these holds."
            );
            return;
        }

        let releasedCount = 0;
        let queueMarkedReleasedCount = 0;
        let failedCount = 0;

        for (const order of candidates) {
            const holdReference = order.holdEntry?.reference;

            if (!holdReference) {
                console.error(
                    `Skipping order ${order.id}: missing hold reference on linked ledger entry`
                );
                failedCount++;
                continue;
            }

            try {
                const releaseResult = await prisma.ledgerEntry.updateMany({
                    where: {
                        id: order.ledgerEntryId!,
                        reference: holdReference,
                        status: EntryStatus.HOLD,
                    },
                    data: {
                        holdAmount: new Decimal(0),
                        status: EntryStatus.CANCELLED,
                        description:
                            "Manual recovery: failed SEND webhook hold release",
                        updatedAt: new Date(),
                    },
                });

                if (releaseResult.count === 0) {
                    console.error(
                        `Failed to release hold for order ${order.id} (${holdReference}): hold no longer in HOLD status`
                    );
                    failedCount++;
                    continue;
                }

                releasedCount++;

                if (order.ledgerEntryId) {
                    const queueUpdate = await prisma.withdrawalQueue.updateMany({
                        where: {
                            holdEntryId: order.ledgerEntryId,
                            releasedAt: null,
                            processedAt: null,
                        },
                        data: {
                            releasedAt: new Date(),
                        },
                    });

                    queueMarkedReleasedCount += queueUpdate.count;
                }

                console.log(
                    `Released hold for order ${order.id} | user ${order.userId} | ref ${holdReference}`
                );
            } catch (error) {
                console.error(
                    `Error releasing hold for order ${order.id} (${holdReference}): ${(error as Error).message}`
                );
                failedCount++;
            }
        }

        console.log(
            JSON.stringify({
                summary: {
                    totalCandidates: candidates.length,
                    releasedCount,
                    queueMarkedReleasedCount,
                    failedCount,
                },
            })
        );
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
