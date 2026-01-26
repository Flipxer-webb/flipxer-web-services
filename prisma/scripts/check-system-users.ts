
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    console.log('Checking for system users...');

    const platformUser = await prisma.user.findUnique({ where: { id: 0 } });
    console.log('Platform User (0):', platformUser ? 'FOUND' : 'MISSING');

    const feeUser = await prisma.user.findUnique({ where: { id: -1 } });
    console.log('Fee User (-1):', feeUser ? 'FOUND' : 'MISSING');

    const user7 = await prisma.user.findUnique({ where: { id: 7 } });
    console.log('User 7:', user7 ? 'FOUND' : 'MISSING');

    if (!platformUser || !feeUser || !user7) {
        console.log('\nCRITICAL: One or more key users are missing.');
    }
}

main()
    .catch(e => {
        console.error(e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
