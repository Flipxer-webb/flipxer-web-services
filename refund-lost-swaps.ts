
import { PrismaClient, LedgerType, EntryStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // 1. Find User
    const email = 'magpiep18@gmail.com';
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error('User not found');

    const amount1 = 98.0;
    const ref1 = 'SWAP-7G8F9H0J1K2L';

    const amount2 = 200.0;
    const ref2 = 'SWAP-1A2B3C4D5E6F';

    console.log(`Refunding ${amount1} and ${amount2} to user ${user.id}...`);

    // 2. Create Refunds
    await prisma.$transaction(async (tx) => {
        // --- Refund 1 ---
        const last1 = await tx.ledgerEntry.findFirst({
            where: { userId: user.id, currency: 'USDT' },
            orderBy: { createdAt: 'desc' }
        });
        const bal1 = last1 ? Number(last1.balanceAfter) : 0;
        const newBal1 = bal1 + amount1;

        await tx.ledgerEntry.create({
            data: {
                userId: user.id,
                currency: 'USDT',
                type: LedgerType.REFUND,
                debit: 0,
                credit: amount1,
                balanceAfter: newBal1,
                status: EntryStatus.SETTLED,
                reference: `refund:${ref1}`,
                description: `Refund for failed swap ${ref1}`
            }
        });

        // --- Refund 2 ---
        const last2 = await tx.ledgerEntry.findFirst({
            where: { userId: user.id, currency: 'USDT' },
            orderBy: { createdAt: 'desc' }
        });
        const bal2 = last2 ? Number(last2.balanceAfter) : 0;
        const newBal2 = bal2 + amount2;

        await tx.ledgerEntry.create({
            data: {
                userId: user.id,
                currency: 'USDT',
                type: LedgerType.REFUND,
                debit: 0,
                credit: amount2,
                balanceAfter: newBal2,
                status: EntryStatus.SETTLED,
                reference: `refund:${ref2}`,
                description: `Refund for failed swap ${ref2}`
            }
        });
    });

    console.log('Refunds completed.');
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
