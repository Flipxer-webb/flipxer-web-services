const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: 'magpiep18@gmail.com' },
    select: { id: true, email: true, firstName: true, lastName: true, isDocumentVerified: true }
  });
  console.log('User:', JSON.stringify(user, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
