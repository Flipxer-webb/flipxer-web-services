
import { PrismaClient, EntryStatus } from '@prisma/client';

const prisma = new PrismaClient({
    log: ['warn', 'error'],
});

async function main() {
    try {
        // Log masked connection string
        const dbUrl = process.env.DATABASE_URL || '';
        const maskedUrl = dbUrl.replace(/:[^:@]+@/, ':***@');
        console.log(`Connecting to database: ${maskedUrl}`);

        const count = await prisma.ledgerEntry.count({
            where: {
                userId: 7,
                status: EntryStatus.HOLD,
                holdAmount: {
                    gt: 0,
                },
            },
        });

        console.log(`HELD_ENTRY_COUNT: ${count}`);
    } catch (error) {
        console.error('Error listing held entries:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();

