
import { PrismaClient, EntryStatus } from '@prisma/client';
import * as fs from 'fs';

const prisma = new PrismaClient({
    log: ['warn', 'error'],
});

async function main() {
    try {
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
        fs.writeFileSync('held_funds_user_7.json', JSON.stringify(heldEntries, null, 2));
        console.log('Written detailed output to held_funds_user_7.json');

    } catch (error) {
        console.error('Error listing held entries:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
