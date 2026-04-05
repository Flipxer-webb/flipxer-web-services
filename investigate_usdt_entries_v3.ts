
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({ log: [] });

async function main() {
    try {
        const usdtIds = [
            '155dec80-5abd-4424-832f-6607ebeea5a5',
            'a843aba8-ba91-4e90-ad13-29852cfe442a'
        ];

        // Fetch detailed ledger info safely
        const entries = await prisma.ledgerEntry.findMany({
            where: { id: { in: usdtIds } }
        });

        console.log('--- LEDGER ENTRIES ---');
        console.log(JSON.stringify(entries, null, 2));

        // Manual lookup by reference string
        const refs = entries.map(e => e.reference).filter(r => r && typeof r === 'string');

        if (refs.length > 0) {
            console.log('\n--- LOOKING FOR WITHDRAWAL QUEUES ---');
            const withdrawals = await prisma.withdrawalQueue.findMany({
                where: {
                    reference: { in: refs }
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
