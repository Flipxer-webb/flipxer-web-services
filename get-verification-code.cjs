const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getVerificationCode() {
  try {
    const result = await prisma.accountVerificationRequest.findFirst({
      where: { email: 'doctest@flipxer.com' },
      orderBy: { createdAt: 'desc' }
    });
    console.log('Verification Code:', result ? result.code : 'Not found');
  } catch (e) {
    console.error(e);
  } finally {
    await prisma.$disconnect();
  }
}

getVerificationCode();
