import { PrismaClient, LedgerType, EntryStatus, SweepStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const prisma = new PrismaClient();
const PLATFORM_USER_ID = 0;

async function main() {
    console.log("Starting backfill of platform ledger entries...");

    let cursor: string | undefined = undefined;
    const batchSize = 100;
    let processed = 0;
    let updated = 0;

    while (true) {
        const entries = await prisma.ledgerEntry.findMany({
            take: batchSize,
            skip: cursor ? 1 : 0,
            cursor: cursor ? { id: cursor } : undefined,
            where: {
                userId: { not: PLATFORM_USER_ID }, // Only User entries
                status: EntryStatus.SETTLED,
            },
            orderBy: { id: 'asc' }
        });

        if (entries.length === 0) break;

        for (const entry of entries) {
            processed++;
            cursor = entry.id;

            const platformRef = `platform:${entry.reference}`;
            const exists = await prisma.ledgerEntry.findFirst({
                where: { reference: platformRef }
            });

            if (exists) continue;

            const isUserCredit = new Decimal(entry.credit).greaterThan(0);
            const isUserDebit = new Decimal(entry.debit).greaterThan(0);

            if (!isUserCredit && !isUserDebit) continue;

            // User Credit = Platform Debit (Liability +)
            // User Debit = Platform Credit (Liability -)
            const platformDebit = isUserCredit ? entry.credit : new Decimal(0);
            const platformCredit = isUserDebit ? entry.debit : new Decimal(0);

            // Get last platform balance
            const lastPlatformEntry = await prisma.ledgerEntry.findFirst({
                where: { userId: PLATFORM_USER_ID, currency: entry.currency },
                orderBy: { createdAt: 'desc' }
            });

            const currentBalance = lastPlatformEntry?.balanceAfter ? new Decimal(lastPlatformEntry.balanceAfter) : new Decimal(0);
            const newBalance = currentBalance.plus(platformCredit).minus(platformDebit);

            await prisma.ledgerEntry.create({
                data: {
                    userId: PLATFORM_USER_ID,
                    currency: entry.currency,
                    type: entry.type,
                    debit: platformDebit,
                    credit: platformCredit,
                    balanceAfter: newBalance,
                    status: EntryStatus.SETTLED,
                    sweepStatus: SweepStatus.NOT_APPLICABLE,
                    holdAmount: new Decimal(0),
                    reference: platformRef,
                    tradeGroupId: entry.tradeGroupId,
                    counterpartyUserId: entry.userId,
                    description: `Backfill: Paired for ${entry.reference}`,
                }
            });
            updated++;
        }
        console.log(`Processed ${processed} entries, Created ${updated} platform entries...`);
    }

    console.log("Backfill complete.");
}

main()
    .catch((e) => console.error(e))
    .finally(async () => await prisma.$disconnect());
