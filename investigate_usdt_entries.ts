
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
            include: {
                user: { select: { email: true } },
            }
        });

        console.log('--- LEDGER ENTRIES ---');
        console.log(JSON.stringify(entries, null, 2));

        // Fetch related withdrawals if reference is useful (reference in LedgerEntry is a string)
        const references = entries.map(e => e.reference).filter(Boolean);
        if (references.length > 0) {
            console.log('\n--- POTENTIAL RELATED WITHDRAWAL QUEUES (by reference) ---');
            // Check WithdrawalQueue where reference matches or blockchainTxId matches
            const withdrawals = await prisma.withdrawalQueue.findMany({
                where: {
                    OR: [
                        { reference: { in: references } },
                        { transactionId: { in: references } }, // sometimes ref is txId
                        { ledgerEntryId: { in: usdtIds } } // check explicitly linked
                    ]
                }
            });
            console.log(JSON.stringify(withdrawals, null, 2));
        }

    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
