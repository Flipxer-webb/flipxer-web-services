require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'magpiep18@gmail.com' },
    select: { id: true, email: true, isDocumentVerified: true }
  });
  
  console.log('User:', user);
  
  if (user) {
    const doc = await prisma.userDocument.findFirst({
      where: { userId: user.id }
    });
    console.log('Document record:', doc ? 'EXISTS' : 'DELETED (ready for new upload)');
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
