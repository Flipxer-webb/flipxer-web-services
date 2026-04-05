
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
});

async function main() {
    try {
        // Log masked connection string
        const dbUrl = process.env.DATABASE_URL || '';
        const maskedUrl = dbUrl.replace(/:[^:@]+@/, ':***@');
        console.log(`Connecting to database: ${maskedUrl}`);

        const count = await prisma.user.count();
        console.log(`User count: ${count}`);
    } catch (error) {
        console.error('Error:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();

