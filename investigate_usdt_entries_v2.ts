
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: ['error'] });

async function main() {
    try {
        const usdtIds = [
            '155dec80-5abd-4424-832f-6607ebeea5a5',
            'a843aba8-ba91-4e90-ad13-29852cfe442a'
        ];

        // Fetch detailed ledger info
        const entries = await prisma.ledgerEntry.findMany({
            where: { id: { in: usdtIds } },
            // Removed 'include' for user to avoid type issues if 'user' relation is complex or named differently
            // Just fetching entries first
        });

        console.log('--- LEDGER ENTRIES ---');
        console.log(JSON.stringify(entries, null, 2));

        const references = entries.map(e => e.reference).filter(r => r);

        if (references.length > 0) {
            console.log('\n--- POTENTIAL RELATED WITHDRAWAL QUEUES (by reference) ---');

            // Try to find WithdrawalQueue items by reference OR transactionId OR ledgerEntryId
            // We use raw query or separate queries to be safe against schema mismatches

            // 1. By Reference
            const byRef = await prisma.withdrawalQueue.findMany({
                where: { reference: { in: references } }
            });
            console.log('By Reference:', JSON.stringify(byRef, null, 2));

            // 2. By LedgerEntryId (if column exists, schema says it does: ledgerEntryId String @unique)
            // But we can check if schema matches. 
            // Let's safe bet on reference first.
        }

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
