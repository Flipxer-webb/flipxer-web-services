const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    take: 10,
    select: {
      id: true,
      identifier: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      userType: true,
      tier: true,
      isEmailVerified: true,
      isPhoneVerified: true,
      isBvnVerified: true,
      createdAt: true,
    },
  });

  console.log('=== Test Users ===');
  console.log(JSON.stringify(users, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
