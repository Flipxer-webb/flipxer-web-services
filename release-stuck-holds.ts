
import { PrismaClient, EntryStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // References of the stuck holds (ledger references start with swap-sell-hold:)
    const ledgerRefs = [
        'swap-sell-hold:14he3745add69462g8b1ddc2h574gg',
        'swap-sell-hold:c1g337ch963g1f3b639190f659dd0a',
        'swap-sell-hold:54b14e02683d737eb0fhe5bh8g31g8'
    ];

    console.log(`Releasing holds for: ${ledgerRefs.join(', ')}`);

    const result = await prisma.ledgerEntry.updateMany({
        where: {
            reference: { in: ledgerRefs },
            status: EntryStatus.HOLD
        },
        data: {
            status: EntryStatus.CANCELLED,
            holdAmount: 0,
            description: 'Released stuck hold manually via script',
            updatedAt: new Date()
        }
    });

    console.log(`Released ${result.count} holds.`);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
