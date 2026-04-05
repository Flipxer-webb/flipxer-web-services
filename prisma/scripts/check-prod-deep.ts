
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('--- Deep Check Start ---');
    // Print masked DB URL to confirm which DB we are talking to
    const url = process.env.DATABASE_URL || 'UNDEFINED';
    const maskedUrl = url.replace(/:[^:@]+@/, ':****@');
    console.log(`Connecting to: ${maskedUrl}`);

    const user0 = await prisma.user.findUnique({ where: { id: 0 } });
    console.log(`User 0 (Platform): ${user0 ? 'EXISTS' : 'MISSING'}`);

    const userNeg1 = await prisma.user.findUnique({ where: { id: -1 } });
    console.log(`User -1 (Fee): ${userNeg1 ? 'EXISTS' : 'MISSING'}`);

    const user7 = await prisma.user.findUnique({ where: { id: 7 } });
    console.log(`User 7         : ${user7 ? 'EXISTS' : 'MISSING'}`);

    if (user7) {
        console.log(`User 7 Email: ${user7.email}`);
    }

    console.log('--- Deep Check End ---');
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
