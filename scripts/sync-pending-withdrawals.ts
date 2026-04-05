/**
 * Script to sync pending withdrawal transactions from Quidax
 * 
 * Usage:
 *   npx ts-node scripts/sync-pending-withdrawals.ts
 */

import 'dotenv/config';
import { PrismaClient, OrderCategory, OrderStatus, OrderStreamlinedStatus } from '@prisma/client';
import axios from 'axios';

const QUIDAX_BASE_URL = 'https://www.quidax.com/api/v1';

async function getWithdrawerByReference(userId: string, reference: string, secretKey: string) {
    const response = await axios.get(
        `${QUIDAX_BASE_URL}/users/${userId}/withdraws/reference/${reference}`,
        {
            headers: {
                Authorization: `Bearer ${secretKey}`,
            },
        }
    );
    return response.data;
}

function getStreamlinedStatus(status: OrderStatus): OrderStreamlinedStatus {
    const map: Record<string, OrderStreamlinedStatus> = {
        pending: OrderStreamlinedStatus.pending,
        processing: OrderStreamlinedStatus.pending,
        submitted: OrderStreamlinedStatus.pending,
        initiated: OrderStreamlinedStatus.pending,
        confirmed: OrderStreamlinedStatus.pending,
        filled: OrderStreamlinedStatus.completed,
        completed: OrderStreamlinedStatus.completed,
        done: OrderStreamlinedStatus.completed,
        accepted: OrderStreamlinedStatus.completed,
        failed: OrderStreamlinedStatus.failed,
        rejected: OrderStreamlinedStatus.failed,
        cancelled: OrderStreamlinedStatus.cancelled,
        reversed: OrderStreamlinedStatus.failed,
        on_hold: OrderStreamlinedStatus.pending,
        partial: OrderStreamlinedStatus.pending,
    };
    return map[status] || OrderStreamlinedStatus.pending;
}

async function syncPendingWithdrawals() {
    console.log("Starting pending withdrawals sync...\n");

    if (!process.env.DATABASE_URL) {
        console.error('❌ ERROR: DATABASE_URL environment variable is not set');
        process.exit(1);
    }

    if (!process.env.QUIDAX_API_SECRET) {
        console.error('❌ ERROR: QUIDAX_API_SECRET environment variable is not set');
        process.exit(1);
    }

    const prisma = new PrismaClient();
    const secretKey = process.env.QUIDAX_API_SECRET;

    try {
        // Find all pending/processing withdrawal transactions
        const pendingTransactions = await prisma.order.findMany({
            where: {
                orderCategory: { in: [OrderCategory.SEND, OrderCategory.SELL] },
                status: OrderStatus.processing,
            },
            include: {
                user: { select: { id: true, email: true, cryptoSubAccountId: true } },
            },
            orderBy: { createdAt: "desc" },
        });

        console.log(`Found ${pendingTransactions.length} pending withdrawal transactions\n`);

        for (const tx of pendingTransactions) {
            console.log(`Processing transaction ID: ${tx.id}, Reference: ${tx.orderReference}`);
            console.log(`  User: ${tx.user.email}`);
            console.log(`  Amount: ${tx.amount} ${tx.currency}`);
            console.log(`  Recipient: ${tx.recipient}`);
            console.log(`  Created: ${tx.createdAt}`);

            if (!tx.user.cryptoSubAccountId) {
                console.log("  ❌ User has no cryptoSubAccountId, skipping\n");
                continue;
            }

            try {
                // Get the withdrawal status from Quidax
                const response = await getWithdrawerByReference(
                    tx.user.cryptoSubAccountId,
                    tx.orderReference,
                    secretKey
                );

                const quidaxStatus = response.data?.status?.toLowerCase();
                console.log(`  Quidax status: ${quidaxStatus}`);

                if (quidaxStatus === "done") {
                    // Update to done
                    await prisma.order.update({
                        where: { id: tx.id },
                        data: {
                            status: OrderStatus.done,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.done),
                        },
                    });
                    console.log("  ✅ Updated to DONE\n");
                } else if (quidaxStatus === "rejected" || quidaxStatus === "failed") {
                    // Update to failed
                    await prisma.order.update({
                        where: { id: tx.id },
                        data: {
                            status: OrderStatus.failed,
                            streamlinedStatus: getStreamlinedStatus(OrderStatus.failed),
                        },
                    });
                    console.log("  ❌ Updated to FAILED\n");
                } else {
                    console.log(`  ⏳ Still ${quidaxStatus}, no update needed\n`);
                }
            } catch (error: any) {
                console.log(`  ❌ Error checking Quidax: ${error.response?.data?.message || error.message}\n`);
            }
        }

        console.log("✅ Sync completed!");
    } catch (error) {
        console.error("Error during sync:", error);
    } finally {
        await prisma.$disconnect();
    }
}

syncPendingWithdrawals();
