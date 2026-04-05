const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { cryptoSubAccountId: { not: null } },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      cryptoSubAccountId: true,
    },
  });
  console.log('Users with crypto accounts:');
  console.log(JSON.stringify(users, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
