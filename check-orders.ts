
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    // References from ledgers
    // Note: The ledger reference is `swap-sell-hold:REF`. The Order/Swap reference is just `REF`.
    const refs = ['SWAP-7G8F9H0J1K2L', 'SWAP-1A2B3C4D5E6F'];

    console.log(`Checking Order/Swap status for refs: ${refs.join(', ')}`);

    const orders = await prisma.order.findMany({
        where: {
            orderReference: { in: refs }
        }
    });

    console.log('\n--- Orders ---');
    console.table(orders.map(o => ({
        ID: o.id,
        Ref: o.orderReference,
        Status: o.status,
        Streamlined: o.streamlinedStatus,
        Amount: o.amount,
        FiatToReceive: o.totalToReceiveInFiat,
        CreatedAt: o.createdAt
    })));

    // Just in case they are not in Order table but passed as Swap only (though swap usually creates order)
    // You might want to check Swap table if it exists, or logs.
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
