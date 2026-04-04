
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // References from the stuck holds (removing 'swap-sell-hold:' prefix)
    const holdRefs = [
        '14he3745add69462g8b1ddc2h574gg',
        'c1g337ch963g1f3b639190f659dd0a',
        '54b14e02683d737eb0fhe5bh8g31g8'
    ];

    console.log(`Checking Orders for swap refs: ${holdRefs.join(', ')}`);

    // Check Orders
    const orders = await prisma.order.findMany({
        where: {
            OR: [
                { orderReference: { in: holdRefs } },
                { transactionId: { in: holdRefs } }
            ]
        }
    });

    console.log(`Found ${orders.length} orders.`);
    orders.forEach(o => console.log(`Order: ${o.orderReference} Status: ${o.status}`));

    // If no orders, we should release the holds.
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
