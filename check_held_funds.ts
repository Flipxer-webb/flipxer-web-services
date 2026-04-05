
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

        const heldEntries = await prisma.ledgerEntry.findMany({
            where: {
                userId: 7,
                status: EntryStatus.HOLD,
                holdAmount: {
                    gt: 0,
                },
            },
            select: {
                id: true,
                type: true,
                currency: true,
                holdAmount: true,
            },
        });

        console.log(`Found ${heldEntries.length} held entries for user 7.`);
        // Print as compact JSON lines to avoid huge output
        heldEntries.forEach(entry => {
            console.log(JSON.stringify(entry));
        });

    } catch (error) {
        console.error('Error listing held entries:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();

