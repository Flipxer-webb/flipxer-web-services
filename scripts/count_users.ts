
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    try {
        const count = await prisma.user.count();
        console.log(`Generic User Count: ${count}`);

        // Also list the first 5 users to see if it's empty or just partial
        const users = await prisma.user.findMany({ take: 5 });
        console.log('First 5 users:', users);
    } catch (error) {
        console.error('Error connecting to database:', error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
