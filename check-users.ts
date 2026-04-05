import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
    const u0 = await prisma.user.findUnique({ where: { id: 0 } });
    const uMinus1 = await prisma.user.findUnique({ where: { id: -1 } });
    console.log('User 0:', u0 ? 'Found' : 'Missing');
    console.log('User -1:', uMinus1 ? 'Found' : 'Missing');
}
main()
    .catch(e => console.error(e))
    .finally(() => prisma.$disconnect());
