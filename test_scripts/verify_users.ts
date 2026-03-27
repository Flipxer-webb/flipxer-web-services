import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

const prisma = new PrismaClient();

async function main() {
    try {
        const count = await prisma.user.count();
        const lastUsers = await prisma.user.findMany({
            take: 5,
            orderBy: { createdAt: 'desc' },
            select: { id: true, email: true, createdAt: true }
        });

        // Check first user too to see ID range
        const firstUser = await prisma.user.findFirst({
            orderBy: { id: 'asc' }
        });

        const output = `
Total Users: ${count}
First User ID: ${firstUser?.id} (Created: ${firstUser?.createdAt})
Last 5 Users:
${JSON.stringify(lastUsers, null, 2)}
    `;

        fs.writeFileSync(path.join(__dirname, 'user_stats.txt'), output);
        console.log('Stats written to user_stats.txt');

    } catch (e) {
        fs.writeFileSync(path.join(__dirname, 'user_stats.txt'), `Error: ${e.message}`);
    } finally {
        await prisma.$disconnect();
    }
}

main();
