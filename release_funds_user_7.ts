
import { PrismaClient, EntryStatus } from '@prisma/client';

const prisma = new PrismaClient({
    log: ['info', 'warn', 'error'],
});

async function main() {
    try {
        // Log masked connection string
        const dbUrl = process.env.DATABASE_URL || '';
        const maskedUrl = dbUrl.replace(/:[^:@]+@/, ':***@');
        console.log(`Connecting to database: ${maskedUrl}`);

        // Update all held entries for user 7 to FAILED (releases funds)
        const result = await prisma.ledgerEntry.updateMany({
            where: {
                userId: 7,
                status: EntryStatus.HOLD,
                holdAmount: {
                    gt: 0,
                },
            },
            data: {
                status: EntryStatus.FAILED,
                holdAmount: 0,
            },
        });

        console.log(`Released funds for ${result.count} entries.`);
    } catch (error) {
        console.error('Error releasing funds:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();

